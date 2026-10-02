// ============================================================================
// lib/tax/payment_gate.js  (Issue #14): where the 1099 W-9 rule acts
// ----------------------------------------------------------------------------
//   BLOCK  only where Trusted DISBURSES money: the check run (createCheckRun).
//          The check that takes a reportable vendor without a W-9 to a
//          category's threshold or more, for this association this year, is
//          refused before any check number is used. A (category, year) with no
//          confirmed threshold is a CONFIGURATION exception instead.
//   WARN   approval (manager key / admin release): projected, never blocks.
//   WARN   recording a payment that already happened (mark-paid, POST
//          /payments, early prepay, a vendor auto-draft): never blocks.
//   ALLOW  intake, vendor creation, accrual: never evaluated (Ed's rule 1).
// Payments are split by each bill's reporting category (attorney fees vs gross
// proceeds paid to an attorney have different thresholds). Fails CLOSED for a
// disbursement, OPEN for a recording. The rule: lib/tax/info_reporting.js.
// ============================================================================
const { evaluatePayment, evaluatePaymentParts, categoryFor } = require('./info_reporting');
const { reportableTotals, totalsByCategory, loadVendorsForTax, invoiceCategories } = require('./reportable_payments');

const yearOf = (d) => Number(String(d || new Date().toISOString()).slice(0, 4));
// [{ invoice_id, cents }] + categories + vendor -> [{ category, cents }]
function partsFor(bills, cats, vendor) {
  const m = new Map();
  for (const b of bills) { const c = categoryFor(cats.get(b.invoice_id), vendor); m.set(c, (m.get(c) || 0) + Number(b.cents || 0)); }
  return [...m].map(([category, cents]) => ({ category, cents }));
}

// Check run: vendorBills Map(vendor_id -> [{ invoice_id, cents }]) being paid now.
// Throws { code: 'w9_required_for_payment' | 'threshold_unconfigured', detail, vendors }.
async function assertCheckRunAllowed(supabase, { community_id, vendorBills, payment_date }) {
  const year = yearOf(payment_date);
  const ids = [...vendorBills.keys()];
  let vendors, totals, cats;
  try {
    vendors = await loadVendorsForTax(supabase, ids);
    totals = await reportableTotals(supabase, { vendorIds: ids, year, communityId: community_id });
    cats = await invoiceCategories(supabase, [...vendorBills.values()].flat().map((b) => b.invoice_id));
  } catch (e) {
    throw Object.assign(new Error(`1099 check could not run (${e.message}); no checks were cut`), { code: 'tax_check_failed' });
  }
  const blocked = []; const evaluations = [];
  for (const [vendor_id, bills] of vendorBills) {
    const v = vendors.get(vendor_id);
    const ev = evaluatePaymentParts({ vendor: v, year, parts: partsFor(bills, cats, v), priorByCategory: totalsByCategory(totals, vendor_id, community_id), method: 'check', initiation: 'disburse' });
    evaluations.push({ vendor_id, ...ev });
    if (ev.decision === 'block' || ev.decision === 'config_exception') blocked.push({ vendor_id, vendor_name: (v || {}).name || null, decision: ev.decision, category: ev.category, reason: ev.reason, cumulative_after_cents: ev.cumulative_after_cents, threshold_cents: ev.threshold_cents });
  }
  if (blocked.length) {
    // A year with no confirmed threshold is a CONFIGURATION exception, reported
    // as such, never a block on last year's number (Ed 2026-10-02).
    const onlyConfig = blocked.every((b) => b.decision === 'config_exception');
    const detail = `${onlyConfig ? '1099 threshold not configured' : 'W-9 needed before paying'}: ${blocked.map((b) => b.reason).join(' ')}`;
    throw Object.assign(new Error(detail), { code: onlyConfig ? 'threshold_unconfigured' : 'w9_required_for_payment', detail, vendors: blocked });
  }
  return { ok: true, evaluations };
}

// Projection for a list of bills (check-run list, approval). Never throws.
// bills: [{ id, vendor_id, community_id, balance_cents }] -> Map(bill id -> evaluation)
async function projectBills(supabase, bills, { initiation = 'disburse', payment_date } = {}) {
  const out = new Map();
  try {
    const year = yearOf(payment_date);
    const vendors = await loadVendorsForTax(supabase, bills.map((b) => b.vendor_id));
    const totals = await reportableTotals(supabase, { vendorIds: bills.map((b) => b.vendor_id), year });
    const cats = await invoiceCategories(supabase, bills.map((b) => b.id));
    const group = new Map();
    const catOf = (b) => categoryFor(cats.get(b.id), vendors.get(b.vendor_id));
    for (const b of bills) { const k = `${b.vendor_id}|${b.community_id}|${catOf(b)}`; group.set(k, (group.get(k) || 0) + Number(b.balance_cents || 0)); }
    for (const b of bills) {
      const cat = catOf(b); const k = `${b.vendor_id}|${b.community_id}|${cat}`;
      out.set(b.id, evaluatePayment({ vendor: vendors.get(b.vendor_id), year, category: cat, priorReportableCents: totals.get(k) || 0, paymentCents: group.get(k), method: 'check', initiation }));
    }
  } catch (e) { console.warn('[tax] projection skipped:', e.message); }
  return out;
}

// A payment being RECORDED (already happened). Never throws; returns the most
// severe evaluation (allow|warn) across the bills it pays, to attach and log.
async function evaluateRecordedPayment(supabase, { community_id, vendor_id, amount_cents, payment_date, payment_method, applications = [] }) {
  try {
    const year = yearOf(payment_date);
    const vendors = await loadVendorsForTax(supabase, [vendor_id]);
    const v = vendors.get(vendor_id);
    const totals = await reportableTotals(supabase, { vendorIds: [vendor_id], year, communityId: community_id });
    const bills = (applications || []).map((a) => ({ invoice_id: a.invoice_id, cents: a.applied_cents }));
    const cats = await invoiceCategories(supabase, bills.map((b) => b.invoice_id));
    const parts = bills.length ? partsFor(bills, cats, v) : [{ category: null, cents: amount_cents }];
    const ev = evaluatePaymentParts({ vendor: v, year, parts, priorByCategory: totalsByCategory(totals, vendor_id, community_id), method: payment_method, initiation: 'record' });
    if (ev.decision === 'warn') console.warn('[tax] W-9 needed (payment recorded):', ev.reason);
    return ev;
  } catch (e) { console.warn('[tax] recorded-payment check skipped (recording continues):', e.message); return { decision: 'unknown', reason: `1099 check unavailable: ${e.message}` }; }
}

module.exports = { assertCheckRunAllowed, projectBills, evaluateRecordedPayment };
