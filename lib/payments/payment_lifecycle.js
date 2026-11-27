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
//   * Homeowner emails (lib/payments/payment_receipts.js, Ed 2026-11-27): a receipt
//     after a payment settles (card at once, ACH when it clears); a "bank payment
//     submitted" email when an ACH payment starts processing. Each is claimed once
//     on the payment row, so a replayed or duplicated event sends nothing. Refunds,
//     disputes, failures and payouts never send one. An email problem never fails
//     the event: the ledger does not wait on mail.
//   * payout.paid / payout.failed on an association's connected account stage the
//     payout's components in bank_rec_payouts for the monthly bank reconciliation
//     (lib/payments/stripe_payouts.js). Nothing is posted from a webhook: the
//     payout entry is proposed by Kat's run and posted on the owner's approval.
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

// The homeowner email for this payment, if the store sends them. Never throws.
async function notice(store, paymentId, kind, log) {
  if (!paymentId || typeof store.notifyPayment !== 'function') return null;
  try { return await store.notifyPayment(paymentId, kind); }
  catch (e) { log.error(`[payments] ${kind} email for payment ${paymentId} failed: ${e.message}`); return { action: 'error', error: e.message }; }
}
async function processing(store, args, log) {
  const r = await store.markProcessing(args);
  if (r && r.payment_id && (r.action === 'processing' || r.action === 'done')) {
    const n = await notice(store, r.payment_id, 'submitted', log);
    if (n) return { ...r, notice: n };
  }
  return r;
}

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
      if (obj.payment_status === 'paid') return settleAndPost(store, ref(obj), paymentDate, log);
      if (obj.payment_status === 'unpaid') {
        const r = await processing(store, { group: groupOf(obj), session: obj.id, paymentIntent: obj.payment_intent || null }, log);
        return { status: 'processed', outcome: r };
      }
      return { status: 'ignored', outcome: { reason: `payment_status ${obj.payment_status}` } };
    }
    case 'checkout.session.async_payment_succeeded':
      if (meta(obj).product_type !== 'assessment_payment') return { status: 'ignored', outcome: { reason: 'not an assessment' } };
      return settleAndPost(store, ref(obj), paymentDate, log);
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
      return settleAndPost(store, { group: groupOf(obj), session: null, paymentIntent: obj.id, charge: obj.latest_charge || null }, paymentDate, log);
    }
    case 'payment_intent.processing': {
      if (!isDirectAssessment(obj)) return { status: 'ignored', outcome: { reason: 'not a direct assessment payment' } };
      const r = await processing(store, { group: groupOf(obj), session: null, paymentIntent: obj.id }, log);
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
    case 'payout.paid':
    case 'payout.failed': {
      // Only an association's own payout (a connected-account delivery) is staged;
      // Bedrock's platform payouts are not association money.
      if (!event.account) return { status: 'ignored', outcome: { reason: 'platform payout, not an association account' } };
      if (typeof store.stagePayout !== 'function') return { status: 'ignored', outcome: { reason: 'payout staging not available' } };
      const r = event.type === 'payout.paid' ? await store.stagePayout(obj, event.account) : await store.failPayout(obj, event.account);
      return { status: 'processed', outcome: r };
    }
    case 'account.updated':
      await store.accountUpdated(obj);
      return { status: 'processed', outcome: { account: obj.id } };
    default:
      return { status: 'ignored', outcome: { reason: 'unhandled event type' } };
  }
}

async function settleAndPost(store, { group, session, paymentIntent, charge }, paymentDate, log = console) {
  const s = await store.settle({ group, session, paymentIntent, charge });
  if (s.action !== 'post') {
    // 'done' = already settled (a replay or a second event for the same payment): the
    // receipt claim makes this a no-op if it was sent; it finishes one that was not.
    const n = s.action === 'done' ? await notice(store, s.payment_id, 'receipt', log) : null;
    return { status: 'processed', outcome: n ? { ...s, receipt: n } : s };
  }
  const posted = await store.postPayment(s.payment_id, { paymentDate });
  const n = await notice(store, s.payment_id, 'receipt', log);
  return { status: 'processed', outcome: { ...s, posting: posted, ...(n ? { receipt: n } : {}) } };
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
