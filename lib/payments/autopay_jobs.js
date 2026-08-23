// ============================================================================
// lib/payments/autopay_jobs.js — the two scheduled halves of autopay.
// ----------------------------------------------------------------------------
// The engine in autopay.js decides; this supplies the two things it cannot know
// on its own — what a property actually owes today, and how to send a notice —
// and wires both into the scheduler.
//
// THEY RUN AT DIFFERENT HOURS, DELIBERATELY. Notices go out at 07:00 and
// charges at 09:00. If a notice job stalls or fails, the charge run finds no
// valid notice and skips rather than debiting an amount nobody was told about.
// Same order, every day, with the gate between them.
//
// balanceFor is the seam that matters. Charging the wrong figure is the failure
// this whole feature has to avoid, so it reads the ONE canonical balance view
// (v_homeowner_current_balance) rather than recomputing from transactions —
// there is exactly one right answer to "what do they owe" and it is not
// something a payment job should be deriving for itself.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { sendDueNotices, chargeDue, usd, pretty } = require('./autopay');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * What this property owes right now, in cents. 0 when nothing is due.
 *
 * Reads the canonical AR balance view. If that lookup fails we return 0, which
 * SKIPS the charge — never a guess. A missed debit is recoverable next cycle;
 * a debit for a number we invented is not.
 */
async function balanceFor(row) {
  try {
    const { data, error } = await supabase
      .from('v_homeowner_current_balance')
      .select('balance_cents')
      .eq('property_id', row.property_id)
      .maybeSingle();
    if (error) throw error;
    const cents = Number(data?.balance_cents || 0);
    return cents > 0 ? Math.round(cents) : 0;
  } catch (e) {
    console.warn('[autopay] balance lookup failed for property', row.property_id, e.message);
    return 0;
  }
}

/**
 * The Regulation E advance notice.
 *
 * States the exact amount and the exact date, because that is what the rule
 * requires and what makes it useful — a homeowner who reads this knows what is
 * leaving their account and when, in time to stop it. Cancellation is in the
 * message, not buried in a portal: a notice you cannot act on is a formality.
 */
async function sendNotice({ to, subject, autopay, amountCents, associationName }) {
  if (!to) throw new Error('no email on file for this autopay');
  const { sendEmail } = require('../notifications/email');
  const when = pretty(autopay.next_charge_at);
  const method = autopay.method_label
    ? `${autopay.method_label}${autopay.method_last4 ? ` ending ${autopay.method_last4}` : ''}`
    : (autopay.method_kind === 'card' ? 'your card' : 'your bank account');

  const text = [
    `This is your advance notice of a scheduled payment.`,
    ``,
    `Amount:   ${usd(amountCents)}`,
    `Date:     ${when}`,
    `From:     ${method}`,
    `To:       ${associationName}`,
    ``,
    `You set this up as automatic payment of your balance, so the amount changes with what you owe. This notice tells you the exact figure before it is taken.`,
    autopay.max_amount_cents
      ? `You set a limit of ${usd(autopay.max_amount_cents)}. If a balance is ever above that, we stop and ask instead of taking it.`
      : ``,
    ``,
    `To change or cancel it, open your portal and go to Payments. Do that at least three business days before ${when}.`,
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
  const r = await sendDueNotices({ balanceFor, sendEmail: sendNotice });
  if (r.sent) console.log(`[autopay] ${r.sent} advance notice(s) sent`);
  return r;
}

/** Charges due today. Refuses anything without a matching notice. */
async function runChargeJob() {
  const r = await chargeDue({ balanceFor });
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

module.exports = { registerAutopayJobs, runNoticeJob, runChargeJob, balanceFor, sendNotice };
