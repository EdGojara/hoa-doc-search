// ============================================================================
// lib/accounting/void_entry.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// The OWNER's "Void entry" action on a posted journal entry (Accounting >
// Setup > Journal Entries > entry > Void entry). A void never deletes: it posts
// a reversal (every line flipped) dated in an open month and marks the
// original voided (posting.js voidJournalEntry), then records the correction
// in journal_entry_corrections (kind 'void', migration 530) with the actor
// and the written reason.
//
// planVoid()  reads only. It is the preview the owner confirms: the reversal
//             lines, accounts, amounts, date, and each account's balance
//             before and after. Every refusal the void would hit is raised
//             here, before anything posts.
// voidAsOwner() re-plans (nothing stale), confirms the corrections trail can
//             take the record, posts the void, records it.
//
// Why it exists: the Lakes of Pine Forest repair (void CONV-LPF-20260731-NEUT-
// JE-2026-00169..00172 dated 7/28 and -REPOST- dated 8/1) and the duplicate-
// payment cleanup are corrections Ed makes himself, signed in, one at a time.
// Chat authorization is not app approval: the actor is always the signed-in
// owner from the session, never an id in the request (api/books.js).
//
// Every refusal throws an Error with .code, .status and a plain .detail
// (also .userMessage, which safeErrorMessage shows as-is).
// ============================================================================
const { fetchAll } = require('../db/fetch_all');

const OPEN = ['open', 'reopened'];

function fail(code, detail, status = 409) {
  return Object.assign(new Error(code), { code, detail, userMessage: detail, status });
}

// 'YYYY-MM-DD' that is a real calendar date.
function isCalendarDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const money = (c) => { const n = Number(c) || 0; const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${s})` : `$${s}`; };

/**
 * Everything the void would post, and every reason it would be refused.
 * @returns {Promise<{entry, reversal_date, period, lines, totals, balances}>}
 */
async function planVoid({ supabase, journal_entry_id, reversal_date }) {
  if (!supabase) throw fail('supabase_required', 'Internal error: no database client.', 500);
  if (!journal_entry_id) throw fail('journal_entry_id_required', 'Pick the entry to void.', 400);
  const posting = require('./posting');

  const { data: je, error: jeErr } = await supabase.from('journal_entries')
    .select('id, community_id, period_id, reference, posting_date, description, status, source_module, reverses_je_id, void_reversal_je_id, voided_at, total_debits_cents, total_credits_cents')
    .eq('id', journal_entry_id).maybeSingle();
  if (jeErr) throw fail('entry_lookup_failed', `Could not read the entry (${jeErr.message}). Nothing was changed.`, 500);
  if (!je) throw fail('not_found', 'That journal entry was not found. Nothing was changed.', 404);
  const ref = je.reference || 'This entry';
  const postedOn = String(je.posting_date || '').slice(0, 10);

  if (je.status === 'voided') {
    throw fail('already_voided', `${ref} is already voided${je.voided_at ? ` (${String(je.voided_at).slice(0, 10)})` : ''}. A void is final. Nothing was changed.`);
  }
  if (je.status !== 'posted') {
    throw fail('not_posted', `${ref} is ${je.status || 'not posted'}, not posted. Only a posted entry can be voided. Nothing was changed.`);
  }

  // A void reversal is undone by nothing: voiding it would put the voided entry back on the books.
  const { data: voidedBy, error: vbErr } = await supabase.from('journal_entries')
    .select('id, reference').eq('void_reversal_je_id', je.id).limit(1);
  if (vbErr) throw fail('entry_lookup_failed', `Could not check whether ${ref} is a void reversal (${vbErr.message}). Nothing was changed.`, 500);
  if (voidedBy && voidedBy.length) {
    throw fail('is_void_reversal', `${ref} is the reversal that voided ${voidedBy[0].reference}. A void is final; post a new entry instead. Nothing was changed.`);
  }

  // Already reversed by another live entry (a conversion NEUT, an AP correction): a void would reverse it twice.
  const { data: revs, error: rvErr } = await supabase.from('journal_entries')
    .select('id, reference, posting_date, status').eq('reverses_je_id', je.id).eq('status', 'posted').limit(5);
  if (rvErr) throw fail('entry_lookup_failed', `Could not check whether ${ref} was already reversed (${rvErr.message}). Nothing was changed.`, 500);
  if (revs && revs.length) {
    throw fail('already_reversed', `${ref} was already reversed by ${revs.map((r) => `${r.reference} (${String(r.posting_date).slice(0, 10)})`).join(', ')}. Voiding it would take it off the books a second time. Nothing was changed.`);
  }

  // trustEd keeps this association's books (former clients, books kept elsewhere: refused).
  await require('./ownership').assertFinancialsEnabled(supabase, je.community_id, 'Voiding a journal entry');

  const lines = await fetchAll(supabase, 'journal_entry_lines', {
    select: 'id, line_number, account_id, fund_id, debit_cents, credit_cents, memo',
    filters: { journal_entry_id: je.id }, orderBy: 'line_number',
  });
  if (!lines.length) {
    throw fail('no_lines', `${ref} has no lines, so there is nothing to reverse. Nothing was changed.`);
  }

  // ---- reversal date: defaults to the original's posting date; must be in an open month ----
  const revDate = reversal_date == null || reversal_date === '' ? postedOn : String(reversal_date).trim();
  if (!isCalendarDate(revDate)) {
    throw fail('invalid_reversal_date', `The reversal date "${revDate}" is not a date (use YYYY-MM-DD). Nothing was changed.`, 400);
  }
  if (postedOn && revDate < postedOn) {
    throw fail('reversal_before_original', `The reversal date ${revDate} is before ${ref} itself (${postedOn}). Date the reversal on or after the original. Nothing was changed.`, 400);
  }
  const period = await posting.resolveOpenPeriod(je.community_id, revDate);
  if (!period) {
    throw fail('period_closed', `No open period covers ${revDate}. Reopen that month, or pick a reversal date in an open month. Nothing was changed.`);
  }
  const closedThrough = await posting.closedThroughDate(je.community_id);
  if (closedThrough && revDate <= closedThrough) {
    throw fail('period_closed', `The books are closed through ${closedThrough}, so a reversal dated ${revDate} cannot post. Reopen that month, or pick a date after ${closedThrough}. Nothing was changed.`);
  }

  // ---- the reversal, with account names ----
  const accountIds = [...new Set(lines.map((l) => l.account_id))];
  const { data: accts, error: acErr } = await supabase.from('chart_of_accounts')
    .select('id, account_number, account_name, normal_balance').in('id', accountIds);
  if (acErr) throw fail('account_lookup_failed', `Could not read the accounts on ${ref} (${acErr.message}). Nothing was changed.`, 500);
  const acctById = new Map((accts || []).map((a) => [a.id, a]));
  const revLines = lines.map((l) => {
    const a = acctById.get(l.account_id) || {};
    return {
      account_id: l.account_id, account_number: a.account_number || null, account_name: a.account_name || null,
      debit_cents: Number(l.credit_cents) || 0, credit_cents: Number(l.debit_cents) || 0, memo: l.memo || null,
    };
  });
  const totals = revLines.reduce((t, l) => ({ debit_cents: t.debit_cents + l.debit_cents, credit_cents: t.credit_cents + l.credit_cents }), { debit_cents: 0, credit_cents: 0 });

  // ---- dry-run balances (cheap: one view read for the accounts on this entry) ----
  // Current balance across all dates, then after the reversal posts. Natural sign:
  // a debit-normal account shows debits minus credits, a credit-normal one the reverse.
  let balances = null;
  let balances_note = null;
  const { data: tb, error: tbErr } = await supabase.from('v_trial_balance')
    .select('account_id, natural_balance_cents').eq('community_id', je.community_id).in('account_id', accountIds);
  if (tbErr) {
    balances_note = `Balances could not be read (${tbErr.message}); the void itself is unaffected.`;
    console.warn('[void_entry] balance preview failed:', je.id, tbErr.message);
  } else {
    const before = new Map();
    for (const r of tb || []) before.set(r.account_id, (before.get(r.account_id) || 0) + (Number(r.natural_balance_cents) || 0));
    balances = accountIds.map((id) => {
      const a = acctById.get(id) || {};
      const net = revLines.filter((l) => l.account_id === id).reduce((s, l) => s + l.debit_cents - l.credit_cents, 0);
      const change = a.normal_balance === 'credit' ? -net : net;
      const b = before.get(id) || 0;
      return { account_id: id, account_number: a.account_number || null, account_name: a.account_name || null, normal_balance: a.normal_balance || null, before_cents: b, change_cents: change, after_cents: b + change };
    }).sort((x, y) => String(x.account_number).localeCompare(String(y.account_number)));
  }

  return {
    entry: { id: je.id, community_id: je.community_id, reference: je.reference, posting_date: postedOn, description: je.description, source_module: je.source_module, total_debits_cents: je.total_debits_cents },
    reversal_date: revDate,
    period: { id: period.id, fiscal_year: period.fiscal_year, period_number: period.period_number, period_start: period.period_start, period_end: period.period_end, status: period.status },
    lines: revLines, totals, balances, balances_note,
  };
}

/**
 * Post the owner's void and record it. `actor` comes from the authenticated
 * session ({ id, name }); nothing here reads a user id from the request.
 */
async function voidAsOwner({ supabase, journal_entry_id, reversal_date, void_reason, actor }) {
  const reason = String(void_reason == null ? '' : void_reason).trim();
  if (!reason) throw fail('void_reason_required', 'Write the reason for this void. It is kept with the entry and in the corrections record. Nothing was changed.', 400);
  if (reason.length > 1000) throw fail('void_reason_too_long', 'Keep the reason under 1,000 characters. Nothing was changed.', 400);
  if (!actor || !actor.id || !String(actor.name || '').trim()) throw fail('actor_required', 'Internal error: the void has no signed-in owner. Nothing was changed.', 500);

  const plan = await planVoid({ supabase, journal_entry_id, reversal_date });

  // The corrections trail must accept the record BEFORE anything posts (migration 530).
  const { error: readyErr } = await supabase.rpc('journal_entry_void_audit_ready');
  if (readyErr) {
    const missing = readyErr.code === 'PGRST202' || readyErr.code === '42883';
    throw fail('audit_not_ready', missing
      ? 'Voids are recorded in the corrections trail, which needs migration 530 (journal_entry_void_corrections). Apply it, then void. Nothing was changed.'
      : `Could not confirm the corrections trail is ready (${readyErr.message}). Nothing was changed.`, 503);
  }

  const { voidJournalEntry } = require('./posting');
  let result;
  try {
    result = await voidJournalEntry({
      journal_entry_id: plan.entry.id, void_reason: reason, reversal_date: plan.reversal_date, posted_by_user_id: actor.id,
    });
  } catch (err) {
    // voidJournalEntry posts the reversal, then flips the original. If the flip was
    // refused, the reversal is on the books: never report that as "nothing changed".
    const { data: stray } = await supabase.from('journal_entries')
      .select('id, reference, posting_date').eq('reverses_je_id', plan.entry.id).eq('source_module', 'reversal').eq('status', 'posted')
      .eq('posted_by_user_id', actor.id).eq('posting_date', plan.reversal_date).limit(1);
    if (stray && stray.length) {
      console.error('[void_entry] CRITICAL: reversal posted but the original was not marked voided:', plan.entry.reference, stray[0].reference, err.message);
      throw fail('void_incomplete', `Reversal ${stray[0].reference} posted ${plan.reversal_date}, but ${plan.entry.reference} could not be marked voided (${err.message}). Both are on the books now; do not void again. Record it before anything else.`, 500);
    }
    throw err;
  }
  const reversal = result.reversal_entry;

  const { data: correction, error: corrErr } = await supabase.from('journal_entry_corrections').insert({
    community_id: plan.entry.community_id, invoice_id: null,
    original_je_id: plan.entry.id, corrected_je_id: plan.entry.id, correcting_je_id: reversal.id, replacement_je_id: null,
    kind: 'void', actor_user_id: actor.id, actor_name: String(actor.name).trim(), reason,
  }).select('id, created_at').single();
  if (corrErr) {
    // The void posted and is permanent; the record of it did not write. Say so plainly.
    console.error('[void_entry] CRITICAL: void posted but corrections record failed:', plan.entry.reference, reversal.reference, corrErr.message);
    throw fail('correction_record_failed', `${plan.entry.reference} was voided by ${reversal.reference} dated ${plan.reversal_date}, but the corrections record could not be written (${corrErr.message}). The void stands; record it before anything else.`, 500);
  }

  return {
    voided: plan.entry.reference,
    reversal: { id: reversal.id, reference: reversal.reference, posting_date: reversal.posting_date, total_cents: plan.totals.debit_cents },
    correction_id: correction ? correction.id : null,
    plan,
    message: `${plan.entry.reference} voided. Reversal ${reversal.reference} posted ${plan.reversal_date} for ${money(plan.totals.debit_cents)}.`,
  };
}

module.exports = { planVoid, voidAsOwner, isCalendarDate };
