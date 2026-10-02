// ============================================================================
// lib/tax/payment_gate.js  (Issue #14): where the 1099 W-9 rule acts
// ----------------------------------------------------------------------------
//   CHECK RUN (Trusted disburses): every vendor's check, split by bill
//          category, is evaluated before any check number is used. In ENFORCE
//          mode a block refuses the whole run; in WARN mode (the rollout
//          default, TAX_W9_GATE) the same decision is computed and reported but
//          nothing is refused (lib/tax/gate_mode.js).
//   WARN   approval (manager key / admin release): projected, never blocks.
//   WARN   recording a payment that already happened: never blocks.
//   ALLOW  intake, vendor creation, accrual: never evaluated (Ed's rule 1).
//   OUT OF SCOPE: associations whose books are not in trustEd (data-driven,
//          lib/ap/books_scope): their 1099s come from the books of record.
// Read errors: enforce fails CLOSED (no check on an unknown); warn and
// recording fail OPEN (logged). The rule: lib/tax/info_reporting.js.
// ============================================================================
const { evaluatePayment, evaluatePaymentParts, categoryFor } = require('./info_reporting');
const { reportableTotals, totalsByCategory, loadVendorsForTax, invoiceCategories, communitiesOutsideBooks } = require('./reportable_payments');
const { gateMode } = require('./gate_mode');

const yearOf = (d) => Number(String(d || new Date().toISOString()).slice(0, 4));
function partsFor(bills, cats, vendor) {
  const m = new Map();
  for (const b of bills) { const c = categoryFor(cats.get(b.invoice_id), vendor); m.set(c, (m.get(c) || 0) + Number(b.cents || 0)); }
  return [...m].map(([category, cents]) => ({ category, cents }));
}

// Check run: vendorBills Map(vendor_id -> [{ invoice_id, cents }]) being paid now.
// enforce: throws { code: 'w9_required_for_payment' | 'threshold_unconfigured' |
//          'tax_check_failed', detail, vendors } on a block / unknown.
// warn:    never throws for W-9 status; returns { ok, mode, would_block, warnings, config_error }.
async function assertCheckRunAllowed(supabase, { community_id, vendorBills, payment_date }, { env = process.env } = {}) {
  const gm = gateMode(env);
  if (gm.error) console.error('[tax] W-9 gate configuration error:', gm.error);
  const year = yearOf(payment_date);
  const ids = [...vendorBills.keys()];
  let vendors, totals, cats, outside;
  try {
    outside = await communitiesOutsideBooks(supabase);
    if (outside.has(community_id)) return { ok: true, mode: gm.mode, out_of_scope: true, would_block: [], warnings: [], config_error: gm.error, reason: 'books of record are not in trustEd: 1099 is handled there' };
    vendors = await loadVendorsForTax(supabase, ids);
    totals = await reportableTotals(supabase, { vendorIds: ids, year, communityId: community_id, excluded: outside });
    cats = await invoiceCategories(supabase, [...vendorBills.values()].flat().map((b) => b.invoice_id));
  } catch (e) {
    if (gm.mode === 'enforce') throw Object.assign(new Error(`1099 check could not run (${e.message}); no checks were cut`), { code: 'tax_check_failed' });
    console.warn('[tax] W-9 check could not run (warn mode, run continues):', e.message);
    return { ok: true, mode: gm.mode, check_failed: e.message, would_block: [], warnings: [], config_error: gm.error };
  }
  const blocked = []; const evaluations = [];
  for (const [vendor_id, bills] of vendorBills) {
    const v = vendors.get(vendor_id);
    const ev = evaluatePaymentParts({ vendor: v, year, parts: partsFor(bills, cats, v), priorByCategory: totalsByCategory(totals, vendor_id, community_id), method: 'check', initiation: 'disburse' });
    evaluations.push({ vendor_id, ...ev });
    if (ev.decision === 'block' || ev.decision === 'config_exception') blocked.push({ vendor_id, vendor_name: (v || {}).name || null, decision: ev.decision, category: ev.category, reason: ev.reason, cumulative_after_cents: ev.cumulative_after_cents, threshold_cents: ev.threshold_cents });
  }
  if (blocked.length) {
    const onlyConfig = blocked.every((b) => b.decision === 'config_exception');
    const detail = `${onlyConfig ? '1099 threshold not configured' : 'W-9 needed before paying'}: ${blocked.map((b) => b.reason).join(' ')}`;
    if (gm.mode === 'enforce') throw Object.assign(new Error(detail), { code: onlyConfig ? 'threshold_unconfigured' : 'w9_required_for_payment', detail, vendors: blocked });
    // WARN: same decision, reported; nothing refused or reserved differently.
    console.warn(`[tax] W-9 gate (warn mode) would ${onlyConfig ? 'raise a configuration exception' : 'block'}: ${detail}`);
    return { ok: true, mode: 'warn', would_block: blocked, warnings: blocked.map((b) => b.reason), detail, config_error: gm.error, evaluations };
  }
  return { ok: true, mode: gm.mode, would_block: [], warnings: [], config_error: gm.error, evaluations };
}

// Projection for a list of bills (check-run list, approval). Never throws.
// bills: [{ id, vendor_id, community_id, balance_cents }] -> Map(bill id -> evaluation)
async function projectBills(supabase, bills, { initiation = 'disburse', payment_date } = {}) {
  const out = new Map();
  try {
    const year = yearOf(payment_date);
    const outside = await communitiesOutsideBooks(supabase);
    const inScope = bills.filter((b) => !outside.has(b.community_id)); // books elsewhere: no 1099 evaluation here
    if (!inScope.length) return out;
    const vendors = await loadVendorsForTax(supabase, inScope.map((b) => b.vendor_id));
    const totals = await reportableTotals(supabase, { vendorIds: inScope.map((b) => b.vendor_id), year, excluded: outside });
    const cats = await invoiceCategories(supabase, inScope.map((b) => b.id));
    const group = new Map();
    const catOf = (b) => categoryFor(cats.get(b.id), vendors.get(b.vendor_id));
    for (const b of inScope) { const k = `${b.vendor_id}|${b.community_id}|${catOf(b)}`; group.set(k, (group.get(k) || 0) + Number(b.balance_cents || 0)); }
    for (const b of inScope) {
      const cat = catOf(b); const k = `${b.vendor_id}|${b.community_id}|${cat}`;
      out.set(b.id, evaluatePayment({ vendor: vendors.get(b.vendor_id), year, category: cat, priorReportableCents: totals.get(k) || 0, paymentCents: group.get(k), method: 'check', initiation }));
    }
  } catch (e) { console.warn('[tax] projection skipped:', e.message); }
  return out;
}

// A payment being RECORDED (already happened). Never throws.
async function evaluateRecordedPayment(supabase, { community_id, vendor_id, amount_cents, payment_date, payment_method, applications = [] }) {
  try {
    const outside = await communitiesOutsideBooks(supabase);
    if (outside.has(community_id)) return { decision: 'allow', reason: 'books of record are not in trustEd: 1099 is handled there', out_of_scope: true };
    const year = yearOf(payment_date);
    const vendors = await loadVendorsForTax(supabase, [vendor_id]);
    const v = vendors.get(vendor_id);
    const totals = await reportableTotals(supabase, { vendorIds: [vendor_id], year, communityId: community_id, excluded: outside });
    const bills = (applications || []).map((a) => ({ invoice_id: a.invoice_id, cents: a.applied_cents }));
    const cats = await invoiceCategories(supabase, bills.map((b) => b.invoice_id));
    const parts = bills.length ? partsFor(bills, cats, v) : [{ category: null, cents: amount_cents }];
    const ev = evaluatePaymentParts({ vendor: v, year, parts, priorByCategory: totalsByCategory(totals, vendor_id, community_id), method: payment_method, initiation: 'record' });
    if (ev.decision === 'warn') console.warn('[tax] W-9 needed (payment recorded):', ev.reason);
    return ev;
  } catch (e) { console.warn('[tax] recorded-payment check skipped (recording continues):', e.message); return { decision: 'unknown', reason: `1099 check unavailable: ${e.message}` }; }
}

module.exports = { assertCheckRunAllowed, projectBills, evaluateRecordedPayment };
