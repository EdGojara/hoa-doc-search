// ============================================================================
// lib/payments/assessment_checkout.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// The one way an assessment checkout is created. Callers pass ONLY a property
// they have already authorized (portal session, signed pay link, or a staff
// test route). Everything else is decided here, server-side:
//   * owner = the lot's current tenure (lib/payments/payment_identity.js)
//   * amount = that tenure's balance (a caller cannot supply an amount; only a
//     test-mode route may request a fixed test amount)
//   * mode gate: a Stripe TEST key only ever opens a session for the single
//     payment-sandbox lot; real homeowners need a LIVE key (checkoutModeGate)
//   * the payment group id is written to our ledger BEFORE the Stripe session
//     exists and travels in Stripe metadata, so every webhook finds its rows.
// Nothing is credited here. Crediting happens only when Stripe confirms the
// money (lib/payments/payment_lifecycle.js).
// ============================================================================
const crypto = require('crypto');
const { stripeMode } = require('./stripe_mode');
const { resolvePaymentIdentity } = require('./payment_identity');

// Mode gate (Ed 2026-09-27). Which lots may open a Stripe session, by the
// server's key:
//   test key -> ONLY the single payment_sandbox lot in a demo community. Real
//               homeowners (portal, pay link, staff test route) are refused, so a
//               test deployment can never open a session for a real owner.
//   live key -> real communities only; a sandbox/demo lot is refused.
// Runs before any payment row is written or any Stripe call is made.
function checkoutModeGate(mode, identity) {
  const sandbox = identity.property.payment_sandbox === true && identity.community.is_demo === true;
  if (mode === 'test' && !sandbox) {
    return { ok: false, status: 403, error: 'test_mode_sandbox_only', hint: 'Stripe is in test mode: online payment runs only on the designated payment sandbox lot.' };
  }
  if (mode === 'live' && (identity.property.payment_sandbox === true || identity.community.is_demo === true)) {
    return { ok: false, status: 403, error: 'sandbox_not_payable_live', hint: 'The payment sandbox and demo communities never take live payments.' };
  }
  if (mode !== 'test' && mode !== 'live') return { ok: false, status: 503, error: 'payment_not_configured' };
  return { ok: true };
}

// Card convenience fee: gross-up so the association nets the full assessment.
// POLICY KNOB, unchanged from the original: covers 2.9% + 30c.
function cardConvenienceFee(amountCents) {
  return Math.max(0, Math.round((amountCents + 30) / (1 - 0.029)) - amountCents);
}

async function createAssessmentCheckout(deps, opts) {
  const { supabase, stripeLib, key } = deps;
  const { propertyId, paymentMethod, initiatedBy, successUrl, cancelUrl, payer = {}, portalUserId = null, testAmountCents = null } = opts;
  const mode = stripeMode(key);
  if (!stripeLib.isConfigured() || mode === 'unconfigured') {
    return { ok: false, status: 503, error: 'payment_not_configured' };
  }
  if (!successUrl || !cancelUrl) return { ok: false, status: 400, error: 'success_url_and_cancel_url_required' };
  if (testAmountCents != null && mode !== 'test') {
    return { ok: false, status: 403, error: 'test_amount_requires_test_mode' };
  }
  const method = paymentMethod === 'card' ? 'card' : 'us_bank_account'; // ACH is the default rail

  const idr = await resolvePaymentIdentity(supabase, propertyId);
  if (!idr.ok) return idr;
  const { identity } = idr;
  const { community } = identity;
  const gate = checkoutModeGate(mode, identity);
  if (!gate.ok) {
    console.warn(`[checkout] refused by mode gate: ${gate.error} (mode=${mode}, property=${identity.property.id}, initiated_by=${initiatedBy})`);
    return gate;
  }
  if (!community.stripe_connected_account_id) {
    return { ok: false, status: 503, error: 'community_stripe_not_onboarded', hint: `${community.hoa_legal_name || community.name} hasn't completed Stripe onboarding.` };
  }

  const amount = testAmountCents != null ? Math.round(Number(testAmountCents)) : identity.balance_cents;
  if (!(amount > 0)) return { ok: false, status: 400, error: 'nothing_due', hint: 'Account balance is zero.' };
  const convFee = method === 'card' ? cardConvenienceFee(amount) : 0;

  const groupId = crypto.randomUUID();
  const common = {
    community_id: community.id, product_type: 'assessment_payment', product_id: identity.property.id,
    method: 'stripe_checkout', processor: 'stripe', status: 'pending', initiated_by: initiatedBy,
    payment_group_id: groupId, property_id: identity.property.id, tenure_id: identity.tenure.id,
    contact_id: identity.contact_id, trusted_account_number: identity.property.trusted_account_number,
    portal_user_id: portalUserId, payment_method_type: method, livemode: mode === 'live',
    settlement_state: 'awaiting_payment', posting_state: 'not_posted',
  };
  const fees = [{ label: `Assessment payment — ${community.name}`, amount_cents: amount, payee: 'community_association', fee_type: 'assessment' }];
  if (convFee > 0) fees.push({ label: 'Card convenience fee', amount_cents: convFee, payee: 'management_company', fee_type: 'convenience_fee' });
  const rows = fees.map((f) => ({
    ...common, fee_type: f.fee_type, payee: f.payee, amount_cents: f.amount_cents,
    payee_display_name: f.payee === 'community_association' ? (community.hoa_legal_name || community.name) : 'Bedrock Association Management',
    connected_account_id: f.payee === 'community_association' ? community.stripe_connected_account_id : null,
  }));
  const { error: insErr } = await supabase.from('payments').insert(rows);
  if (insErr) {
    console.error('[checkout] payment ledger insert failed:', insErr.message);
    return { ok: false, status: 500, error: 'payment_ledger_insert_failed' };
  }

  const session = await stripeLib.createCheckoutSession({
    fees,
    connectedAccountId: community.stripe_connected_account_id,
    customer: { email: payer.email || undefined, name: payer.name || undefined },
    reference: `ASMT-${identity.property.trusted_account_number}`,
    productType: 'assessment_payment',
    productId: identity.property.id,
    successUrl, cancelUrl,
    communityName: community.name,
    communityId: community.id,
    statementDescriptor: (community.slug || community.name || 'BEDROCK').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 22),
    paymentMethodTypes: [method],
    extraMetadata: {
      payment_group_id: groupId,
      tenure_id: identity.tenure.id,
      property_id: identity.property.id,
      trusted_account_number: identity.property.trusted_account_number,
      initiated_by: initiatedBy,
    },
  });
  if (!session.ok) {
    const { error: cfErr } = await supabase.from('payments')
      .update({ settlement_state: 'checkout_failed', status: 'cancelled', failure_reason: String(session.error || 'checkout_failed').slice(0, 300) })
      .eq('payment_group_id', groupId);
    if (cfErr) console.error('[checkout] could not mark failed checkout:', cfErr.message);
    return { ok: false, status: session.skipped ? 503 : 502, error: 'checkout_failed', stripeCode: session.stripeCode };
  }
  const { error: sidErr } = await supabase.from('payments').update({ processor_session_id: session.session_id }).eq('payment_group_id', groupId);
  if (sidErr) console.error('[checkout] session id not recorded (webhook will still match by group id):', sidErr.message);

  return { ok: true, checkout_url: session.checkout_url, session_id: session.session_id, payment_group_id: groupId,
    amount_cents: amount, convenience_fee_cents: convFee, method };
}

module.exports = { createAssessmentCheckout, cardConvenienceFee, checkoutModeGate };
