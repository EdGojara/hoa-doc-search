// ============================================================================
// lib/accounting/cutover.js
// ----------------------------------------------------------------------------
// The GL cutover rule for native AP postings (Ed 2026-09-24).
//
// A community's gl_cutover_date is the first day Trusted owns its books; the
// period before it was converted from the prior system and is certified. A
// native AP posting may never land before that date:
//   * an AP INVOICE dated before cutover is NOT auto-posted: it waits for a
//     reviewer (lib/ap/cutover_review.js, mig 458). Only a NOT_IN_CONVERTED_BOOKS
//     decision posts it, effective the cutover date; apInvoicePostingDate is the
//     date rule for that reviewed invoice's follow-on postings (e.g. a fee). The
//     vendor's invoice date is kept on the invoice, never rewritten;
//   * any other AP posting (payment, prepaid, fee) dated before cutover is
//     REFUSED loudly: moving a cash date would break the bank reconciliation,
//     and the converted period already accounts for it.
//
// Scar: 2026-09-24, AP intake posted an NRG bill dated 7/13 into LOPF's
// certified July (cutover 8/1) and moved the 7/31 trial balance by $440.72.
// ============================================================================

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (v) => (v == null ? null : String(v).slice(0, 10));

// The community's cutover date ('YYYY-MM-DD') or null (no cutover = no rule).
// Errors throw: an unknown cutover must never read as "no cutover".
async function getGlCutoverDate(supabase, communityId) {
  const { data, error } = await supabase.from('communities').select('gl_cutover_date').eq('id', communityId).maybeSingle();
  if (error) throw Object.assign(new Error(`gl_cutover_lookup_failed: ${error.message}`), { code: 'cutover_lookup_failed' });
  const d = data ? day(data.gl_cutover_date) : null;
  return d && ISO.test(d) ? d : null;
}

// GL posting date for an AP invoice accrual: the invoice date, or the cutover
// date when the invoice is dated before it.
function apInvoicePostingDate(invoiceDate, cutoverDate) {
  const d = day(invoiceDate);
  if (!d || !ISO.test(d)) throw Object.assign(new Error('invoice_date_required_yyyy_mm_dd'), { code: 'invalid_input' });
  const c = day(cutoverDate);
  return c && d < c ? c : d;
}

// Hard guard: throws when a native AP posting would land before cutover.
function assertNotBeforeCutover(postingDate, cutoverDate, what = 'AP posting') {
  const d = day(postingDate); const c = day(cutoverDate);
  if (c && d && d < c) {
    throw Object.assign(
      new Error(`${what} dated ${d} is before the GL cutover ${c}: the period before cutover is converted and certified; refusing to post into it`),
      { code: 'before_gl_cutover', posting_date: d, gl_cutover_date: c },
    );
  }
}

module.exports = { getGlCutoverDate, apInvoicePostingDate, assertNotBeforeCutover };
