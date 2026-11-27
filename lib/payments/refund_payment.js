// ============================================================================
// lib/payments/refund_payment.js
// ----------------------------------------------------------------------------
// The ONE refund path for a Stripe-collected payment row. Used by the staff
// refund route (POST /api/payments/:id/refund) and by the live $1 verification
// (lib/payments/live_verification.js), so a verification refund behaves exactly
// like any other refund: Stripe refunds the charge, the transfer comes back from
// the association, the application fee is refunded for assessments (the
// association nets zero, Ed 2026-11-21, PR #399), and charge.refunded reverses
// the homeowner ledger through payment_lifecycle.
//
// -> { ok:true, refund_id, amount_cents, status } | { ok:false, status, error }
// ============================================================================
'use strict';

async function refundPaymentRow({ supabase, stripeLib }, payment, opts = {}) {
  const { amountCents, reason, reverseTransfer, refundApplicationFee, idempotencyKey } = opts;
  if (!payment) return { ok: false, status: 404, error: 'payment not found' };
  if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
    return { ok: false, status: 409, error: `cannot refund payment in status ${payment.status}` };
  }
  if (!payment.processor_payment_id) {
    return { ok: false, status: 400, error: 'no processor_payment_id on record (was this a paper payment?)' };
  }

  // Whether Bedrock gives back its management fee is a judgement about
  // whether the service happened, so the operator states it rather than the
  // code assuming. A cancelled booking refunds it (nothing was delivered);
  // returning a deposit after the event does not (the rental happened).
  // Assessments: the convenience fee is Bedrock's, collected as the
  // application fee. Refunding the charge reverses the WHOLE transfer from
  // the association, so unless the application fee comes back too, the
  // association's own funds pay for refunding Bedrock's fee (Ed 2026-11-21:
  // fees stay separate from association funds). Always refund it there.
  const refund = await stripeLib.refund({
    paymentIntentId: payment.processor_payment_id,
    amountCents: amountCents || undefined,
    connectedAccountId: payment.connected_account_id || undefined,
    reason: reason || 'requested_by_customer',
    reverseTransfer: !!reverseTransfer,
    refundApplicationFee: payment.product_type === 'assessment_payment' || refundApplicationFee === true,
    idempotencyKey,
  });
  if (!refund.ok) return { ok: false, status: refund.skipped ? 503 : 500, error: refund.error || 'refund_failed' };

  // The webhook (charge.refunded) reconciles shortly; reflect it now so the
  // admin screen does not show a stale status.
  const newRefundedTotal = (payment.refunded_amount_cents || 0) + (refund.amount_cents || payment.amount_cents);
  const { error: upErr } = await supabase.from('payments').update({
    status: newRefundedTotal >= payment.amount_cents ? 'refunded' : 'partially_refunded',
    refunded_amount_cents: newRefundedTotal,
    refunded_at: new Date().toISOString(),
    refund_reason: reason || null,
  }).eq('id', payment.id);
  if (upErr) console.error(`[refund_payment] refund ${refund.refund_id} issued but payment ${payment.id} not updated: ${upErr.message}`);

  return { ok: true, refund_id: refund.refund_id, amount_cents: refund.amount_cents, status: refund.status };
}

module.exports = { refundPaymentRow };
