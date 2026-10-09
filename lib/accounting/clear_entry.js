// ============================================================================
// lib/accounting/clear_entry.js
// ----------------------------------------------------------------------------
// The ONE sanctioned way to take a posted journal entry off the books so a
// replacement can be posted (AP re-code, line re-code, prior-period hold,
// late-fee run reversal). Every caller used to hand-roll:
//
//     try { delete lines; delete header } catch { refuse }
//
// THE SCAR (2026-09-28/29, Lakes of Pine Forest). supabase-js does not throw:
// it returns { error }. So the try/catch caught nothing. The unpaid-bill
// re-code deleted the lines of JE-2026-00169..00172, the header delete was then
// refused by the foreign key from the conversion neutralization
// (CONV-LPF-20260731-NEUT-*.reverses_je_id), the error was dropped, and the
// bills were re-posted. Result: four posted headers with no lines, their NEUT
// reversals still counting, July expense understated by $3,409.50 and a stray
// debit in AP 2000. Nothing told anyone.
//
// The rules this module enforces, in order:
//   1. Already voided            -> nothing to clear ('already_voided').
//   2. The entry IS a reversal   -> refuse. Deleting or voiding a reversal
//                                   would silently revive what it reversed.
//   3. Fully reversed by another entry (a conversion NEUT, or any posted
//      reversal whose totals equal it) -> it already nets to zero on the books.
//      Never delete it (the reversal points at it) and never void it (that
//      would reverse it a SECOND time). If the conversion also RE-POSTED it on
//      the cutover date (CONV-*-REPOST-*), that re-post is the live accrual and
//      is cleared instead, by these same rules. Otherwise nothing to clear
//      ('already_reversed'). A partial reversal is refused.
//   4. Its period is not open, it is dated before the community's GL cutover
//      (converted, certified books), or the conversion wrote it (CONV-*) ->
//      void by reversal (posting.js voidJournalEntry), never delete. For an
//      unpaid bill in an open post-cutover period the reversal is dated the
//      entry's own date, so the month carries the bill once; otherwise today.
//   5. Otherwise, and only when the caller allows it (unpaid system coding),
//      delete it: snapshot the lines, delete lines, delete header, every step
//      error-checked. If the header delete fails the lines are put back from
//      the snapshot, then the entry is voided by reversal instead (it is
//      referenced by something we did not foresee). If the lines cannot be put
//      back, stop with a loud error naming the entry and log the snapshot.
//
// Every failure throws an Error with .code and a plain-English .detail that is
// safe to show staff. A caller must stop (never re-post) when this throws.
// ============================================================================

const OPEN = ['open', 'reopened'];
const CONV_NEUT = /^CONV-.*-NEUT-/;
const CONV_REPOST = /^CONV-.*-REPOST-/;

function fail(code, detail, extra) {
  // userMessage: safeErrorMessage() shows it as-is, so any route that catches
  // this gives staff the plain-English detail, not the code.
  return Object.assign(new Error(code), { code, detail, userMessage: detail }, extra || {});
}

// Posted entries whose reverses_je_id points at this one.
async function findReversals(supabase, journalEntryId) {
  const { data, error } = await supabase.from('journal_entries')
    .select('id, reference, status, total_debits_cents')
    .eq('reverses_je_id', journalEntryId);
  if (error) throw fail('reversal_lookup_failed', `Could not check whether this entry was already reversed (${error.message}). Nothing was changed.`);
  return data || [];
}

/**
 * Take a posted entry off the books.
 *
 * @param {object}   o
 * @param {object}   o.supabase
 * @param {string}   o.journal_entry_id
 * @param {string}   o.void_reason         used if the entry has to be voided
 * @param {boolean}  [o.allow_delete=false] true only for entries that are the
 *                                         system's own uncommitted coding
 * @param {string}   [o.posted_by_user_id]
 * @param {Function} [o.voidJournalEntry]  injectable for tests
 * @returns {Promise<{mode:'deleted'|'voided'|'already_voided'|'already_reversed', reference:string, reversal_reference?:string, note?:string}>}
 */
async function clearPostedEntry(o) {
  const { supabase, journal_entry_id, void_reason, allow_delete = false, posted_by_user_id } = o || {};
  if (!supabase) throw fail('supabase_required', 'Internal error: no database client.');
  if (!journal_entry_id) throw fail('journal_entry_id_required', 'Internal error: no journal entry given.');
  const voidJE = o.voidJournalEntry || require('./posting').voidJournalEntry;

  const { data: je, error: jeErr } = await supabase.from('journal_entries')
    .select('id, community_id, period_id, reference, posting_date, status, reverses_je_id, total_debits_cents')
    .eq('id', journal_entry_id).maybeSingle();
  if (jeErr) throw fail('entry_lookup_failed', `Could not read the posted entry (${jeErr.message}). Nothing was changed.`);
  if (!je) throw fail('entry_not_found', 'The posted entry this bill points at could not be found. Nothing was changed.');
  const ref = je.reference;

  // 1. Already off the books.
  if (je.status === 'voided') return { mode: 'already_voided', reference: ref };

  // 2. A reversal is never cleared by this path.
  if (je.reverses_je_id) {
    throw fail('entry_is_a_reversal', `${ref} is itself a reversal of another entry. Removing it would bring the reversed entry back onto the books, so nothing was changed.`);
  }

  // 3. Already reversed by another entry (conversion neutralization etc.).
  const reversals = (await findReversals(supabase, je.id)).filter((r) => r.status === 'posted');
  if (reversals.length) {
    const reversed = reversals.reduce((t, r) => t + Number(r.total_debits_cents || 0), 0);
    const names = reversals.map((r) => r.reference).join(', ');
    if (reversed !== Number(je.total_debits_cents || 0)) {
      throw fail('entry_partially_reversed', `${ref} is partly reversed by ${names}; what remains of it can't be determined safely. Nothing was changed.`);
    }
    // A conversion that neutralized an entry may also have re-posted it on the
    // cutover date (CONV-*-REPOST-*, source_reference = this entry). Then the
    // RE-POST is the live accrual and is what must come off the books.
    // (Same rule lib/accounting/ap_as_of.js uses for an invoice's effective date.)
    if (reversals.some((r) => CONV_NEUT.test(r.reference || ''))) {
      const { data: reposts, error: rpErr } = await supabase.from('journal_entries')
        .select('id, reference, status').eq('source_reference', je.id);
      if (rpErr) throw fail('repost_lookup_failed', `Could not check for a conversion re-post of ${ref} (${rpErr.message}). Nothing was changed.`);
      const live = (reposts || []).filter((r) => CONV_REPOST.test(r.reference || '') && r.status !== 'voided');
      if (live.length > 1) throw fail('entry_reposted_twice', `${ref} has more than one conversion re-post (${live.map((r) => r.reference).join(', ')}). Nothing was changed.`);
      if (live.length === 1) {
        const out = await clearPostedEntry({ ...o, journal_entry_id: live[0].id });
        return { ...out, note: `${ref} was neutralized by ${names} and re-posted as ${live[0].reference}; ${out.note || out.mode}` };
      }
    }
    return { mode: 'already_reversed', reference: ref, reversal_reference: names, note: `${ref} was already reversed by ${names}; left in place.` };
  }

  // 4. Closed period or converted (pre-cutover) books -> reversal, never delete.
  const { data: period, error: pErr } = await supabase.from('accounting_periods')
    .select('id, status').eq('id', je.period_id).maybeSingle();
  if (pErr) throw fail('period_lookup_failed', `Could not read the accounting period of ${ref} (${pErr.message}). Nothing was changed.`);
  const { getGlCutoverDate } = require('./cutover');
  let cutover;
  try { cutover = await getGlCutoverDate(supabase, je.community_id); }
  catch (e) { throw fail('cutover_lookup_failed', `Could not read the community's GL cutover date (${e.message}). Nothing was changed.`); }
  const periodOpen = !!period && OPEN.includes(period.status);
  const postingDay = String(je.posting_date).slice(0, 10);
  const preCutover = !!cutover && postingDay < cutover;
  // An uncommitted (unpaid) coding being replaced inside an open, post-cutover
  // period is reversed ON ITS OWN DATE, so the month shows the bill once.
  // Otherwise the reversal lands today (voidJournalEntry's default), as before.
  const reversalDate = allow_delete && periodOpen && !preCutover ? postingDay : undefined;

  const voidIt = async (why) => {
    if (!void_reason) throw fail('void_reason_required', `Internal error: ${ref} must be voided but no reason was given. Nothing was changed.`);
    let out;
    try { out = await voidJE({ journal_entry_id: je.id, void_reason, posted_by_user_id, reversal_date: reversalDate }); }
    catch (e) { throw fail('reversal_failed', `Could not reverse ${ref} (${e.message}). Nothing was changed.`); }
    return { mode: 'voided', reference: ref, reversal_reference: out && out.reversal_entry && out.reversal_entry.reference, note: why };
  };

  if (!periodOpen) return voidIt(`${ref} is in a period that is not open; voided by reversal.`);
  if (preCutover) return voidIt(`${ref} is dated before the GL cutover (${cutover}); voided by reversal.`);
  // A conversion wrote it: part of the conversion's record, never deleted.
  if (/^CONV-/.test(ref || '')) return voidIt(`${ref} was written by the conversion; voided by reversal.`);
  if (!allow_delete) return voidIt(`${ref} voided by reversal.`);

  // 5. Delete, never half-done.
  const { data: snapshot, error: sErr } = await supabase.from('journal_entry_lines')
    .select('*').eq('journal_entry_id', je.id).order('line_number');
  if (sErr) throw fail('lines_read_failed', `Could not read the lines of ${ref} (${sErr.message}). Nothing was changed.`);

  // One DELETE statement is atomic in Postgres: on error, no line is gone.
  const { data: delLines, error: dlErr } = await supabase.from('journal_entry_lines')
    .delete().eq('journal_entry_id', je.id).select('id');
  if (dlErr) throw fail('lines_delete_failed', `Could not remove the lines of ${ref} (${dlErr.message}). Nothing was changed.`);

  const restore = async (cause) => {
    if (!(delLines || []).length) return;   // nothing was removed
    const { error: rErr } = await supabase.from('journal_entry_lines').insert(snapshot);
    if (rErr) {
      console.error(`[clear_entry] CRITICAL: ${ref} lost its lines and they could not be restored. Snapshot follows.`, JSON.stringify(snapshot), rErr.message);
      throw fail('lines_restore_failed', `${ref}: its lines were removed but the entry could not be removed (${cause}), and putting the lines back failed (${rErr.message}). The books are out of balance for this entry. Stop and tell Ed; the original lines are in the server log.`, { snapshot });
    }
  };

  if ((delLines || []).length !== (snapshot || []).length) {
    await restore('line count changed while removing');
    throw fail('lines_changed_during_delete', `The lines of ${ref} changed while it was being removed; it was left as it was. Try again.`);
  }

  const { data: delHdr, error: dhErr } = await supabase.from('journal_entries')
    .delete().eq('id', je.id).select('id');
  if (dhErr || !(delHdr || []).length) {
    const cause = dhErr ? dhErr.message : 'no row removed';
    await restore(cause);
    console.warn(`[clear_entry] ${ref} could not be deleted (${cause}); lines restored, voiding by reversal instead.`);
    return voidIt(`${ref} is referenced elsewhere (${cause}); voided by reversal instead of deleted.`);
  }
  return { mode: 'deleted', reference: ref };
}

// Plain-English sentence for the audit trail.
function describeClear(r) {
  if (!r) return '';
  switch (r.mode) {
    case 'deleted': return `Mis-coded accrual ${r.reference} removed (not yet a committed cash transaction).`;
    case 'voided': return `Prior accrual ${r.reference} voided by reversal${r.reversal_reference ? ' ' + r.reversal_reference : ''}.`;
    case 'already_reversed': return `Prior accrual ${r.reference} was already reversed by ${r.reversal_reference}; left in place.`;
    case 'already_voided': return `Prior accrual ${r.reference} was already voided.`;
    default: return '';
  }
}

module.exports = { clearPostedEntry, findReversals, describeClear };
