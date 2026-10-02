// ============================================================================
// lib/tax/info_reporting.js  (Issue #14, Ed 2026-10-02): 1099 W-9 compliance
// ----------------------------------------------------------------------------
// Ed's 2026 rule, encoded as pure functions (no I/O). INFORMATIONAL ONLY (Ed
// 2026-10-02): "never miss/forget the W-9 requirement, but never hold up an
// otherwise valid payment because of it". Every decision here is a FLAG
// ('w9_needed' / 'threshold_unconfigured') shown on the check run, AP and vendor
// views, reports and the payment's audit trail. Nothing refuses a payment.
//  1. Recognizing a bill (vendor creation, accrual, approval) is NEVER blocked
//     by a missing W-9.
//  2. Track cumulative REPORTABLE payments per vendor, per payer (each
//     association is its own 1099 filer / EIN), per calendar year, per
//     REPORTING CATEGORY (each form box has its own threshold). The payment
//     Trusted would DISBURSE that brings a category total to its threshold or
//     more requires a W-9 with a tax classification first, when reportable.
//  3. A vendor is non-reportable only by STORED vendor-master data with
//     provenance (tax_reporting_status = 'exempt_verified' + basis + source +
//     who/when), never guessed at payment time.
//  4. A corporate-looking name is a review CLUE only, never an exemption; an
//     LLC name says nothing about corporate tax treatment.
//  5. A corporate exemption does NOT cover attorney fees, gross proceeds paid
//     to an attorney, or medical/health-care payments.
//  6. Payment-card / third-party-network payments are reported by the network
//     (Form 1099-K): decided from the PAYMENT's method, never the vendor.
//  7. Recording a payment that ALREADY happened is never blocked; it warns.
//  8. No override exists.
// ============================================================================

// Reporting categories (bill-level ap_invoices.tax_reporting_category, else the
// vendor default). Form + box for the record; threshold per category per year.
const CATEGORIES = {
  services:                { form: '1099-NEC', box: '1', label: 'nonemployee compensation (services)' },
  attorney_fees:           { form: '1099-NEC', box: '1', label: 'attorney fees for services' },
  attorney_gross_proceeds: { form: '1099-MISC', box: '10', label: 'gross proceeds paid to an attorney (IRC 6045(f))' },
  medical:                 { form: '1099-MISC', box: '6', label: 'medical and health care payments' },
  rents:                   { form: '1099-MISC', box: '1', label: 'rents' },
  other_income:            { form: '1099-MISC', box: '3', label: 'other income' },
};

// Year-aware thresholds, in cents, per category. Through 2025 everything here is
// $600. For payments made in 2026, the 6041/6041A thresholds (NEC services and
// attorney fees; MISC medical, rents, other income) are $2,000 (One Big
// Beautiful Bill Act, 2025), while gross proceeds paid to an attorney (6045(f))
// STAY $600. Later years are indexed and are NOT guessed: an unconfigured
// (category, year) has NO threshold (cents null, provisional). A disbursement
// that needs it is FLAGGED 'threshold_unconfigured' (never evaluated against
// last year's number) so the configuration gets fixed.
const THRESHOLDS = {
  services:                [{ from: 0, to: 2025, cents: 60000, basis: '$600 (payments made through 2025)' }, { from: 2026, to: 2026, cents: 200000, basis: '$2,000 (payments made in 2026)' }],
  attorney_fees:           [{ from: 0, to: 2025, cents: 60000, basis: '$600 (payments made through 2025)' }, { from: 2026, to: 2026, cents: 200000, basis: '$2,000 (attorney fees for services, 2026)' }],
  attorney_gross_proceeds: [{ from: 0, to: 2026, cents: 60000, basis: '$600 (gross proceeds paid to an attorney, IRC 6045(f), through 2026)' }],
  medical:                 [{ from: 0, to: 2025, cents: 60000, basis: '$600 (payments made through 2025)' }, { from: 2026, to: 2026, cents: 200000, basis: '$2,000 (medical/health care, 2026)' }],
  rents:                   [{ from: 0, to: 2025, cents: 60000, basis: '$600 (payments made through 2025)' }, { from: 2026, to: 2026, cents: 200000, basis: '$2,000 (rents, 2026)' }],
  other_income:            [{ from: 0, to: 2025, cents: 60000, basis: '$600 (payments made through 2025)' }, { from: 2026, to: 2026, cents: 200000, basis: '$2,000 (other income, 2026)' }],
};
function thresholdFor(year, category = 'services') {
  const y = Number(year);
  const rows = THRESHOLDS[category] || THRESHOLDS.services;
  const hit = rows.find((t) => y >= t.from && y <= t.to);
  if (hit) return { cents: hit.cents, basis: hit.basis, provisional: false };
  return { cents: null, basis: `the ${y} 1099 threshold for ${(CATEGORIES[category] || CATEGORIES.services).label} is not configured (indexed for inflation); confirm the amount and add it to lib/tax/info_reporting.js THRESHOLDS`, provisional: true };
}

// The vendor's default category when the bill does not carry its own.
function defaultCategory(v) {
  if (v && v.is_medical_provider) return 'medical';
  if (v && v.is_legal_counsel) return 'attorney_fees';
  return 'services';
}
// The category for one bill: its own (set on the bill) or the vendor default.
function categoryFor(invoiceCategory, vendor) {
  return CATEGORIES[invoiceCategory] ? invoiceCategory : defaultCategory(vendor);
}

// The reporting channel for a payment method (ap_payments.payment_method). The
// PAYMENT decides, not the vendor: a card payment to an attorney is still 1099-K.
const NETWORK_METHODS = new Set(['credit_card']);
function reportingChannel(method) {
  return NETWORK_METHODS.has(String(method || '').toLowerCase()) ? 'form_1099k_network' : 'form_1099_nec_misc';
}

// W-9 classifications the W-9 itself marks as corporate (lib/vendors/w9_extract).
const CORPORATE_CLASSES = new Set(['c_corporation', 's_corporation', 'llc_c', 'llc_s']);
// Categories a CORPORATE exemption does not cover.
const CORP_NOT_EXEMPT = new Set(['attorney_fees', 'attorney_gross_proceeds', 'medical']);

// Is this vendor reportable for this category? From stored data only.
// -> { reportable: bool, basis, exceptionApplied? }
function vendorReportability(v, category = defaultCategory(v)) {
  if (!v) return { reportable: true, basis: 'no vendor record' };
  // Genuine expense reimbursements are not 1099 income. kind = 'reimbursement'
  // is set only by the reimbursement flow (it links the person's contact), staff
  // edits cannot set it, and every change to it is audited (migration 477), so
  // relabeling compensation as a reimbursement leaves a trail.
  if (v.kind === 'reimbursement') return { reportable: false, basis: 'expense reimbursement payee (vendors.kind = reimbursement, set by the reimbursement flow)' };
  if (v.tax_reporting_status === 'exempt_verified') {
    const basis = v.tax_exemption_basis;
    if (basis === 'corporation' && CORP_NOT_EXEMPT.has(category)) {
      return { reportable: true, basis: `corporation, but ${(CATEGORIES[category] || {}).label} remain reportable`, exceptionApplied: true };
    }
    return { reportable: false, basis: `verified exempt: ${basis} (${v.tax_exemption_source}, ${v.tax_exemption_verified_by})` };
  }
  return { reportable: true, basis: v.tax_reporting_status === 'reportable' ? 'reportable' : 'not verified exempt' };
}

// A W-9 that satisfies the rule: on file AND a tax classification captured.
function w9Satisfied(v) { return !!(v && v.w9_on_file === true && v.tax_classification); }

// Classification CLUE from the name (review suggestion only, never an exemption).
const CORP_WORDS = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc)\b\.?/i;
function nameClue(name) {
  const n = String(name || '');
  if (/\b(p\.?\s*c|p\.?\s*l\.?\s*l\.?\s*c|l\.?\s*l\.?\s*p)\b\.?/i.test(n)) return 'name suggests a professional entity (P.C./PLLC/LLP): often a law or medical practice, whose payments stay reportable even as a corporation; get a W-9 and set the attorney/medical flag if it applies';
  if (/\bl\.?\s*l\.?\s*c\b\.?/i.test(n)) return 'name says LLC: that alone does not show corporate tax treatment; get a W-9';
  if (CORP_WORDS.test(n)) return 'name suggests a corporation: a clue only, verify with the W-9 (line 3) before treating as exempt';
  return null;
}

const usd = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The decision for ONE category of one payment (or projected payment).
// ctx: { vendor, year, category, priorReportableCents, paymentCents, method, initiation }
//   initiation: 'disburse' (Trusted pays: check run) | 'record' (already happened)
//              | 'approve' (bill approval; never blocks, projects ahead)
// -> { decision: 'allow'|'w9_needed'|'threshold_unconfigured', counts, category,
//      cumulative_after_cents, threshold_cents, reason }
function evaluatePayment(ctx) {
  const { vendor, year, priorReportableCents = 0, paymentCents = 0, method = 'check', initiation = 'record' } = ctx || {};
  const category = categoryFor(ctx && ctx.category, vendor);
  const threshold = thresholdFor(year, category);
  const channel = reportingChannel(method);
  const cat = CATEGORIES[category];
  const base = { category, form: cat.form, box: cat.box, threshold_cents: threshold.cents, threshold_basis: threshold.basis, threshold_provisional: threshold.provisional, channel, name_clue: nameClue(vendor && vendor.name) };
  if (channel === 'form_1099k_network') return { ...base, decision: 'allow', counts: false, cumulative_after_cents: priorReportableCents, reason: 'card / payment-network payment: reported by the network on 1099-K, not counted' };
  const rep = vendorReportability(vendor, category);
  if (!rep.reportable) return { ...base, decision: 'allow', counts: false, cumulative_after_cents: priorReportableCents, reason: `not reportable: ${rep.basis}` };
  const after = priorReportableCents + paymentCents;
  if (w9Satisfied(vendor)) return { ...base, decision: 'allow', counts: true, cumulative_after_cents: after, reason: 'W-9 with tax classification on file' };
  const who = (vendor && vendor.name) || 'This vendor';
  if (threshold.cents == null) {
    // No confirmed threshold for this (category, year): never evaluated against a guessed number.
    return { ...base, decision: 'threshold_unconfigured', counts: true, cumulative_after_cents: after, reason: `1099 threshold not configured: ${threshold.basis}. ${who} has no W-9 on file; get the W-9 and configure the threshold.` };
  }
  if (after < threshold.cents) return { ...base, decision: 'allow', counts: true, cumulative_after_cents: after, reason: `under the ${threshold.basis} threshold this year` };
  const msg = `${who} reaches $${usd(after)} in ${cat.label} (${cat.form} box ${cat.box}) from this association in ${year} (threshold ${threshold.basis}) and has no W-9 with a tax classification on file.`;
  const next = initiation === 'record' ? 'The payment is recorded; request the W-9 now.' : 'The payment can proceed; request the W-9 (Vendors → the vendor → W-9).';
  return { ...base, decision: 'w9_needed', counts: true, cumulative_after_cents: after, reason: `W-9 needed: ${msg} ${next}` };
}

// Several categories in one payment: evaluate each, return the most severe and
// all parts. parts: [{ category, cents }]; priorByCategory: { [category]: cents }.
const SEVERITY = { allow: 0, w9_needed: 1, threshold_unconfigured: 2 };
function evaluatePaymentParts({ vendor, year, parts, priorByCategory = {}, method = 'check', initiation = 'record' }) {
  const evals = (parts || []).map((p) => evaluatePayment({ vendor, year, category: p.category, priorReportableCents: priorByCategory[categoryFor(p.category, vendor)] || 0, paymentCents: p.cents, method, initiation }));
  const worst = evals.reduce((w, e) => (!w || SEVERITY[e.decision] > SEVERITY[w.decision] ? e : w), null) || { decision: 'allow', reason: 'nothing to evaluate' };
  return { ...worst, parts: evals };
}

// One vendor at one association for one year, from per-category totals (for the
// vendor list, spend report and 1099 worklist). A category is OVER when it is
// reportable for this vendor and at/over its year's threshold (an unconfigured
// threshold is never "over"; it is reported as provisional instead).
// -> { reportable_cents, over_threshold, needs_w9, provisional, categories: [...] }
function vendorYearStatus({ vendor, year, byCategory = {} }) {
  const categories = Object.entries(byCategory).map(([category, cents]) => {
    const t = thresholdFor(year, category);
    const rep = vendorReportability(vendor, category).reportable;
    return { category, cents, reportable: rep, threshold_cents: t.cents, provisional: t.provisional, over: rep && t.cents != null && cents >= t.cents };
  });
  const reportable_cents = categories.filter((c) => c.reportable).reduce((s, c) => s + c.cents, 0);
  const over_threshold = categories.some((c) => c.over);
  return { reportable_cents, over_threshold, needs_w9: over_threshold && !w9Satisfied(vendor), provisional: categories.some((c) => c.reportable && c.provisional), categories };
}

// A W-9 whose line-3 classification is corporate SUGGESTS a corporate exemption;
// a person confirms it (POST /api/vendors/:id/tax-exemption). Never automatic.
function suggestExemptionFromW9(classification) {
  return CORPORATE_CLASSES.has(String(classification || '').toLowerCase())
    ? { basis: 'corporation', source: 'w9_document', note: `W-9 line 3: ${classification}. Corporate exemption does not cover attorney fees, gross proceeds paid to an attorney, or medical/health-care payments.` }
    : null;
}

module.exports = { vendorYearStatus, suggestExemptionFromW9, thresholdFor, defaultCategory, categoryFor, reportingChannel, vendorReportability, w9Satisfied, nameClue, evaluatePayment, evaluatePaymentParts, CATEGORIES, THRESHOLDS, CORPORATE_CLASSES, CORP_NOT_EXEMPT };
