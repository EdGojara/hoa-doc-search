// ============================================================================
// lib/payments/live_verification.js  (Ed 2026-11-27, live activation E2)
// ----------------------------------------------------------------------------
// The owner's live $1.00 verification payment on a lot he picks, before an
// association's online payments are opened to homeowners.
//
// It is an ordinary assessment payment in every way that matters, so it proves
// the real chain: the same gates (resolvePayableAssessment: identity, legal
// hold, Stripe mode, connected account exists in this mode and takes charges),
// the same fee rules (the association's saved fee schedule, fail-closed), the
// same destination-charge PaymentIntent, and the same webhook settlement and
// GL posting. Differences, all enforced on the server:
//   * owner only (requireOwner on the route), audit-logged on every step
//   * the amount is fixed at $1.00, whatever the lot owes
//   * it runs before the homeowner payments switch is on (that is its purpose);
//     every other gate still applies
//   * demo lots are refused under a live key; under a test key only the
//     payment-sandbox lot is accepted (checkoutModeGate)
//   * once Stripe confirms it, the webhook refunds it through the normal refund
//     path (payment_store.refundLiveVerification -> refund_payment.js), and
//     charge.refunded reverses the ledger, so the lot nets to zero
// ============================================================================
'use strict';

const { LIVE_VERIFICATION_INITIATOR, LIVE_VERIFICATION_CENTS } = require('./assessment_checkout');
const STEPS = ['setup', 'quote', 'confirm'];

async function runVerificationStep(deps, step, { propertyId, paymentMethodId, quoteToken, returnUrl, mandate, ownerEmail }) {
  if (!STEPS.includes(step)) return { ok: false, status: 404, error: 'unknown_step' };
  if (!propertyId) return { ok: false, status: 400, error: 'property_id_required' };
  const AI = require('./assessment_intent');
  const common = { propertyId: String(propertyId), initiatedBy: LIVE_VERIFICATION_INITIATOR };
  let r;
  if (step === 'setup') r = await AI.setupAssessmentPayment(deps, common);
  else if (step === 'quote') r = await AI.quoteAssessmentPayment(deps, { ...common, paymentMethodId: String(paymentMethodId || '') });
  else r = await AI.confirmAssessmentPayment(deps, { ...common, paymentMethodId: String(paymentMethodId || ''), quoteToken: String(quoteToken || ''), returnUrl, mandate });
  if (step !== 'quote') {
    const notes = step === 'setup'
      ? (r.ok ? `setup ok (${r.mode}); amount ${r.assessment_cents}` : `setup refused: ${r.error}`)
      : (r.ok ? `confirm ${r.status || 'ok'}; group ${r.group_id || '?'}; total ${r.quote ? r.quote.total_cents : '?'}` : `confirm refused: ${r.error}`);
    await auditStep(deps.supabase, `live_verification_${step}`, propertyId, ownerEmail, notes);
  }
  return r;
}

async function auditStep(supabase, action, propertyId, ownerEmail, notes) {
  try {
    const { error } = await supabase.from('portal_audit_log').insert({
      action, resource_type: 'property', resource_id: propertyId, performed_by: ownerEmail || 'owner', notes,
    });
    if (error) console.warn(`[live_verification] audit ${action} not recorded: ${error.message}`);
  } catch (e) { console.warn(`[live_verification] audit ${action} threw: ${e.message}`); }
}

module.exports = { runVerificationStep, STEPS, LIVE_VERIFICATION_CENTS };
