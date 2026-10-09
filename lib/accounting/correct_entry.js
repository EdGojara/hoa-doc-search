// ============================================================================
// lib/accounting/correct_entry.js
// ----------------------------------------------------------------------------
// A POSTED journal entry is permanent. Its lines are never deleted or
// rewritten by an application workflow, in an open period or a closed one
// (Ed 2026-10-09). A posted entry that is wrong is corrected by an explicit
// correcting entry: a reversal of the live entry (posting.js voidJournalEntry,
// linked by reverses_je_id), plus a replacement when the workflow re-posts.
// The link (invoice, original entry, corrected entry, correcting entry,
// replacement, actor, time, reason) is recorded as DATA in
// journal_entry_corrections (migration 503), never only in a memo.
//
// THE SCAR (2026-09-28/29, Lakes of Pine Forest). Re-coding four unpaid
// Barker Cypress MUD bills ran "delete lines; delete header" inside a
// try/catch. supabase-js returns { error } and never throws: the lines went,
// the header delete was refused by the FK from the conversion neutralization
// (CONV-LPF-20260731-NEUT-*.reverses_je_id), nobody saw it, and the bills were
// re-posted. JE-2026-00169..00172 have had no lines since.
//
// voidLiveEntry() decides WHICH entry comes off the books, by reversal only:
//   1. already voided                      -> nothing to reverse
//   2. the entry is itself a reversal      -> refused
//   3. fully reversed by another entry (a conversion NEUT) -> never reversed a
//      second time. If the conversion re-posted it (CONV-*-REPOST-*), the
//      re-post is the live entry and is reversed instead.
//      A partial reversal is refused.
//   4. otherwise                           -> reversed. For an uncommitted
//      (unpaid) bill whose entry sits in an open, post-cutover period the
//      reversal is dated the entry's own date, so that month carries the bill
//      once; otherwise it is dated today (voidJournalEntry's default).
// Every failure throws an Error with .code and a staff-safe .detail (also
// .userMessage, which safeErrorMessage shows as-is). Callers stop on a throw.
// ============================================================================

const OPEN = ['open', 'reopened'];
const CONV_NEUT = /^CONV-.*-NEUT-/;
const CONV_REPOST = /^CONV-.*-REPOST-/;
const KINDS = ['ap_recode', 'ap_line_recode', 'ap_hold_prior_periods'];

function fail(code, detail, extra) {
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
 * Take a posted entry's effect off the books by reversal. Never deletes.
 * @returns {Promise<{mode:'voided'|'already_voided'|'already_reversed', reference, corrected_je_id?, reversal_je_id?, reversal_reference?, note?}>}
 */
async function voidLiveEntry(o) {
  const { supabase, journal_entry_id, void_reason, uncommitted = false, posted_by_user_id } = o || {};
  if (!supabase) throw fail('supabase_required', 'Internal error: no database client.');
  if (!journal_entry_id) throw fail('journal_entry_id_required', 'Internal error: no journal entry given.');
  if (!void_reason) throw fail('void_reason_required', 'Internal error: a correction needs a reason. Nothing was changed.');
  const voidJE = o.voidJournalEntry || require('./posting').voidJournalEntry;

  const { data: je, error: jeErr } = await supabase.from('journal_entries')
    .select('id, community_id, period_id, reference, posting_date, status, reverses_je_id, total_debits_cents')
    .eq('id', journal_entry_id).maybeSingle();
  if (jeErr) throw fail('entry_lookup_failed', `Could not read the posted entry (${jeErr.message}). Nothing was changed.`);
  if (!je) throw fail('entry_not_found', 'The posted entry this bill points at could not be found. Nothing was changed.');
  const ref = je.reference;

  if (je.status === 'voided') return { mode: 'already_voided', reference: ref, corrected_je_id: je.id };
  if (je.reverses_je_id) {
    throw fail('entry_is_a_reversal', `${ref} is itself a reversal of another entry. Reversing it would bring that entry back onto the books, so nothing was changed.`);
  }

  const reversals = (await findReversals(supabase, je.id)).filter((r) => r.status === 'posted');
  if (reversals.length) {
    const reversed = reversals.reduce((t, r) => t + Number(r.total_debits_cents || 0), 0);
    const names = reversals.map((r) => r.reference).join(', ');
    if (reversed !== Number(je.total_debits_cents || 0)) {
      throw fail('entry_partially_reversed', `${ref} is partly reversed by ${names}; what remains of it can't be determined safely. Nothing was changed.`);
    }
    // A conversion that neutralized an entry may also have re-posted it on the
    // cutover date; then the re-post is the live entry. (Same rule as
    // lib/accounting/ap_as_of.js uses for an invoice's effective date.)
    if (reversals.some((r) => CONV_NEUT.test(r.reference || ''))) {
      const { data: reposts, error: rpErr } = await supabase.from('journal_entries')
        .select('id, reference, status').eq('source_reference', je.id);
      if (rpErr) throw fail('repost_lookup_failed', `Could not check for a conversion re-post of ${ref} (${rpErr.message}). Nothing was changed.`);
      const live = (reposts || []).filter((r) => CONV_REPOST.test(r.reference || '') && r.status !== 'voided');
      if (live.length > 1) throw fail('entry_reposted_twice', `${ref} has more than one conversion re-post (${live.map((r) => r.reference).join(', ')}). Nothing was changed.`);
      if (live.length === 1) {
        const out = await voidLiveEntry({ ...o, journal_entry_id: live[0].id });
        return { ...out, note: `${ref} was neutralized by ${names} and re-posted as ${live[0].reference}; the re-post was reversed.` };
      }
    }
    return { mode: 'already_reversed', reference: ref, corrected_je_id: je.id, reversal_reference: names, note: `${ref} was already reversed by ${names}; left as it is.` };
  }

  // Same-date reversal only for an uncommitted bill in an open, post-cutover period.
  const { data: period, error: pErr } = await supabase.from('accounting_periods')
    .select('id, status').eq('id', je.period_id).maybeSingle();
  if (pErr) throw fail('period_lookup_failed', `Could not read the accounting period of ${ref} (${pErr.message}). Nothing was changed.`);
  const { getGlCutoverDate } = require('./cutover');
  let cutover;
  try { cutover = await getGlCutoverDate(supabase, je.community_id); }
  catch (e) { throw fail('cutover_lookup_failed', `Could not read the community's GL cutover date (${e.message}). Nothing was changed.`); }
  const postingDay = String(je.posting_date).slice(0, 10);
  const sameDay = uncommitted && !!period && OPEN.includes(period.status) && !(cutover && postingDay < cutover);

  let out;
  try { out = await voidJE({ journal_entry_id: je.id, void_reason, posted_by_user_id, reversal_date: sameDay ? postingDay : undefined }); }
  catch (e) { throw fail('reversal_failed', `Could not reverse ${ref} (${e.message}). Nothing was changed.`); }
  const rev = (out && out.reversal_entry) || {};
  return { mode: 'voided', reference: ref, corrected_je_id: je.id, reversal_je_id: rev.id || null, reversal_reference: rev.reference || null };
}

// The correction log must be writable BEFORE anything posts; otherwise a
// correction would land on the books with no record of who and why.
async function assertCorrectionLogReady(supabase) {
  const { error } = await supabase.from('journal_entry_corrections').select('id').limit(1);
  if (error) {
    throw fail('correction_log_unavailable', `Changing a posted entry needs the correction log (migration 503), which is not available (${error.message}). Nothing was changed.`);
  }
}

/**
 * Record the link as data. Append-only (migration 503 refuses UPDATE/DELETE).
 * Returns null on success, or a staff-safe warning string when the entries
 * posted but the link could not be written (logged CRITICAL with every id).
 */
async function recordCorrection(supabase, r) {
  if (!KINDS.includes(r.kind)) throw fail('invalid_correction_kind', `Internal error: unknown correction kind ${r.kind}.`);
  const row = {
    community_id: r.community_id,
    invoice_id: r.invoice_id || null,
    original_je_id: r.original_je_id,
    corrected_je_id: r.corrected_je_id || r.original_je_id,
    correcting_je_id: r.correcting_je_id || null,
    replacement_je_id: r.replacement_je_id || null,
    kind: r.kind,
    actor_user_id: r.actor_user_id || null,
    actor_name: r.actor_name || 'Staff',
    reason: String(r.reason || '').slice(0, 2000),
  };
  const { error } = await supabase.from('journal_entry_corrections').insert(row);
  if (!error) return null;
  console.error('[correct_entry] CRITICAL: correction posted but its link could not be recorded:', JSON.stringify(row), error.message);
  return 'The correction posted, but its audit link (who, why, which entries) could not be saved. Tell Ed; the details are in the server log.';
}

// Plain-English sentence for the invoice's audit trail.
function describeCorrection(v, replacementRef) {
  if (!v) return '';
  const what = v.mode === 'voided'
    ? `${v.reference} reversed by ${v.reversal_reference || 'a reversal'}`
    : v.mode === 'already_reversed' ? `${v.reference} was already reversed by ${v.reversal_reference}` : `${v.reference} was already voided`;
  return `Original entry kept; ${what}${replacementRef ? `; replacement ${replacementRef} posted` : ''}.`;
}

module.exports = { voidLiveEntry, findReversals, assertCorrectionLogReady, recordCorrection, describeCorrection, CORRECTION_KINDS: KINDS };
