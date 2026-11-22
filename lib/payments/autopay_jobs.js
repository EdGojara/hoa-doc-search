// ============================================================================
// lib/payments/autopay_jobs.js — the two scheduled halves of autopay.
// ----------------------------------------------------------------------------
// The engine in autopay.js decides; this supplies how a notice is worded and
// sent, and wires both jobs into the scheduler.
//
// THEY RUN AT DIFFERENT HOURS, DELIBERATELY. Notices go out at 07:00 and
// charges at 09:00. If a notice job stalls or fails, the charge run finds no
// valid notice and skips rather than debiting an amount nobody was told about.
// Same order, every day, with the gate between them.
//
// What a property owes, and the fee on it, are NOT decided here (Ed 2026-11-21):
// both jobs price each cycle through lib/payments/assessment_intent.js
// autopayQuote, the same tenure balance (v_current_owner_balance), gates and fee
// rules as a one-time payment. There is exactly one right answer to "what do
// they owe and what is the fee", and a payment job must not derive its own.
//
// Nothing here runs unless AUTOPAY_CHARGES_ENABLED=true (default OFF).
// ============================================================================
const { sendDueNotices, chargeDue, usd, pretty } = require('./autopay');

/**
 * The Regulation E advance notice.
 *
 * States the exact amount and the exact date, because that is what the rule
 * requires and what makes it useful — a homeowner who reads this knows what is
 * leaving their account and when, in time to stop it. Cancellation is in the
 * message, not buried in a portal: a notice you cannot act on is a formality.
 */
async function sendNotice({ to, subject, autopay, amountCents, feeCents = 0, totalCents, feeLabel, associationName }) {
  if (!to) throw new Error('no email on file for this autopay');
  if (!Number.isInteger(totalCents) || totalCents !== amountCents + feeCents) throw new Error('notice total does not equal assessment + fee; not sent');
  const { sendEmail } = require('../notifications/email');
  const when = pretty(autopay.next_charge_at);
  const method = autopay.method_label
    ? `${autopay.method_label}${autopay.method_last4 ? ` ending ${autopay.method_last4}` : ''}`
    : (autopay.method_kind === 'card' ? 'your card' : 'your bank account');

  const text = [
    `This is your advance notice of a scheduled payment.`,
    ``,
    `Assessment:      ${usd(amountCents)}`,
    `Processing fee:  ${usd(feeCents)}${feeCents > 0 && feeLabel ? ` (${feeLabel.replace(/^Processing fee \(|\)$/g, '')})` : ''}`,
    `Total debited:   ${usd(totalCents)}`,
    `Date:            ${when}`,
    `From:            ${method}`,
    `To:              ${associationName}`,
    ``,
    `You set this up as automatic payment of your balance, so the amount changes with what you owe. This notice tells you the exact figure before it is taken. The processing fee is calculated on this payment's amount for your payment method.`,
    autopay.max_amount_cents
      ? `You set a limit of ${usd(autopay.max_amount_cents)}. If a payment is ever above that, we stop and ask instead of taking it.`
      : ``,
    ``,
    `To change or cancel it, open your portal and go to Payments, or email info@bedrocktx.com. Do that at least three business days before ${when}.`,
    ``,
    `If this does not look right, reply to this email and a person will look at it.`,
  ].filter((l) => l !== null).join('\n');

  return sendEmail({
    to,
    subject,
    text,
    module: 'payments',
    event: 'autopay_advance_notice',
  });
}

/** Notices due today. Runs before the charge job, every day. */
async function runNoticeJob() {
  const r = await sendDueNotices({ sendEmail: sendNotice });
  if (r.sent) console.log(`[autopay] ${r.sent} advance notice(s) sent`);
  return r;
}

/** Charges due today. Refuses anything without a matching notice. */
async function runChargeJob() {
  const r = await chargeDue({});
  if (r.charged) console.log(`[autopay] ${r.charged} autopay charge(s) taken`);
  return r;
}

/**
 * Both jobs, two hours apart.
 *
 * Names are deliberate: they go in SCHEDULER_ENABLED, and somebody reading that
 * env var should be able to tell that enabling the charge without the notice
 * would be a mistake.
 */
function registerAutopayJobs(scheduler) {
  scheduler.register({ name: 'autopay_notices', targetHour: 7, run: () => runNoticeJob() });
  scheduler.register({ name: 'autopay_charges', targetHour: 9, run: () => runChargeJob() });
}

module.exports = { registerAutopayJobs, runNoticeJob, runChargeJob, sendNotice };
