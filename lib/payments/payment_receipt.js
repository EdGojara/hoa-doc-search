// ============================================================================
// lib/payments/payment_receipt.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// The receipt for a settled homeowner assessment payment.
//
// Two steps, deliberately apart:
//   buildPaymentReceipt()  pure: the receipt's number, subject and body from the
//                          payment facts. Always run on settle; the result is
//                          stored in payment_receipts (migration 534).
//   receiptSendDecision()  whether that receipt may be EMAILED. Only when the
//                          community's payment_receipt_emails_enabled switch is
//                          ON (default OFF) and there is a recipient. Staff turn
//                          it on; nothing in this pipeline does.
//
// When it does send, it goes out as Claire through the branded persona path
// (lib/email/persona_signature.js buildPersonaEmail + graph_send.sendAs), never
// as a bare body. Wording follows lib/payments/brand.js: the ASSOCIATION is paid,
// Bedrock Pay is only the way it was paid.
// ============================================================================
const { receiptHeading, receiptFooter } = require('./brand');

const RECEIPT_PERSONA = 'claire';

const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD_LABEL = { us_bank_account: 'Bank account (ACH)', card: 'Card' };

function longDate(ymd) {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' }).format(d);
}

// Stable, human-readable, unique per payment (the payment id is unique).
function receiptNumber({ trustedAccountNumber, paymentId }) {
  return `R-${String(trustedAccountNumber || 'ACCT').replace(/[^A-Za-z0-9-]/g, '')}-${String(paymentId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/**
 * payment: { id, amount_cents (assessment portion), convenience_fee_cents, payment_method_type,
 *            trusted_account_number }
 * community: { name, hoa_legal_name }  property: { street_address }
 * -> { receipt_number, subject, body_text, amount_cents, paid_on, payment_method }
 */
function buildPaymentReceipt({ payment, community, property, paidOn, payerName = null }) {
  if (!payment || !payment.id) throw new Error('payment required');
  const amount = Math.abs(Number(payment.amount_cents || 0));
  if (!(amount > 0)) throw new Error('receipt amount must be positive');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || ''))) throw new Error('paidOn must be YYYY-MM-DD');
  const association = (community && (community.hoa_legal_name || community.name)) || 'your association';
  const number = receiptNumber({ trustedAccountNumber: payment.trusted_account_number, paymentId: payment.id });
  const fee = Math.abs(Number(payment.convenience_fee_cents || 0));
  const lines = [
    payerName ? `Hi ${String(payerName).split(/\s+/)[0]},` : 'Hello,',
    '',
    `Thank you. ${association} received your payment of ${money(amount)} on ${longDate(paidOn)}.`,
    '',
    `Receipt number: ${number}`,
    `Account: ${payment.trusted_account_number || 'n/a'}`,
    property && property.street_address ? `Property: ${property.street_address}` : null,
    `Paid by: ${METHOD_LABEL[payment.payment_method_type] || 'Online payment'}`,
    `Amount applied to your account: ${money(amount)}`,
    fee > 0 ? `Card convenience fee: ${money(fee)}` : null,
    '',
    'Your account balance in the homeowner portal reflects this payment.',
    '',
    receiptFooter(association),
  ].filter((l) => l !== null);
  return {
    receipt_number: number,
    subject: `${receiptHeading(association)}: ${money(amount)} payment`,
    body_text: lines.join('\n'),
    amount_cents: amount,
    paid_on: paidOn,
    payment_method: payment.payment_method_type || null,
  };
}

/** -> { send: boolean, status, note } ; status is the payment_receipts.status to record when not sending. */
function receiptSendDecision({ community, toEmail }) {
  if (!community || community.payment_receipt_emails_enabled !== true) {
    return { send: false, status: 'sending_disabled', note: 'Receipt emails are off for this community (payment_receipt_emails_enabled).' };
  }
  if (!toEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(toEmail))) {
    return { send: false, status: 'no_recipient', note: 'No payer email on the payment.' };
  }
  return { send: true, status: null, note: null };
}

/**
 * Send a recorded receipt through the branded persona path. deps lets tests stub
 * the builder and the sender; production uses persona_signature + graph_send.
 * -> { ok, error? }
 */
async function sendReceiptEmail({ receipt, toEmail, community }, deps = {}) {
  const build = deps.buildPersonaEmail || require('../email/persona_signature').buildPersonaEmail;
  const graph = deps.graphSend || require('../email/graph_send');
  const built = build(RECEIPT_PERSONA, receipt.body_text, community && community.name);
  const r = await graph.sendAs({ from: graph.CLAIRE_MAILBOX, to: toEmail, subject: receipt.subject, html: built.html,
    attachments: built.attachments, communityId: community && community.id });
  if (r && r.suppressed) return { ok: false, error: `suppressed (${r.reason})` };
  return { ok: true };
}

module.exports = { buildPaymentReceipt, receiptSendDecision, sendReceiptEmail, receiptNumber, RECEIPT_PERSONA };
