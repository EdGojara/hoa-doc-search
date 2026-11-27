// ============================================================================
// lib/payments/payment_lifecycle.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// What each Stripe event does to a payment. Pure orchestration over a `store`
// (lib/payments/payment_store.js in production, a fake in tests), so every rule
// below is testable without Stripe or a database.
//
// Rules:
//   * Every event is claimed once in stripe_events. Already processed -> 200 and
//     nothing happens. Being processed right now -> 409 so Stripe retries later.
//   * A handler error marks the event failed and returns 500, so Stripe retries.
//     A retry re-enters the same idempotent steps and can never credit twice.
//   * Card: credited only when the session reports payment_status 'paid'.
//   * ACH: a completed-but-unpaid session only moves to 'processing'. Credit
//     happens on checkout.session.async_payment_succeeded, never before.
//     async_payment_failed marks it failed; nothing was ever credited.
//   * A declined card inside Checkout is only an attempt: the homeowner can
//     retry on the same page, so payment_intent.payment_failed changes nothing.
//   * Refunds and disputes reverse through one controlled path: a separate
//     dated reversal row (refund / chargeback); the original payment stays on
//     the ledger. Only a FULL reversal is automatic; partials are flagged.
//   * Funding-aware flow (lib/payments/assessment_intent.js, PaymentIntents with
//     metadata.payment_flow 'payment_element', or 'autopay' for an automatic
//     payment, no Checkout session):
//       payment_intent.succeeded  -> settle + post, by metadata.payment_group_id
//       payment_intent.processing -> processing (ACH); nothing credited
//       payment_intent.payment_failed on a bank (ACH) payment -> failed (terminal)
//       payment_intent.payment_failed on a card -> only an attempt (as above)
//       payment_intent.canceled   -> failed
//     A Checkout-created PaymentIntent has no payment_flow and settles ONLY
//     through its checkout.session.* events, so its payment_intent.* events never
//     settle it a second time.
//   * An event whose livemode does not match the server's key is ignored loudly.
// ============================================================================

function centralDate(epochSeconds) {
  const d = epochSeconds ? new Date(epochSeconds * 1000) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const meta = (o) => (o && o.metadata) || {};
const groupOf = (o) => meta(o).payment_group_id || null;
// A PaymentIntent we created server-side (not from Checkout): the one-time
// funding-aware flow ('payment_element') or an autopay charge ('autopay'). Both
// settle and post the same way.
const DIRECT_FLOWS = ['payment_element', 'autopay'];
const isDirectAssessment = (pi) => meta(pi).product_type === 'assessment_payment' && DIRECT_FLOWS.includes(meta(pi).payment_flow);
const piIsBank = (pi) => (pi.payment_method_types || []).includes('us_bank_account')
  || !!(pi.last_payment_error && pi.last_payment_error.payment_method && pi.last_payment_error.payment_method.type === 'us_bank_account');
const ref = (session) => ({ group: groupOf(session), session: session.id, paymentIntent: session.payment_intent || null, charge: null });

// Handle one verified event. Returns an outcome object; throws on error.
async function handleStripeEvent(event, { store, mode, log = console }) {
  const obj = (event.data && event.data.object) || {};
  const expectLive = mode === 'live';
  if (typeof event.livemode === 'boolean' && event.livemode !== expectLive) {
    log.error(`[payments] ${event.type} ${event.id}: livemode=${event.livemode} but server key is ${mode}; ignored`);
    return { status: 'ignored', outcome: { reason: 'livemode_mismatch' } };
  }
  const paymentDate = centralDate(event.created);

  switch (event.type) {
    case 'checkout.session.completed': {
      if (meta(obj).product_type !== 'assessment_payment') {
        await store.legacyCheckoutCompleted(obj, event.id);
        return { status: 'processed', outcome: { legacy: meta(obj).product_type || 'unknown' } };
      }
      if (obj.payment_status === 'paid') return settleAndPost(store, ref(obj), paymentDate);
      if (obj.payment_status === 'unpaid') {
        const r = await store.markProcessing({ group: groupOf(obj), session: obj.id, paymentIntent: obj.payment_intent || null });
        return { status: 'processed', outcome: r };
      }
      return { status: 'ignored', outcome: { reason: `payment_status ${obj.payment_status}` } };
    }
    case 'checkout.session.async_payment_succeeded':
      if (meta(obj).product_type !== 'assessment_payment') return { status: 'ignored', outcome: { reason: 'not an assessment' } };
      return settleAndPost(store, ref(obj), paymentDate);
    case 'checkout.session.async_payment_failed': {
      if (meta(obj).product_type !== 'assessment_payment') return { status: 'ignored', outcome: { reason: 'not an assessment' } };
      const r = await store.markFailed({ group: groupOf(obj), session: obj.id, paymentIntent: obj.payment_intent || null, terminal: 'failed', reason: 'bank payment failed' });
      return { status: 'processed', outcome: r };
    }
    case 'checkout.session.expired': {
      if (meta(obj).product_type !== 'assessment_payment') return { status: 'ignored', outcome: { reason: 'not an assessment' } };
      const r = await store.markFailed({ group: groupOf(obj), session: obj.id, paymentIntent: null, terminal: 'expired', reason: 'checkout expired' });
      return { status: 'processed', outcome: r };
    }
    case 'payment_intent.succeeded': {
      if (!isDirectAssessment(obj)) return { status: 'ignored', outcome: { reason: meta(obj).product_type === 'assessment_payment' ? 'checkout payment settles on its session events' : 'not a direct assessment payment' } };
      const r = await settleAndPost(store, { group: groupOf(obj), session: null, paymentIntent: obj.id, charge: obj.latest_charge || null }, paymentDate);
      // Owner's live $1 verification: settled and posted like any payment, then
      // refunded at once through the normal refund path (charge.refunded then
      // reverses the ledger). Runs on a redelivery too; the store is idempotent.
      if (meta(obj).initiated_by === 'live_verification') {
        const refund = await store.refundLiveVerification({ group: groupOf(obj), paymentIntent: obj.id });
        return { ...r, outcome: { ...(r.outcome || {}), verification_refund: refund } };
      }
      return r;
    }
    case 'payment_intent.processing': {
      if (!isDirectAssessment(obj)) return { status: 'ignored', outcome: { reason: 'not a direct assessment payment' } };
      const r = await store.markProcessing({ group: groupOf(obj), session: null, paymentIntent: obj.id });
      return { status: 'processed', outcome: r };
    }
    case 'payment_intent.canceled': {
      if (!isDirectAssessment(obj)) return { status: 'ignored', outcome: { reason: 'not a direct assessment payment' } };
      const r = await store.markFailed({ group: groupOf(obj), session: null, paymentIntent: obj.id, terminal: 'failed', reason: `payment cancelled (${obj.cancellation_reason || 'no reason'})` });
      return { status: 'processed', outcome: r };
    }
    case 'payment_intent.payment_failed': {
      // Funding-aware flow, bank payment: an ACH debit that fails after
      // processing is terminal (the money did not arrive).
      if (isDirectAssessment(obj) && piIsBank(obj)) {
        const r = await store.markFailed({ group: groupOf(obj), session: null, paymentIntent: obj.id, terminal: 'failed',
          reason: (obj.last_payment_error && obj.last_payment_error.message) || 'bank payment failed' });
        return { status: 'processed', outcome: r };
      }
      // A declined attempt inside Stripe Checkout is not the end of the payment:
      // the homeowner can try another card on the same page. Terminal outcomes
      // for an assessment come only from the session (expired, async failed).
      // Marking the group failed here sent a successful retry to review (G1,
      // Ed 2026-11-21). The decline reason stays on the event's outcome.
      if (meta(obj).product_type === 'assessment_payment') {
        return { status: 'processed', outcome: { action: 'attempt_failed', group: groupOf(obj),
          reason: (obj.last_payment_error && obj.last_payment_error.message) || 'payment failed' } };
      }
      const r = await store.markFailed({ group: groupOf(obj), session: null, paymentIntent: obj.id, terminal: 'failed',
        reason: (obj.last_payment_error && obj.last_payment_error.message) || 'payment failed' });
      if (r.action === 'unknown' || r.action === 'legacy') await store.legacyPaymentFailed(obj, event.id);
      return { status: 'processed', outcome: r };
    }
    case 'charge.refunded': {
      const payment = await store.findAssessmentByIntent(obj.payment_intent);
      if (!payment) { await store.legacyChargeRefunded(obj, event.id); return { status: 'processed', outcome: { legacy: true } }; }
      const full = obj.refunded === true && Number(obj.amount_refunded) === Number(obj.amount);
      if (!full) {
        await store.flagReview(payment.id, `Partial refund ${obj.amount_refunded} of ${obj.amount} cents on ${obj.id}; not reversed automatically`);
        return { status: 'processed', outcome: { action: 'review', payment_id: payment.id } };
      }
      const r = await store.reversePayment(payment.id, { kind: 'refund', reason: `refund ${obj.id}`, reversalDate: paymentDate });
      return { status: 'processed', outcome: r };
    }
    case 'charge.dispute.created': {
      const payment = await store.findAssessmentByIntent(obj.payment_intent);
      if (!payment) return { status: 'ignored', outcome: { reason: 'no assessment payment for this dispute' } };
      if (Number(obj.amount) !== Number(payment.group_total_cents)) {
        await store.flagReview(payment.id, `Dispute ${obj.id} for ${obj.amount} cents (payment total ${payment.group_total_cents}); not reversed automatically`);
        return { status: 'processed', outcome: { action: 'review', payment_id: payment.id } };
      }
      const r = await store.reversePayment(payment.id, { kind: 'chargeback', reason: `dispute ${obj.id}`, reversalDate: paymentDate });
      const recovery = await store.recoverDisputedFunds(payment.id, { chargeId: obj.charge, disputeId: obj.id });
      return { status: 'processed', outcome: { ...r, recovery } };
    }
    case 'charge.dispute.closed': {
      const payment = await store.findAssessmentByIntent(obj.payment_intent);
      if (!payment) return { status: 'ignored', outcome: { reason: 'no assessment payment for this dispute' } };
      if (obj.status === 'won') {
        await store.flagReview(payment.id, `Dispute ${obj.id} won: funds returned; re-credit the homeowner manually after confirming`);
        return { status: 'processed', outcome: { action: 'review', payment_id: payment.id } };
      }
      return { status: 'processed', outcome: { action: 'none', dispute_status: obj.status } };
    }
    case 'account.updated':
      await store.accountUpdated(obj);
      return { status: 'processed', outcome: { account: obj.id } };
    default:
      return { status: 'ignored', outcome: { reason: 'unhandled event type' } };
  }
}

async function settleAndPost(store, { group, session, paymentIntent, charge }, paymentDate) {
  const s = await store.settle({ group, session, paymentIntent, charge });
  if (s.action !== 'post') return { status: 'processed', outcome: s };
  const posted = await store.postPayment(s.payment_id, { paymentDate });
  return { status: 'processed', outcome: { ...s, posting: posted } };
}

// Claim -> handle -> finish. Returns { http, body } for the webhook route.
async function processWebhookEvent(event, { store, mode, log = console }) {
  const claim = await store.claimEvent(event);
  if (claim === 'done') return { http: 200, body: { received: true, duplicate: true } };
  if (claim === 'busy') return { http: 409, body: { error: 'event_in_progress' } };
  try {
    const r = await handleStripeEvent(event, { store, mode, log });
    await store.finishEvent(event.id, r.status, null, r.outcome || null);
    return { http: 200, body: { received: true } };
  } catch (e) {
    log.error(`[payments] webhook ${event.type} ${event.id} failed:`, e.message);
    try { await store.finishEvent(event.id, 'failed', String(e.message || e).slice(0, 1000), null); }
    catch (fe) { log.error('[payments] could not record event failure:', fe.message); }
    return { http: 500, body: { error: 'handler_failed' } };
  }
}

module.exports = { handleStripeEvent, processWebhookEvent, centralDate };
