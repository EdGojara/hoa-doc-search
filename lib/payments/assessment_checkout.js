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
//   * readiness (Ed 2026-10-16): refused unless paymentsReadyFor() says the
//     community can take money now (switch on, financials active, connected
//     account verified with Stripe in this key's mode, charges + payouts on).
//   * one in flight (Ed 2026-10-16): ACH sits 'processing' for days and the
//     balance does not drop until it settles, so a second Pay click used to open
//     a second checkout for the full balance. While a payment for this lot and
//     owner is processing, checkout refuses (409 payment_processing, with the
//     amount). An open, identical checkout is handed back instead of a new one;
//     a different one is expired first. A unique index (migration 534) stops two
//     simultaneous clicks, and the Stripe call carries an idempotency key.
// Nothing is credited here. Crediting happens only when Stripe confirms the
// money (lib/payments/payment_lifecycle.js).
// ============================================================================
const crypto = require('crypto');
const { stripeMode } = require('./stripe_mode');
const { resolvePaymentIdentity } = require('./payment_identity');
const { paymentsReadyFor, inFlightAssessmentPayments } = require('./payment_readiness');

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
  const ready = await paymentsReadyFor(community.id, { supabase, stripeLib, key, verify: true, evaluate: deps.evaluate });
  if (!ready.ready) {
    console.warn(`[checkout] refused by readiness: ${ready.reason} (mode=${mode}, community=${community.id}, initiated_by=${initiatedBy})`);
    return { ok: false, status: ready.reason === 'payment_not_configured' ? 503 : 409, error: ready.reason, hint: ready.message };
  }

  const amount = testAmountCents != null ? Math.round(Number(testAmountCents)) : identity.balance_cents;
  const convFee = method === 'card' ? cardConvenienceFee(amount) : 0;

  const inflight = await resolveInFlight({ supabase, stripeLib }, identity, { amount, convFee, method });
  if (inflight) return inflight;
  if (!(amount > 0)) return { ok: false, status: 400, error: 'nothing_due', hint: 'Account balance is zero.' };

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
  if (insErr && (insErr.code === '23505' || /uq_payments_assessment_in_flight/.test(insErr.message || ''))) {
    // Another click won the race for this lot and owner (migration 534).
    return { ok: false, status: 409, error: 'checkout_in_progress', hint: 'A payment for this account was just started. Please wait a moment and refresh.' };
  }
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
    // One payment group = at most one Stripe session, even if this call is retried.
    idempotencyKey: `asmt-checkout-${groupId}`,
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

// What to do about checkouts already in flight for this lot + owner tenure.
// Returns a response to send instead of a new checkout, or null to go ahead.
//   processing             -> refuse: money is on its way (409 payment_processing)
//   awaiting, past 24h     -> the session cannot be paid any more: mark expired
//   awaiting, open, same   -> hand back the same checkout (no second session)
//   awaiting, open, differs-> expire it at Stripe, mark expired, go ahead
//   awaiting, complete     -> Stripe has it; the webhook is on its way: refuse
//   awaiting, unknown      -> refuse rather than risk two live sessions
async function resolveInFlight({ supabase, stripeLib }, identity, { amount, convFee, method }) {
  const groups = await inFlightAssessmentPayments(supabase, { propertyId: identity.property.id, tenureId: identity.tenure.id });
  const markExpired = async (g, why) => {
    const { error } = await supabase.rpc('payment_mark_failed', { p_group: g.payment_group_id, p_session: g.session_id, p_payment_intent: null, p_terminal: 'expired', p_reason: why });
    if (error) throw new Error(`[checkout] could not expire stale checkout ${g.payment_group_id}: ${error.message}`);
  };
  const processingRefusal = (g) => ({ ok: false, status: 409, error: 'payment_processing', pending_amount_cents: g.assessment_cents, pending_since: g.created_at,
    hint: `A payment of $${(g.assessment_cents / 100).toFixed(2)} is already processing for this account. Bank payments take a few business days to clear; your balance updates when it does.` });

  for (const g of groups) {
    if (g.settlement_state === 'processing') return processingRefusal(g);
  }
  for (const g of groups) {
    if (g.stale) { await markExpired(g, 'checkout session past Stripe maximum lifetime'); continue; }
    const got = g.session_id && typeof stripeLib.retrieveSession === 'function' ? await stripeLib.retrieveSession(g.session_id) : null;
    const sess = got && got.ok ? got.session : null;
    if (!sess) {
      return { ok: false, status: 409, error: 'checkout_in_progress', hint: 'A payment for this account was started in the last day. Finish it or try again later.' };
    }
    if (sess.status === 'expired') { await markExpired(g, 'checkout session expired'); continue; }
    if (sess.status === 'complete') return processingRefusal(g);
    // status 'open'
    const same = g.method === method && g.assessment_cents === amount && g.amount_cents === amount + convFee;
    if (same && sess.url) {
      return { ok: true, reused: true, checkout_url: sess.url, session_id: sess.id, payment_group_id: g.payment_group_id,
        amount_cents: g.assessment_cents, convenience_fee_cents: g.amount_cents - g.assessment_cents, method: g.method };
    }
    const ex = typeof stripeLib.expireCheckoutSession === 'function'
      ? await stripeLib.expireCheckoutSession(sess.id, { idempotencyKey: `asmt-expire-${g.payment_group_id}` }) : { ok: false };
    if (!ex.ok) {
      return { ok: false, status: 409, error: 'checkout_in_progress', hint: 'A payment for this account is already open. Finish it or try again later.' };
    }
    await markExpired(g, 'replaced by a new checkout');
  }
  return null;
}

module.exports = { createAssessmentCheckout, cardConvenienceFee, checkoutModeGate, resolveInFlight };
