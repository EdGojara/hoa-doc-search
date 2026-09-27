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
//   * Trusted Pay terms: quoteAssessmentPayment() returns the exact Amount,
//     Payment Processing Fee and Total (lib/payments/pay_quote.js) with a signed
//     quote token; createAssessmentCheckout() requires an explicit acceptance of
//     the current terms plus that token, refuses if anything material changed,
//     and records the acceptance (payment_terms_acceptances) BEFORE any Stripe
//     session exists
//   * the payment group id is written to our ledger BEFORE the Stripe session
//     exists and travels in Stripe metadata, so every webhook finds its rows.
// Nothing is credited here. Crediting happens only when Stripe confirms the
// money (lib/payments/payment_lifecycle.js).
// ============================================================================
const crypto = require('crypto');
const { stripeMode } = require('./stripe_mode');
const { resolvePaymentIdentity } = require('./payment_identity');
const { paymentProcessingFee, quoteFor, signQuote, verifyQuote, FEE_LABEL } = require('./pay_quote');
const { getTerms } = require('./pay_terms');

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

// Kept for callers of the old name; the policy lives in pay_quote.js.
const cardConvenienceFee = (amountCents) => paymentProcessingFee('card', amountCents);

// Identity + every gate + the server-side amount. No writes, no Stripe calls.
async function prepareAssessmentPayment(deps, { propertyId, testAmountCents = null, initiatedBy = null }) {
  const { supabase, stripeLib, key } = deps;
  const mode = stripeMode(key);
  if (!stripeLib.isConfigured() || mode === 'unconfigured') return { ok: false, status: 503, error: 'payment_not_configured' };
  if (testAmountCents != null && mode !== 'test') return { ok: false, status: 403, error: 'test_amount_requires_test_mode' };
  const idr = await resolvePaymentIdentity(supabase, propertyId);
  if (!idr.ok) return idr;
  const { identity } = idr;
  const gate = checkoutModeGate(mode, identity);
  if (!gate.ok) {
    console.warn(`[checkout] refused by mode gate: ${gate.error} (mode=${mode}, property=${identity.property.id}, initiated_by=${initiatedBy})`);
    return gate;
  }
  if (!identity.community.stripe_connected_account_id) {
    return { ok: false, status: 503, error: 'community_stripe_not_onboarded', hint: `${identity.community.hoa_legal_name || identity.community.name} hasn't completed Stripe onboarding.` };
  }
  const amount = testAmountCents != null ? Math.round(Number(testAmountCents)) : identity.balance_cents;
  if (!(amount > 0)) return { ok: false, status: 400, error: 'nothing_due', hint: 'Account balance is zero.' };
  return { ok: true, mode, identity, amount };
}

// Read-only quote for BOTH methods, each with its own signed token. `actor`
// binds the quote to who is paying: 'portal:<portal_user_id>',
// 'link:<tenure_id>' or 'staff:<email>'.
async function quoteAssessmentPayment(deps, { propertyId, actor, testAmountCents = null, initiatedBy = null }) {
  if (!actor) return { ok: false, status: 400, error: 'actor_required' };
  const prep = await prepareAssessmentPayment(deps, { propertyId, testAmountCents, initiatedBy });
  if (!prep.ok) return prep;
  const terms = getTerms();
  const options = ['us_bank_account', 'card'].map((m) => {
    const q = quoteFor(m, prep.amount);
    const { token, expires_at } = signQuote({ actor, propertyId: prep.identity.property.id, tenureId: prep.identity.tenure.id, quote: q, terms });
    return { ...q, quote_token: token, expires_at };
  });
  return { ok: true, property_label: prep.identity.property.street_address, community_name: prep.identity.community.name,
    terms: { version: terms.version, url: terms.path }, options };
}

const ACTOR_TYPES = { homeowner_portal: 'homeowner', payment_link: 'payment_link', staff_test: 'staff_test' };
const SOURCES = { homeowner_portal: 'portal', payment_link: 'pay_link', staff_test: 'staff_test' };

// opts.acceptance = { accepted: true, quoteToken, actor, actorLabel?, source }
// (No IP or user-agent is recorded: not an existing pattern here, and not needed.)
async function createAssessmentCheckout(deps, opts) {
  const { supabase, stripeLib } = deps;
  const { propertyId, paymentMethod, initiatedBy, successUrl, cancelUrl, payer = {}, portalUserId = null, testAmountCents = null, acceptance = null } = opts;
  if (!successUrl || !cancelUrl) return { ok: false, status: 400, error: 'success_url_and_cancel_url_required' };
  // Terms first: nothing is looked up, written or sent without an explicit acceptance.
  if (!acceptance || acceptance.accepted !== true) {
    return { ok: false, status: 400, error: 'terms_not_accepted', hint: 'Review the payment and accept the Trusted Pay Payment Terms and Conditions to continue.' };
  }
  const vq = verifyQuote(acceptance.quoteToken);
  if (!vq.ok) return { ok: false, status: 409, error: vq.error, hint: 'Please review the payment again.' };
  const q = vq.payload;
  const method = paymentMethod === 'card' ? 'card' : 'us_bank_account';

  const prep = await prepareAssessmentPayment(deps, { propertyId, testAmountCents, initiatedBy });
  if (!prep.ok) return prep;
  const { identity, amount, mode } = prep;
  const { community } = identity;
  const terms = getTerms();
  const now = quoteFor(method, amount);
  // The acceptance covers exactly what was reviewed. Anything material changed -> review again.
  const mismatch = [
    q.a !== acceptance.actor && 'payer', q.p !== identity.property.id && 'property', q.t !== identity.tenure.id && 'owner',
    q.m !== method && 'payment method', q.amt !== now.amount_cents && 'amount', q.fee !== now.payment_processing_fee_cents && 'fee',
    q.tot !== now.total_cents && 'total', (q.tv !== terms.version || q.ts !== terms.sha256) && 'terms',
  ].filter(Boolean);
  if (mismatch.length) {
    return { ok: false, status: 409, error: mismatch.includes('terms') ? 'terms_changed' : 'quote_mismatch', detail: mismatch.join(', '), hint: 'Something changed since you reviewed this payment. Please review it again.' };
  }
  const fee = now.payment_processing_fee_cents;

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
  // One homeowner-facing label. Internally the fee stays its own line (payee: the
  // management company), so processor cost and margin can be accounted separately.
  if (fee > 0) fees.push({ label: FEE_LABEL, amount_cents: fee, payee: 'management_company', fee_type: 'convenience_fee' });
  const rows = fees.map((f) => ({
    ...common, fee_type: f.fee_type, payee: f.payee, amount_cents: f.amount_cents,
    payee_display_name: f.payee === 'community_association' ? (community.hoa_legal_name || community.name) : 'Bedrock Association Management',
    connected_account_id: f.payee === 'community_association' ? community.stripe_connected_account_id : null,
  }));
  const failGroup = async (reason) => {
    const { error } = await supabase.from('payments')
      .update({ settlement_state: 'checkout_failed', status: 'cancelled', failure_reason: String(reason).slice(0, 300) }).eq('payment_group_id', groupId);
    if (error) console.error('[checkout] could not mark failed checkout:', error.message);
  };
  const { error: insErr } = await supabase.from('payments').insert(rows);
  if (insErr) {
    console.error('[checkout] payment ledger insert failed:', insErr.message);
    return { ok: false, status: 500, error: 'payment_ledger_insert_failed' };
  }

  // Record the acceptance before Stripe is contacted. No record -> no session.
  const { error: accErr } = await supabase.from('payment_terms_acceptances').insert({
    payment_group_id: groupId, community_id: community.id, property_id: identity.property.id, tenure_id: identity.tenure.id,
    portal_user_id: portalUserId, actor_type: ACTOR_TYPES[initiatedBy] || 'homeowner', actor_label: acceptance.actorLabel || null,
    source: SOURCES[initiatedBy] || acceptance.source, payment_method: method,
    amount_cents: amount, fee_cents: fee, total_cents: amount + fee,
    terms_version: terms.version, terms_sha256: terms.sha256, quote_issued_at: new Date(q.iat * 1000).toISOString(),
  });
  if (accErr) {
    console.error('[checkout] terms acceptance record failed:', accErr.message);
    await failGroup('terms acceptance not recorded');
    return { ok: false, status: 500, error: 'terms_record_failed' };
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
      terms_version: terms.version,
    },
  });
  if (!session.ok) {
    await failGroup(session.error || 'checkout_failed');
    return { ok: false, status: session.skipped ? 503 : 502, error: 'checkout_failed', stripeCode: session.stripeCode };
  }
  const { error: sidErr } = await supabase.from('payments').update({ processor_session_id: session.session_id }).eq('payment_group_id', groupId);
  if (sidErr) console.error('[checkout] session id not recorded (webhook will still match by group id):', sidErr.message);

  // Homeowner-safe response: the three reviewed totals only.
  return { ok: true, checkout_url: session.checkout_url, session_id: session.session_id, payment_group_id: groupId,
    amount_cents: amount, payment_processing_fee_cents: fee, total_cents: amount + fee, method };
}

module.exports = { createAssessmentCheckout, quoteAssessmentPayment, prepareAssessmentPayment, cardConvenienceFee, checkoutModeGate };
