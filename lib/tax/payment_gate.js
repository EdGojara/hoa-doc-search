// ============================================================================
// lib/tax/payment_gate.js  (Issue #14): where the 1099 W-9 rule acts
// ----------------------------------------------------------------------------
//   BLOCK  only where Trusted DISBURSES money: the check run (createCheckRun).
//          The check to a potentially reportable vendor with no W-9 that takes
//          its cumulative reportable payments from this association this year
//          to the threshold or more is refused, before any check number is used.
//   WARN   approval (manager key / admin release): projected, never blocks.
//   WARN   recording a payment that already happened (mark-paid ACH/wire/card,
//          POST /payments, early prepay, a vendor auto-draft): never blocks;
//          Trusted must always be able to record real bank activity.
//   ALLOW  intake, vendor creation, accrual: never evaluated (Ed's rule 1).
// The rule itself: lib/tax/info_reporting.js. Fails CLOSED for a disbursement
// (a read error refuses the check) and OPEN for a recording (a read error never
// stops recording real activity; it is logged).
// ============================================================================
const { evaluatePayment } = require('./info_reporting');
const { reportableTotals, loadVendorsForTax } = require('./reportable_payments');

const yearOf = (d) => Number(String(d || new Date().toISOString()).slice(0, 4));

// Check run: vendorAmounts Map(vendor_id -> cents being paid now).
// Throws { code: 'w9_required_for_payment', detail, vendors: [...] } on a block.
async function assertCheckRunAllowed(supabase, { community_id, vendorAmounts, payment_date }) {
  const year = yearOf(payment_date);
  const ids = [...vendorAmounts.keys()];
  let vendors, totals;
  try {
    vendors = await loadVendorsForTax(supabase, ids);
    totals = await reportableTotals(supabase, { vendorIds: ids, year, communityId: community_id });
  } catch (e) {
    throw Object.assign(new Error(`1099 check could not run (${e.message}); no checks were cut`), { code: 'tax_check_failed' });
  }
  const blocked = [];
  const evaluations = [];
  for (const [vendor_id, cents] of vendorAmounts) {
    const ev = evaluatePayment({ vendor: vendors.get(vendor_id), year, priorReportableCents: totals.get(`${vendor_id}|${community_id}`) || 0, paymentCents: cents, method: 'check', initiation: 'disburse' });
    evaluations.push({ vendor_id, ...ev });
    if (ev.decision === 'block') blocked.push({ vendor_id, vendor_name: (vendors.get(vendor_id) || {}).name || null, reason: ev.reason, cumulative_after_cents: ev.cumulative_after_cents, threshold_cents: ev.threshold_cents });
  }
  if (blocked.length) {
    const detail = `W-9 needed before paying: ${blocked.map((b) => b.reason).join(' ')}`;
    throw Object.assign(new Error(detail), { code: 'w9_required_for_payment', detail, vendors: blocked });
  }
  return { ok: true, evaluations };
}

// Projection for a list of bills (check-run list, approval): per vendor +
// community, prior reportable this year + the bills' balances. Never throws.
// bills: [{ id, vendor_id, community_id, balance_cents }] -> Map(bill id -> evaluation)
async function projectBills(supabase, bills, { initiation = 'disburse', payment_date } = {}) {
  const out = new Map();
  try {
    const year = yearOf(payment_date);
    const vendors = await loadVendorsForTax(supabase, bills.map((b) => b.vendor_id));
    const totals = await reportableTotals(supabase, { vendorIds: bills.map((b) => b.vendor_id), year });
    const group = new Map();
    for (const b of bills) { const k = `${b.vendor_id}|${b.community_id}`; group.set(k, (group.get(k) || 0) + Number(b.balance_cents || 0)); }
    for (const b of bills) {
      const k = `${b.vendor_id}|${b.community_id}`;
      out.set(b.id, evaluatePayment({ vendor: vendors.get(b.vendor_id), year, priorReportableCents: totals.get(k) || 0, paymentCents: group.get(k), method: 'check', initiation }));
    }
  } catch (e) { console.warn('[tax] projection skipped:', e.message); }
  return out;
}

// A payment being RECORDED (already happened). Never throws; returns the
// evaluation (decision allow|warn) to attach to the response and log.
async function evaluateRecordedPayment(supabase, { community_id, vendor_id, amount_cents, payment_date, payment_method }) {
  try {
    const year = yearOf(payment_date);
    const vendors = await loadVendorsForTax(supabase, [vendor_id]);
    const totals = await reportableTotals(supabase, { vendorIds: [vendor_id], year, communityId: community_id });
    const ev = evaluatePayment({ vendor: vendors.get(vendor_id), year, priorReportableCents: totals.get(`${vendor_id}|${community_id}`) || 0, paymentCents: amount_cents, method: payment_method, initiation: 'record' });
    if (ev.decision === 'warn') console.warn('[tax] W-9 needed (payment recorded):', ev.reason);
    return ev;
  } catch (e) { console.warn('[tax] recorded-payment check skipped (recording continues):', e.message); return { decision: 'unknown', reason: `1099 check unavailable: ${e.message}` }; }
}

module.exports = { assertCheckRunAllowed, projectBills, evaluateRecordedPayment };
