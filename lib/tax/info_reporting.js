// ============================================================================
// lib/tax/info_reporting.js  (Issue #14, Ed 2026-10-02): 1099 W-9 compliance
// ----------------------------------------------------------------------------
// Ed's 2026 rule, encoded as pure functions (no I/O):
//  1. Recognizing a bill (vendor creation, accrual, approval) is NEVER blocked
//     by a missing W-9.
//  2. Track cumulative REPORTABLE payments per vendor, per payer (each
//     association is its own 1099 filer / EIN), per calendar year. The payment
//     Trusted would DISBURSE that brings the total to the year's threshold or
//     more requires a W-9 with a tax classification first, when the vendor is
//     potentially reportable.
//  3. A vendor is non-reportable only by STORED vendor-master data with
//     provenance (tax_reporting_status = 'exempt_verified' + basis + source +
//     who/when), never guessed at payment time.
//  4. A corporate-looking name is a review CLUE only, never an exemption; an
//     LLC name says nothing about corporate tax treatment.
//  5. Attorney and medical/health-care payments stay reportable even to a
//     corporation (corporate exemption does not cover them).
//  6. Payment-card / third-party-network payments are reported by the network
//     (Form 1099-K), not on 1099-NEC/MISC: they do not count toward the total.
//  7. Recording a payment that ALREADY happened (a vendor auto-draft, a payment
//     made outside a check run) is never blocked: Trusted must always be able
//     to record real bank activity. It warns instead.
//  8. No override exists.
// ============================================================================

// Year-aware 1099-NEC/MISC threshold, in cents. Through 2025: $600. For
// payments made in 2026: $2,000 (One Big Beautiful Bill Act, 2025). Later years
// are indexed for inflation and are NOT guessed: an unconfigured year has NO
// threshold (cents null, provisional). A disbursement that needs the threshold
// in such a year is a CONFIGURATION exception, never a hard block on last
// year's number (Ed 2026-10-02); recording/approval warn.
const THRESHOLDS = [
  { from: 0, to: 2025, cents: 60000, basis: '$600 (payments made through 2025)' },
  { from: 2026, to: 2026, cents: 200000, basis: '$2,000 (payments made in 2026)' },
];
function thresholdFor(year) {
  const y = Number(year);
  const hit = THRESHOLDS.find((t) => y >= t.from && y <= t.to);
  if (hit) return { cents: hit.cents, basis: hit.basis, provisional: false };
  return { cents: null, basis: `the ${y} 1099 threshold is not configured (indexed for inflation after 2026); confirm the amount and add it to lib/tax/info_reporting.js THRESHOLDS`, provisional: true };
}

// The reporting channel for a payment method (ap_payments.payment_method).
const NETWORK_METHODS = new Set(['credit_card']);
function reportingChannel(method) {
  return NETWORK_METHODS.has(String(method || '').toLowerCase()) ? 'form_1099k_network' : 'form_1099_nec_misc';
}

// W-9 classifications the W-9 itself marks as corporate (lib/vendors/w9_extract).
const CORPORATE_CLASSES = new Set(['c_corporation', 's_corporation', 'llc_c', 'llc_s']);

// Is this vendor potentially reportable? From stored data only.
// -> { reportable: bool, basis, exceptionApplied? }
function vendorReportability(v) {
  if (!v) return { reportable: true, basis: 'no vendor record' };
  // Genuine expense reimbursements are not 1099 income. kind = 'reimbursement'
  // is set only by the reimbursement flow (it links the person's contact), staff
  // edits cannot set it, and every change to it is audited (migration 477), so
  // relabeling compensation as a reimbursement leaves a trail.
  if (v.kind === 'reimbursement') return { reportable: false, basis: 'expense reimbursement payee (vendors.kind = reimbursement, set by the reimbursement flow)' };
  if (v.tax_reporting_status === 'exempt_verified') {
    const basis = v.tax_exemption_basis;
    // Corporate exemption does not cover attorney or medical/health-care payments.
    if (basis === 'corporation' && (v.is_legal_counsel || v.is_medical_provider)) {
      return { reportable: true, basis: `corporation, but ${v.is_legal_counsel ? 'attorney' : 'medical/health-care'} payments remain reportable`, exceptionApplied: true };
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

// The decision for ONE payment (or one projected payment).
// ctx: { vendor, year, priorReportableCents, paymentCents, method, initiation }
//   initiation: 'disburse' (Trusted pays: check run) | 'record' (already happened)
//              | 'approve' (bill approval; never blocks, projects ahead)
// -> { decision: 'allow'|'warn'|'block', counts, cumulative_after_cents, threshold, reason }
function evaluatePayment(ctx) {
  const { vendor, year, priorReportableCents = 0, paymentCents = 0, method = 'check', initiation = 'record' } = ctx || {};
  const threshold = thresholdFor(year);
  const channel = reportingChannel(method);
  const base = { threshold_cents: threshold.cents, threshold_basis: threshold.basis, threshold_provisional: threshold.provisional, channel, name_clue: nameClue(vendor && vendor.name) };
  if (channel === 'form_1099k_network') return { ...base, decision: 'allow', counts: false, cumulative_after_cents: priorReportableCents, reason: 'card / payment-network payment: reported by the network on 1099-K, not counted' };
  const rep = vendorReportability(vendor);
  if (!rep.reportable) return { ...base, decision: 'allow', counts: false, cumulative_after_cents: priorReportableCents, reason: `not reportable: ${rep.basis}` };
  const after = priorReportableCents + paymentCents;
  if (w9Satisfied(vendor)) return { ...base, decision: 'allow', counts: true, cumulative_after_cents: after, reason: 'W-9 with tax classification on file' };
  const who = (vendor && vendor.name) || 'This vendor';
  if (threshold.cents == null) {
    // No confirmed threshold for this year: never hard-block on a guessed number.
    if (initiation === 'disburse') return { ...base, decision: 'config_exception', counts: true, cumulative_after_cents: after, reason: `Cannot evaluate the 1099 W-9 requirement for ${who}: ${threshold.basis}. Get the vendor's W-9 or configure the threshold before this payment.` };
    return { ...base, decision: 'warn', counts: true, cumulative_after_cents: after, reason: `${threshold.basis}; ${who} has no W-9 on file.` };
  }
  if (after < threshold.cents) return { ...base, decision: 'allow', counts: true, cumulative_after_cents: after, reason: `under the ${threshold.basis} threshold this year` };
  const usd = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const msg = `${who} reaches $${usd(after)} in reportable payments from this association in ${year} (threshold ${threshold.basis}) and has no W-9 with a tax classification on file.`;
  if (initiation === 'disburse') return { ...base, decision: 'block', counts: true, cumulative_after_cents: after, reason: `${msg} Get the W-9 (Vendors → the vendor → W-9) before this payment is made.` };
  if (initiation === 'approve') return { ...base, decision: 'warn', counts: true, cumulative_after_cents: after, reason: `${msg} Approval is recorded; the payment itself will need the W-9 first.` };
  return { ...base, decision: 'warn', counts: true, cumulative_after_cents: after, reason: `${msg} The payment is recorded (it already happened); request the W-9 now.` };
}

// A W-9 whose line-3 classification is corporate SUGGESTS a corporate exemption;
// a person confirms it (POST /api/vendors/:id/tax-exemption). Never automatic.
function suggestExemptionFromW9(classification) {
  return CORPORATE_CLASSES.has(String(classification || '').toLowerCase())
    ? { basis: 'corporation', source: 'w9_document', note: `W-9 line 3: ${classification}. Corporate exemption does not cover attorney or medical/health-care payments.` }
    : null;
}

module.exports = { suggestExemptionFromW9, thresholdFor, reportingChannel, vendorReportability, w9Satisfied, nameClue, evaluatePayment, THRESHOLDS, CORPORATE_CLASSES };
