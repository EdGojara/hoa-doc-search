// ============================================================================
// lib/tax/payment_gate.js  (Issue #14): where the 1099 W-9 rule is SHOWN
// ----------------------------------------------------------------------------
// INFORMATIONAL ONLY (Ed 2026-10-02): "never miss/forget the W-9 requirement,
// but never hold up an otherwise valid payment because of it." Nothing in this
// module refuses, delays or alters a payment, and there is no setting that
// could make it do so (the earlier TAX_W9_GATE warn/enforce control is retired;
// if the variable is still set it is ignored and logged).
//   CHECK RUN   every vendor's check, split by bill category, is evaluated;
//               'W-9 needed' results come back with the run and are written to
//               each payment's audit note. The run always proceeds.
//   LISTS       check-run list and Payables queue carry a 'W-9 needed' flag.
//   APPROVAL    the approve response carries the flag.
//   RECORDING   the recorded payment carries the flag (and its audit note).
//   OUT OF SCOPE  books not in trustEd, and demo tenants (stored data).
// A read or configuration failure is surfaced LOUDLY (console.error + returned
// in the result) for follow-up, and never blocks anything.
// ============================================================================
const { evaluatePayment, evaluatePaymentParts, categoryFor } = require('./info_reporting');
const { reportableTotals, totalsByCategory, loadVendorsForTax, invoiceCategories, communitiesOutsideBooks } = require('./reportable_payments');

if (process.env.TAX_W9_GATE != null && String(process.env.TAX_W9_GATE).trim() !== '') {
  console.warn(`[tax] TAX_W9_GATE="${String(process.env.TAX_W9_GATE).slice(0, 40)}" is retired and ignored: W-9 compliance is informational and never blocks a payment.`);
}

const yearOf = (d) => Number(String(d || new Date().toISOString()).slice(0, 4));
const FLAG = new Set(['w9_needed', 'threshold_unconfigured']);
function partsFor(bills, cats, vendor) {
  const m = new Map();
  for (const b of bills) { const c = categoryFor(cats.get(b.invoice_id), vendor); m.set(c, (m.get(c) || 0) + Number(b.cents || 0)); }
  return [...m].map(([category, cents]) => ({ category, cents }));
}

// Check run: vendorBills Map(vendor_id -> [{ invoice_id, cents }]). NEVER throws.
// -> { out_of_scope?, check_failed?, needs_w9: [{ vendor_id, vendor_name, decision, category, reason, ... }], byVendor: Map }
async function checkRunW9Status(supabase, { community_id, vendorBills, payment_date }) {
  const year = yearOf(payment_date);
  const ids = [...vendorBills.keys()];
  const byVendor = new Map();
  try {
    const outside = await communitiesOutsideBooks(supabase);
    if (outside.has(community_id)) return { out_of_scope: true, needs_w9: [], byVendor, reason: 'not in 1099 scope here (books of record not in trustEd, or a demo tenant)' };
    const vendors = await loadVendorsForTax(supabase, ids);
    const totals = await reportableTotals(supabase, { vendorIds: ids, year, communityId: community_id, excluded: outside });
    const cats = await invoiceCategories(supabase, [...vendorBills.values()].flat().map((b) => b.invoice_id));
    const needs = [];
    for (const [vendor_id, bills] of vendorBills) {
      const v = vendors.get(vendor_id);
      const ev = evaluatePaymentParts({ vendor: v, year, parts: partsFor(bills, cats, v), priorByCategory: totalsByCategory(totals, vendor_id, community_id), method: 'check', initiation: 'disburse' });
      byVendor.set(vendor_id, ev);
      if (FLAG.has(ev.decision)) needs.push({ vendor_id, vendor_name: (v || {}).name || null, decision: ev.decision, category: ev.category, reason: ev.reason, cumulative_after_cents: ev.cumulative_after_cents, threshold_cents: ev.threshold_cents });
    }
    if (needs.length) console.warn(`[tax] W-9 needed on this check run (payments proceed): ${needs.map((n) => n.reason).join(' ')}`);
    return { needs_w9: needs, byVendor };
  } catch (e) {
    console.error('[tax] W-9 compliance check FAILED for a check run (payments proceed; follow up):', e.message);
    return { check_failed: e.message, needs_w9: [], byVendor };
  }
}

// Flags for a list of bills (check-run list, Payables queue, approval). Never throws.
// bills: [{ id, vendor_id, community_id, balance_cents }] -> Map(bill id -> evaluation)
// context (optional): facts the caller already loaded for the same year, so
// they are not read again: { outside, vendors, totals, categories }. totals must
// cover these bills' vendors (per-key values are identical either way).
async function projectBills(supabase, bills, { initiation = 'disburse', payment_date, context = null } = {}) {
  const out = new Map();
  try {
    const year = yearOf(payment_date);
    const ctx = context || {};
    const outside = ctx.outside || await communitiesOutsideBooks(supabase);
    const inScope = bills.filter((b) => !outside.has(b.community_id));
    if (!inScope.length) return out;
    const vendors = ctx.vendors || await loadVendorsForTax(supabase, inScope.map((b) => b.vendor_id));
    const totals = ctx.totals || await reportableTotals(supabase, { vendorIds: inScope.map((b) => b.vendor_id), year, excluded: outside });
    const cats = ctx.categories || await invoiceCategories(supabase, inScope.map((b) => b.id));
    const group = new Map();
    const catOf = (b) => categoryFor(cats.get(b.id), vendors.get(b.vendor_id));
    for (const b of inScope) { const k = `${b.vendor_id}|${b.community_id}|${catOf(b)}`; group.set(k, (group.get(k) || 0) + Number(b.balance_cents || 0)); }
    for (const b of inScope) {
      const cat = catOf(b); const k = `${b.vendor_id}|${b.community_id}|${cat}`;
      out.set(b.id, evaluatePayment({ vendor: vendors.get(b.vendor_id), year, category: cat, priorReportableCents: totals.get(k) || 0, paymentCents: group.get(k), method: 'check', initiation }));
    }
  } catch (e) { console.error('[tax] W-9 flags could not be computed (list shown without them; follow up):', e.message); }
  return out;
}

// A payment being RECORDED. Never throws; returns the most significant flag.
async function evaluateRecordedPayment(supabase, { community_id, vendor_id, amount_cents, payment_date, payment_method, applications = [] }) {
  try {
    const outside = await communitiesOutsideBooks(supabase);
    if (outside.has(community_id)) return { decision: 'allow', reason: 'not in 1099 scope here (books of record not in trustEd, or a demo tenant)', out_of_scope: true };
    const year = yearOf(payment_date);
    const vendors = await loadVendorsForTax(supabase, [vendor_id]);
    const v = vendors.get(vendor_id);
    const totals = await reportableTotals(supabase, { vendorIds: [vendor_id], year, communityId: community_id, excluded: outside });
    const bills = (applications || []).map((a) => ({ invoice_id: a.invoice_id, cents: a.applied_cents }));
    const cats = await invoiceCategories(supabase, bills.map((b) => b.invoice_id));
    const parts = bills.length ? partsFor(bills, cats, v) : [{ category: null, cents: amount_cents }];
    const ev = evaluatePaymentParts({ vendor: v, year, parts, priorByCategory: totalsByCategory(totals, vendor_id, community_id), method: payment_method, initiation: 'record' });
    if (FLAG.has(ev.decision)) console.warn('[tax] W-9 needed (payment recorded):', ev.reason);
    return ev;
  } catch (e) {
    console.error('[tax] W-9 compliance check FAILED for a recorded payment (recording continues; follow up):', e.message);
    return { decision: 'check_failed', reason: `W-9 compliance check could not run: ${e.message}` };
  }
}

// The short audit note written on a payment that needed a W-9 (or whose check failed).
function auditNote(ev) {
  if (!ev) return null;
  if (FLAG.has(ev.decision)) return `[W-9 compliance: ${ev.reason}]`;
  if (ev.decision === 'check_failed') return `[W-9 compliance check failed: ${ev.reason}]`;
  return null;
}

module.exports = { checkRunW9Status, projectBills, evaluateRecordedPayment, auditNote, FLAG };
