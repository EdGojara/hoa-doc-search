// ============================================================================
// lib/ap/cutover_review.js
// ----------------------------------------------------------------------------
// Pre-cutover AP invoices (Ed 2026-09-24, mig 458). An AP invoice dated before
// the community's gl_cutover_date is NEVER auto-posted to the GL, not even at
// the cutover date: that period was converted and certified, and the bill may
// already be in those books (the July NRG run was: expensed and paid by
// auto-draft in the converted period). It waits in cutover_review = 'PENDING'
// until a person decides:
//   ALREADY_IN_CONVERTED_BOOKS  no GL posting, ever
//   NOT_IN_CONVERTED_BOOKS      post the accrual effective gl_cutover_date
//   NEEDS_REVIEW                undecided; stays out of the GL
// The invoice row, source document, original invoice date and audit trail are
// never rewritten. The hard guard in lib/accounting/posting.js still refuses
// any AP posting dated before cutover.
// ============================================================================

const { getGlCutoverDate } = require('../accounting/cutover');

const DECISIONS = ['ALREADY_IN_CONVERTED_BOOKS', 'NOT_IN_CONVERTED_BOOKS', 'NEEDS_REVIEW'];
const day = (v) => (v == null ? null : String(v).slice(0, 10));

// Pure: is this invoice dated before the cutover?
function isPreCutover(invoiceDate, cutoverDate) {
  const d = day(invoiceDate); const c = day(cutoverDate);
  return !!(d && c && d < c);
}

// Intake gate. Returns { hold: true, cutover } when the invoice must go to
// review instead of the GL. Errors reading the cutover throw (never "no rule").
async function preCutoverHold(supabase, communityId, invoiceDate) {
  const cutover = await getGlCutoverDate(supabase, communityId);
  return { hold: isPreCutover(invoiceDate, cutover), cutover };
}

// Park an invoice for pre-cutover review (no GL posting).
async function markPendingReview(supabase, invoiceId, cutover, invoiceDate) {
  const { error } = await supabase.from('ap_invoices').update({
    cutover_review: 'PENDING',
    needs_review: true,
    cutover_review_notes: `Invoice dated ${day(invoiceDate)} is before the GL cutover ${cutover}: not posted. Review: already in the converted books, or post at cutover.`,
  }).eq('id', invoiceId);
  if (error) throw error;
}

// GL lines for an invoice's accrual, from its coded lines (else its coded account).
async function accrualLinesFor(supabase, inv) {
  const { data: lines, error } = await supabase.from('ap_invoice_lines')
    .select('gl_account_id, amount_cents, tax_amount_cents, description').eq('invoice_id', inv.id);
  if (error) throw error;
  const debit = new Map();
  if ((lines || []).length) {
    for (const l of lines) {
      if (!l.gl_account_id) throw Object.assign(new Error('invoice_has_uncoded_lines'), { code: 'invalid_state' });
      debit.set(l.gl_account_id, (debit.get(l.gl_account_id) || 0) + Number(l.amount_cents || 0) + Number(l.tax_amount_cents || 0));
    }
  } else if (inv.coded_gl_account_id) {
    debit.set(inv.coded_gl_account_id, Number(inv.total_cents));
  } else {
    throw Object.assign(new Error('invoice_not_coded'), { code: 'invalid_state' });
  }
  // fold any rounding/header difference into the largest debit so the entry balances to the total
  const sum = [...debit.values()].reduce((a, b) => a + b, 0);
  const diff = Number(inv.total_cents) - sum;
  if (diff !== 0) { let big = null; for (const [k, v] of debit) if (big == null || v > debit.get(big)) big = k; debit.set(big, debit.get(big) + diff); }
  const out = [];
  for (const [acct, cents] of debit) {
    if (cents > 0) out.push({ account_id: acct, debit_cents: cents, credit_cents: 0, memo: `Invoice ${inv.vendor_invoice_number || ''}`.trim(), vendor_id: inv.vendor_id });
    else if (cents < 0) out.push({ account_id: acct, debit_cents: 0, credit_cents: -cents, memo: `Invoice ${inv.vendor_invoice_number || ''}`.trim(), vendor_id: inv.vendor_id });
  }
  return out;
}

async function findApAccount(supabase, communityId) {
  for (const num of ['20100', '2000']) {
    const { data, error } = await supabase.from('chart_of_accounts').select('id').eq('community_id', communityId).eq('account_number', num).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  return null;
}

// The reviewer's decision. NOT_IN_CONVERTED_BOOKS posts the accrual effective
// gl_cutover_date through the guarded poster; the other two never touch the GL.
async function reviewPreCutoverInvoice(supabase, { invoiceId, decision, reviewedBy, notes }, deps = {}) {
  if (!DECISIONS.includes(decision)) throw Object.assign(new Error(`decision must be one of ${DECISIONS.join(', ')}`), { code: 'invalid_input' });
  if (!reviewedBy) throw Object.assign(new Error('reviewed_by_required'), { code: 'invalid_input' });
  const { data: inv, error } = await supabase.from('ap_invoices').select('*').eq('id', invoiceId).maybeSingle();
  if (error) throw error;
  if (!inv) throw Object.assign(new Error('invoice_not_found'), { code: 'not_found' });
  const cutover = await getGlCutoverDate(supabase, inv.community_id);
  if (!isPreCutover(inv.invoice_date, cutover)) throw Object.assign(new Error('invoice_is_not_dated_before_cutover'), { code: 'invalid_state' });
  if (inv.cutover_review === 'ALREADY_IN_CONVERTED_BOOKS' || inv.cutover_review === 'NOT_IN_CONVERTED_BOOKS') {
    throw Object.assign(new Error(`already decided: ${inv.cutover_review}`), { code: 'invalid_state' });
  }
  if (inv.status === 'voided') throw Object.assign(new Error('invoice_voided'), { code: 'invalid_state' });

  let jeId = null;
  if (decision === 'NOT_IN_CONVERTED_BOOKS') {
    if (inv.posting_journal_entry_id) throw Object.assign(new Error('invoice_already_posted'), { code: 'invalid_state' });
    const ap = await findApAccount(supabase, inv.community_id);
    if (!ap) throw Object.assign(new Error('ap_account_not_found'), { code: 'invalid_state' });
    const lines = await accrualLinesFor(supabase, inv);
    lines.push({ account_id: ap.id, debit_cents: 0, credit_cents: Number(inv.total_cents), memo: `AP — invoice ${inv.vendor_invoice_number || ''}`.trim(), vendor_id: inv.vendor_id });
    const postJournalEntry = deps.postJournalEntry || require('../accounting/posting').postJournalEntry;
    const je = await postJournalEntry({
      community_id: inv.community_id, posting_date: cutover,
      description: `AP invoice ${inv.vendor_invoice_number || ''} (invoice dated ${day(inv.invoice_date)}; not in converted books, posted at GL cutover ${cutover})`.trim(),
      source_module: 'ap_invoice', source_reference: inv.id, ap_posting: true, lines,
    });
    jeId = je.entry.id;
  }
  const patch = {
    cutover_review: decision, cutover_reviewed_at: new Date().toISOString(), cutover_reviewed_by: reviewedBy,
    cutover_review_notes: notes || inv.cutover_review_notes || null,
    needs_review: decision === 'NEEDS_REVIEW',
    ...(jeId ? { posting_journal_entry_id: jeId } : {}),
  };
  const { data: updated, error: uErr } = await supabase.from('ap_invoices').update(patch).eq('id', inv.id).select('*').maybeSingle();
  if (uErr) throw uErr;
  return { invoice: updated, posting_journal_entry_id: jeId };
}

module.exports = { DECISIONS, isPreCutover, preCutoverHold, markPendingReview, reviewPreCutoverInvoice, accrualLinesFor };
