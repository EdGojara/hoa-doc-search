// ============================================================================
// lib/payments/autopay.js — standing authorisation to pay assessments.
// ----------------------------------------------------------------------------
// Ed 2026-08-22: "go ahead and build it out for the demo, i want to show the
// bank a full working model" and "we are moving off of the platform."
//
// Vantaca Pay is not a fallback any more, so this is the system of record.
//
// THREE RULES, and each one exists because of something in Vantaca's terms that
// we are deliberately not repeating:
//
//   1. THE 10-DAY NOTICE IS OURS TO SEND, and it is part of the machinery.
//      Regulation E requires notice at least 10 days before a preauthorized
//      transfer that VARIES in amount. Vantaca's §5.3 assigns that duty to "your
//      Association or property management company" and provides nothing to do it
//      with. A charge here cannot run unless the notice went, named an amount,
//      and that amount still matches. No notice, no debit.
//
//   2. THE HOMEOWNER'S CAP IS A STOP, NOT A CLAMP. If the balance exceeds the
//      ceiling they set, the charge does not shrink to fit and it does not
//      proceed. It stops and tells them. Quietly taking the maximum they would
//      tolerate is how a cap becomes a trap.
//
//   3. EVERY ATTEMPT IS LOGGED, including the ones that did nothing. An autopay
//      that silently stopped working is the worst failure available here: the
//      homeowner believes they are current while late fees accrue, and nobody
//      finds out until collections.
//
// WHY NOT STRIPE SUBSCRIPTIONS: an assessment is not a fixed price. "Pay full
// balance" is whatever is owed that day, moving with adjustments, late fees and
// special assessments. The mandate is captured once via Checkout in setup mode
// (which collects the ACH authorisation language NACHA requires) and each charge
// is raised off-session for the real figure.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const stripeLib = require('./stripe');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Reg E minimum. Sending on the boundary is asking for an argument about
// timezones, so the notice goes at 12 days and the debit will not run before
// day 10 has genuinely passed.
const NOTICE_DAYS_MIN = 10;
const NOTICE_DAYS_TARGET = 12;

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${iso(d)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const daysBetween = (a, b) => Math.round((new Date(`${iso(b)}T12:00:00Z`) - new Date(`${iso(a)}T12:00:00Z`)) / 86400000);

/**
 * Start enrolment. Returns a Stripe Checkout URL in SETUP mode — no money moves,
 * the homeowner authorises future debits.
 *
 * The customer is created on the ASSOCIATION's connected account, not the
 * platform. A homeowner's stored bank details should no more be pooled across
 * communities than their money is.
 */
async function beginEnrollment({ community, property, payer, amountMode = 'full_balance',
  maxAmountCents = null, frequency = 'on_due_date', methodKind = 'us_bank_account',
  successUrl, cancelUrl, portalUserId = null }) {
  if (!stripeLib.isConfigured()) return { ok: false, status: 503, error: 'payment_not_configured' };
  if (!community?.stripe_connected_account_id) {
    return { ok: false, status: 409, error: 'community_not_onboarded',
      hint: `${community?.name || 'This community'} has not finished Stripe onboarding, so it cannot accept a standing authorisation yet.` };
  }
  const acct = community.stripe_connected_account_id;

  // Customer on the connected account.
  const cust = await stripeLib.createCustomer({
    email: payer?.email, name: payer?.name,
    metadata: { community_id: community.id, property_id: property.id, purpose: 'assessment_autopay' },
    connectedAccountId: acct,
  });
  if (!cust.ok) return { ok: false, status: 502, error: cust.error || 'customer_create_failed' };

  const session = await stripeLib.createSetupSession({
    customerId: cust.id,
    connectedAccountId: acct,
    methodKind,
    successUrl, cancelUrl,
    metadata: { community_id: community.id, property_id: property.id },
  });
  if (!session.ok) return { ok: false, status: 502, error: session.error || 'setup_session_failed' };

  // Record the intent now, so an abandoned enrolment is visible rather than a
  // Stripe customer nobody knows about.
  const { data: row, error } = await supabase.from('assessment_autopay').upsert({
    community_id: community.id,
    property_id: property.id,
    portal_user_id: portalUserId,
    payer_name: payer?.name || null,
    payer_email: payer?.email || null,
    stripe_customer_id: cust.id,
    connected_account_id: acct,
    method_kind: methodKind,
    amount_mode: amountMode,
    max_amount_cents: maxAmountCents,
    frequency,
    status: 'pending_setup',
  }, { onConflict: 'property_id' }).select('id').single();
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true, autopay_id: row.id, setup_url: session.url, session_id: session.id };
}

/** Finish enrolment once the homeowner completes the setup session. */
async function completeEnrollment({ autopayId, sessionId }) {
  const { data: row, error } = await supabase.from('assessment_autopay')
    .select('*').eq('id', autopayId).maybeSingle();
  if (error || !row) return { ok: false, error: 'not_found' };

  const s = await stripeLib.retrieveSetupSession(sessionId, row.connected_account_id);
  if (!s.ok || !s.payment_method) return { ok: false, error: s.error || 'setup_not_complete' };

  const patch = {
    stripe_payment_method_id: s.payment_method,
    mandate_reference: s.mandate || null,
    method_last4: s.last4 || null,
    method_label: s.label || null,
    method_kind: s.method_kind || row.method_kind,
    status: 'active',
    authorized_at: new Date().toISOString(),
  };
  // First cycle: schedule the notice before the charge, never the other way.
  const due = row.next_charge_at || addDays(new Date(), 30);
  patch.next_charge_at = due;
  patch.next_notice_at = addDays(due, -NOTICE_DAYS_TARGET);

  const { error: uErr } = await supabase.from('assessment_autopay').update(patch).eq('id', autopayId);
  if (uErr) return { ok: false, error: uErr.message };
  return { ok: true, autopay: { ...row, ...patch } };
}

/**
 * Send the Reg E advance notice for anything due.
 *
 * Records the amount it named. The obligation is to warn of a SPECIFIC figure,
 * so if the balance later moves materially the notice no longer covers it and
 * the charge must wait for a fresh one.
 */
async function sendDueNotices({ today = iso(new Date()), balanceFor, sendEmail, log = console } = {}) {
  const { data: rows, error } = await supabase.from('assessment_autopay')
    .select('*, community:community_id(name, hoa_legal_name), property:property_id(street_address)')
    .eq('status', 'active').lte('next_notice_at', today)
    .order('next_notice_at').limit(500);
  if (error) { log.warn('[autopay] notice lookup failed:', error.message); return { sent: 0, errors: 1 }; }

  let sent = 0;
  for (const r of (rows || [])) {
    try {
      const amount = await balanceFor(r);
      if (!(amount > 0)) {
        await recordRun(r.id, { amount_cents: 0, outcome: 'skipped_zero_balance', detail: 'nothing owed at notice time' });
        await supabase.from('assessment_autopay').update({
          next_notice_at: addDays(r.next_notice_at, 30),
        }).eq('id', r.id);
        continue;
      }
      const who = r.community?.hoa_legal_name || r.community?.name || 'your association';
      await sendEmail({
        to: r.payer_email,
        subject: `Scheduled payment of ${usd(amount)} to ${who} on ${pretty(r.next_charge_at)}`,
        autopay: r, amountCents: amount, associationName: who,
      });
      await supabase.from('assessment_autopay').update({
        notice_sent_at: new Date().toISOString(),
        noticed_amount_cents: amount,
      }).eq('id', r.id);
      await recordRun(r.id, { amount_cents: amount, outcome: 'noticed', detail: `10-day notice sent to ${r.payer_email}` });
      sent++;
    } catch (e) {
      log.warn('[autopay] notice failed for', r.id, e.message);
    }
  }
  return { sent };
}

/**
 * Charge everything due today.
 *
 * Refuses on three grounds, and each refusal is recorded rather than retried
 * silently: no valid notice, over the homeowner's cap, or nothing owed.
 */
async function chargeDue({ today = iso(new Date()), balanceFor, log = console } = {}) {
  const { data: rows, error } = await supabase.from('assessment_autopay')
    .select('*, community:community_id(id, name, hoa_legal_name, stripe_connected_account_id)')
    .eq('status', 'active').lte('next_charge_at', today)
    .order('next_charge_at').limit(500);
  if (error) { log.warn('[autopay] charge lookup failed:', error.message); return { charged: 0 }; }

  let charged = 0;
  for (const r of (rows || [])) {
    try {
      const amount = await balanceFor(r);

      if (!(amount > 0)) {
        await recordRun(r.id, { amount_cents: 0, outcome: 'skipped_zero_balance', detail: 'balance was zero on the due date' });
        await advance(r);
        continue;
      }

      // Reg E gate. No notice, or a notice that named a materially different
      // figure, means this debit was never disclosed.
      const noticed = r.noticed_amount_cents;
      // !! deliberately: without it this is null when no notice exists, which
      // is falsy and behaves correctly but reads as "unknown" rather than "no"
      // on a gate that decides whether somebody's account gets debited.
      const noticeAgeOk = !!(r.notice_sent_at && daysBetween(r.notice_sent_at, today) >= NOTICE_DAYS_MIN);
      const amountMatches = noticed != null && Math.abs(amount - noticed) <= Math.max(100, Math.round(noticed * 0.01));
      if (!noticeAgeOk || !amountMatches) {
        await recordRun(r.id, {
          amount_cents: amount, outcome: 'skipped_no_notice',
          detail: !r.notice_sent_at ? 'no advance notice on record'
            : !noticeAgeOk ? `notice sent ${daysBetween(r.notice_sent_at, today)} days ago, needs ${NOTICE_DAYS_MIN}`
              : `balance ${usd(amount)} differs from the ${usd(noticed)} the notice named`,
        });
        // Re-notice for the new figure rather than debiting an undisclosed one.
        await supabase.from('assessment_autopay').update({
          next_notice_at: today, notice_sent_at: null, noticed_amount_cents: null,
          next_charge_at: addDays(today, NOTICE_DAYS_TARGET),
        }).eq('id', r.id);
        continue;
      }

      // The homeowner's ceiling. Stop, do not clamp.
      if (r.max_amount_cents != null && amount > r.max_amount_cents) {
        await recordRun(r.id, {
          amount_cents: amount, outcome: 'skipped_over_cap',
          detail: `${usd(amount)} is above the ${usd(r.max_amount_cents)} limit you set`,
        });
        await supabase.from('assessment_autopay').update({
          status: 'paused',
          status_reason: `The balance of ${usd(amount)} is above the ${usd(r.max_amount_cents)} limit you set, so we did not take the payment.`,
        }).eq('id', r.id);
        continue;
      }

      const res = await stripeLib.chargeOffSession({
        customerId: r.stripe_customer_id,
        paymentMethodId: r.stripe_payment_method_id,
        amountCents: amount,
        connectedAccountId: r.connected_account_id,
        description: `Assessment — ${r.community?.hoa_legal_name || r.community?.name || ''}`,
        metadata: { autopay_id: r.id, property_id: r.property_id, community_id: r.community_id },
      });

      if (!res.ok) {
        const fails = (r.consecutive_failures || 0) + 1;
        await recordRun(r.id, { amount_cents: amount, outcome: 'failed', detail: res.error || 'charge failed' });
        await supabase.from('assessment_autopay').update({
          consecutive_failures: fails,
          last_charge_status: 'failed',
          // Three strikes and a person looks at it. Retrying forever against a
          // closed account just accumulates return fees on the homeowner.
          ...(fails >= 3 ? { status: 'failed', status_reason: res.error || 'payment failed three times' } : {}),
          next_charge_at: fails >= 3 ? null : addDays(today, 3),
        }).eq('id', r.id);
        continue;
      }

      await recordRun(r.id, {
        amount_cents: amount, outcome: 'charged',
        processor_payment_id: res.payment_intent, detail: 'ok',
      });
      await supabase.from('assessment_autopay').update({
        last_charge_at: new Date().toISOString(),
        last_charge_amount_cents: amount,
        last_charge_status: 'succeeded',
        consecutive_failures: 0,
      }).eq('id', r.id);
      await advance(r);
      charged++;
    } catch (e) {
      log.warn('[autopay] charge failed for', r.id, e.message);
    }
  }
  return { charged };
}

// Next cycle, with the notice scheduled ahead of the charge by construction.
async function advance(r) {
  const step = { monthly: 30, quarterly: 91, annually: 365, on_due_date: 365 }[r.frequency] || 30;
  const next = addDays(r.next_charge_at || new Date(), step);
  await supabase.from('assessment_autopay').update({
    next_charge_at: next,
    next_notice_at: addDays(next, -NOTICE_DAYS_TARGET),
    notice_sent_at: null,
    noticed_amount_cents: null,
  }).eq('id', r.id);
}

async function recordRun(autopayId, row) {
  const { error } = await supabase.from('assessment_autopay_runs').insert({ autopay_id: autopayId, ...row });
  if (error) console.warn('[autopay] run log failed:', error.message);
}

async function cancel({ autopayId, by = 'homeowner', reason = null }) {
  const { error } = await supabase.from('assessment_autopay').update({
    status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: by,
    status_reason: reason, next_charge_at: null, next_notice_at: null,
  }).eq('id', autopayId);
  return { ok: !error, error: error && error.message };
}

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pretty = (d) => (d ? new Date(`${iso(d)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

/** What the portal shows a homeowner about their standing authorisation. */
async function statusForProperty(propertyId) {
  const { data, error } = await supabase.from('assessment_autopay')
    .select('id, status, status_reason, amount_mode, max_amount_cents, frequency, '
      + 'method_kind, method_label, method_last4, next_charge_at, next_notice_at, '
      + 'notice_sent_at, noticed_amount_cents, last_charge_at, last_charge_amount_cents, '
      + 'last_charge_status, authorized_at')
    .eq('property_id', propertyId)
    .in('status', ['pending_setup', 'active', 'paused', 'failed'])
    .maybeSingle();
  if (error) {
    // The table arrives with migration 383. Its absence must not break the
    // balance card for everyone else.
    if (!/does not exist|schema cache/i.test(error.message || '')) {
      console.warn('[autopay] status lookup failed:', error.message);
    }
    return null;
  }
  return data || null;
}

module.exports = {
  beginEnrollment, completeEnrollment, sendDueNotices, chargeDue, cancel, advance, statusForProperty,
  NOTICE_DAYS_MIN, NOTICE_DAYS_TARGET, _iso: iso, _addDays: addDays, _daysBetween: daysBetween, usd, pretty,
};
