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
//   2. THE HOMEOWNER'S CAP IS A STOP, NOT A CLAMP. If the total exceeds the
//      ceiling they set, the charge does not shrink to fit and it does not
//      proceed. It stops and tells them. Quietly taking the maximum they would
//      tolerate is how a cap becomes a trap.
//
//   3. EVERY ATTEMPT IS LOGGED, including the ones that did nothing. An autopay
//      that silently stopped working is the worst failure available here: the
//      homeowner believes they are current while late fees accrue, and nobody
//      finds out until collections.
//
// ONE PAYMENT PATH (Ed 2026-11-21). An automatic payment is the same payment as
// a one-time one, just started by the schedule instead of the homeowner:
//   * enrollment: a Customer on the PLATFORM and a Checkout session in setup
//     mode with on_behalf_of = the association's connected account (card or US
//     bank account; Stripe collects the ACH mandate). The recurring-payment
//     disclosure and fee schedule are shown and accepted BEFORE that, and the
//     exact text is stored on the enrollment.
//   * every amount, fee, gate, payments row and PaymentIntent comes from
//     lib/payments/assessment_intent.js (autopayQuote / chargeAutopayAssessment):
//     a destination charge, fee = application fee, settled and posted ONLY by
//     the payment webhook. This file never credits anything.
//   * the notice names the assessment, the processing fee and the total; the
//     charge recomputes the fee and refuses (re-notices) if the fee rules moved.
//   * nothing here runs unless AUTOPAY_CHARGES_ENABLED=true (default OFF).
//
// WHY NOT STRIPE SUBSCRIPTIONS: an assessment is not a fixed price. "Pay full
// balance" is whatever is owed that day, moving with adjustments, late fees and
// special assessments. The mandate is captured once and each charge is raised
// off-session for the real figure.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const stripeLib = require('./stripe');
const AI = require('./assessment_intent');
const FQ = require('./fee_quote');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const defaultDeps = () => ({ supabase, stripeLib });

// Reg E minimum. Sending on the boundary is asking for an argument about
// timezones, so the notice goes at 12 days and the debit will not run before
// day 10 has genuinely passed.
const NOTICE_DAYS_MIN = 10;
const NOTICE_DAYS_TARGET = 12;

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${iso(d)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const daysBetween = (a, b) => Math.round((new Date(`${iso(b)}T12:00:00Z`) - new Date(`${iso(a)}T12:00:00Z`)) / 86400000);

const LIVE_STATUSES = ['pending_setup', 'active', 'paused'];

// Demo communities are never auto-noticed or auto-charged under a LIVE key. Under
// a TEST key the mode gate inside autopayQuote already restricts every charge and
// notice to the single payment-sandbox lot (which lives in a demo community), so
// the test-mode run is not filtered here, or autopay could never be exercised.
async function scopeDemo(q, deps) {
  if (require('./stripe_mode').stripeMode(deps.key) === 'test') return q;
  const exclude = deps.excludeDemo || require('../demo/demo_guard').excludeDemo;
  return exclude(q, 'community_id');
}

/**
 * Start enrolment. Returns a Stripe Checkout URL in SETUP mode — no money moves,
 * the homeowner authorises future debits.
 *
 * The homeowner must have accepted the exact disclosure we showed them
 * (acceptedTermsVersion is its hash). The customer is created on the PLATFORM,
 * and the saved method is bound to the association by on_behalf_of.
 */
async function beginEnrollment({ propertyId, payer, maxAmountCents = null, frequency = 'on_due_date',
  acceptedTermsVersion = null, successUrl, cancelUrl, portalUserId = null, authorizedIp = null, env = process.env }, deps = defaultDeps()) {
  if (!AI.autopayChargesEnabled(env)) {
    return { ok: false, status: 503, error: 'autopay_unavailable', hint: 'Automatic payments are not available yet. Please use Pay now.' };
  }
  const t = await AI.autopayEnrollmentTerms(deps, { propertyId });
  if (!t.ok) return t;
  const { pr, terms } = t;
  if (!acceptedTermsVersion || acceptedTermsVersion !== terms.version) {
    return { ok: false, status: 409, error: 'terms_changed', hint: 'Please review the automatic payment terms again.', terms };
  }
  if (!successUrl || !cancelUrl) return { ok: false, status: 400, error: 'success_url_and_cancel_url_required' };
  const { identity, community } = pr;
  const acct = community.stripe_connected_account_id;

  const { data: live, error: lErr } = await deps.supabase.from('assessment_autopay')
    .select('id, status').eq('property_id', identity.property.id).in('status', LIVE_STATUSES).limit(2);
  if (lErr) return { ok: false, status: 500, error: lErr.message };
  const existing = (live || [])[0] || null;
  if (existing && existing.status !== 'pending_setup') {
    return { ok: false, status: 409, error: 'already_enrolled', hint: 'Automatic payments are already set up for this account.' };
  }

  // Customer on the platform. One per enrollment attempt keeps a homeowner's
  // saved methods from leaking across lots or owners.
  const cust = await deps.stripeLib.createCustomer({
    email: payer && payer.email, name: payer && payer.name,
    metadata: { community_id: community.id, property_id: identity.property.id, tenure_id: identity.tenure.id, purpose: 'assessment_autopay' },
  });
  if (!cust.ok) return { ok: false, status: cust.skipped ? 503 : 502, error: cust.error || 'customer_create_failed' };

  const session = await deps.stripeLib.createSetupSession({
    customerId: cust.id,
    onBehalfOf: acct,
    paymentMethodTypes: ['card', 'us_bank_account'],
    successUrl, cancelUrl,
    metadata: { community_id: community.id, property_id: identity.property.id, tenure_id: identity.tenure.id, purpose: 'assessment_autopay' },
  });
  if (!session.ok) return { ok: false, status: session.skipped ? 503 : 502, error: session.error || 'setup_session_failed' };

  // Record the intent now, so an abandoned enrolment is visible rather than a
  // Stripe customer nobody knows about. The disclosure is stored verbatim.
  const row = {
    community_id: community.id,
    property_id: identity.property.id,
    tenure_id: identity.tenure.id,
    portal_user_id: portalUserId,
    payer_name: (payer && payer.name) || null,
    payer_email: (payer && payer.email) || null,
    stripe_customer_id: cust.id,
    stripe_payment_method_id: null,
    connected_account_id: acct,
    setup_session_id: session.id,
    method_kind: null,
    card_funding: null,
    amount_mode: 'full_balance',
    max_amount_cents: maxAmountCents,
    frequency,
    status: 'pending_setup',
    authorized_terms: terms.disclosure.join('\n'),
    authorized_terms_version: terms.version,
    authorized_ip: authorizedIp,
  };
  const q = existing
    ? deps.supabase.from('assessment_autopay').update(row).eq('id', existing.id).select('id').single()
    : deps.supabase.from('assessment_autopay').insert(row).select('id').single();
  const { data: saved, error } = await q;
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true, autopay_id: saved.id, setup_url: session.url, session_id: session.id };
}

/** Finish enrolment once the homeowner completes the setup session. */
async function completeEnrollment({ autopayId, sessionId }, deps = defaultDeps()) {
  const { data: row, error } = await deps.supabase.from('assessment_autopay')
    .select('*').eq('id', autopayId).maybeSingle();
  if (error || !row) return { ok: false, error: 'not_found' };
  if (row.status !== 'pending_setup') return { ok: false, error: 'not_pending' };
  if (row.setup_session_id && row.setup_session_id !== sessionId) return { ok: false, error: 'session_mismatch' };

  const s = await deps.stripeLib.retrieveSetupSession(sessionId);
  if (!s.ok) return { ok: false, error: s.error || 'setup_not_complete' };
  const si = s.setup_intent;
  // The setup must be this enrollment's: our customer, succeeded, bound to the
  // association account the homeowner authorised.
  if (!si || si.status !== 'succeeded' || !s.payment_method) return { ok: false, error: 'setup_not_complete' };
  if ((s.session.customer || si.customer) !== row.stripe_customer_id) return { ok: false, error: 'session_mismatch' };
  if (si.on_behalf_of !== row.connected_account_id) return { ok: false, error: 'setup_not_on_behalf_of_association' };
  const cls = FQ.classifyPaymentMethod(s.payment_method);
  if (!cls.ok) return { ok: false, error: cls.error };
  const pm = s.payment_method;

  const patch = {
    stripe_payment_method_id: pm.id,
    mandate_reference: si.mandate || null,
    method_kind: cls.method_kind,
    card_funding: cls.method_kind === 'card' ? cls.funding : null,
    method_last4: (pm.card && pm.card.last4) || (pm.us_bank_account && pm.us_bank_account.last4) || null,
    method_label: (pm.card && (pm.card.display_brand || pm.card.brand)) || (pm.us_bank_account && pm.us_bank_account.bank_name) || null,
    status: 'active',
    authorized_at: new Date().toISOString(),
  };
  // First cycle: schedule the notice before the charge, never the other way.
  const due = row.next_charge_at || addDays(new Date(), 30);
  patch.next_charge_at = due;
  patch.next_notice_at = addDays(due, -NOTICE_DAYS_TARGET);

  const { error: uErr } = await deps.supabase.from('assessment_autopay').update(patch).eq('id', autopayId);
  if (uErr) return { ok: false, error: uErr.message };
  return { ok: true, autopay: { ...row, ...patch } };
}

/**
 * Send the Reg E advance notice for anything due.
 *
 * Records the amounts it named: the assessment, the processing fee for the
 * saved method, and the total. The obligation is to warn of a SPECIFIC figure,
 * so if the balance later moves materially (or the fee rules change) the notice
 * no longer covers it and the charge must wait for a fresh one.
 */
async function sendDueNotices({ today = iso(new Date()), sendEmail, log = console, env = process.env } = {}, deps = defaultDeps()) {
  if (!AI.autopayChargesEnabled(env)) return { sent: 0, disabled: true };
  let _nq = deps.supabase.from('assessment_autopay')
    .select('*, community:community_id(name, hoa_legal_name), property:property_id(street_address)')
    .eq('status', 'active').lte('next_notice_at', today)
    .order('next_notice_at').limit(500);
  _nq = await scopeDemo(_nq, deps); // never auto-notice a demo org under a live key
  const { data: rows, error } = await _nq;
  if (error) { log.warn('[autopay] notice lookup failed:', error.message); return { sent: 0, errors: 1 }; }

  let sent = 0;
  for (const r of (rows || [])) {
    try {
      const q = await AI.autopayQuote(deps, r);
      if (!q.ok && q.outcome === 'skipped_zero_balance') {
        await recordRun(deps, r.id, { amount_cents: 0, outcome: 'skipped_zero_balance', detail: 'nothing owed at notice time' });
        await deps.supabase.from('assessment_autopay').update({
          next_notice_at: addDays(r.next_notice_at, 30),
        }).eq('id', r.id);
        continue;
      }
      if (!q.ok) {
        await recordRun(deps, r.id, { amount_cents: null, outcome: 'skipped_not_payable', detail: `no notice sent: ${q.detail}` });
        if (q.cancel) await cancel({ autopayId: r.id, by: 'system', reason: q.detail }, deps);
        continue;
      }
      const { quote } = q;
      const who = quote.association_name || r.community?.hoa_legal_name || r.community?.name || 'your association';
      await sendEmail({
        to: r.payer_email,
        subject: `Scheduled payment of ${usd(quote.total_cents)} to ${who} on ${pretty(r.next_charge_at)}`,
        autopay: r, amountCents: quote.assessment_cents, feeCents: quote.fee_cents, totalCents: quote.total_cents,
        feeLabel: quote.fee_label, associationName: who,
      });
      await deps.supabase.from('assessment_autopay').update({
        notice_sent_at: new Date().toISOString(),
        noticed_amount_cents: quote.assessment_cents,
        noticed_fee_cents: quote.fee_cents,
        noticed_total_cents: quote.total_cents,
      }).eq('id', r.id);
      await recordRun(deps, r.id, { amount_cents: quote.total_cents, outcome: 'noticed',
        detail: `10-day notice sent to ${r.payer_email}: assessment ${usd(quote.assessment_cents)} + fee ${usd(quote.fee_cents)} = ${usd(quote.total_cents)}` });
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
 * Refuses on these grounds, and each refusal is recorded rather than retried
 * silently: no valid notice, fee rules changed since the notice, over the
 * homeowner's cap, nothing owed, payments not allowed, or another payment in
 * flight. The charge itself is chargeAutopayAssessment: the one-time payment
 * path, off-session. Nothing is credited here; the webhook posts it.
 */
async function chargeDue({ today = iso(new Date()), log = console, env = process.env } = {}, deps = defaultDeps()) {
  if (!AI.autopayChargesEnabled(env)) {
    log.warn('[autopay] AUTOPAY_CHARGES_ENABLED is not true; nothing charged');
    return { charged: 0, disabled: true };
  }
  let _cq = deps.supabase.from('assessment_autopay')
    .select('*, community:community_id(id, name, hoa_legal_name, stripe_connected_account_id)')
    .eq('status', 'active').lte('next_charge_at', today)
    .order('next_charge_at').limit(500);
  _cq = await scopeDemo(_cq, deps); // never auto-charge a demo org under a live key
  const { data: rows, error } = await _cq;
  if (error) { log.warn('[autopay] charge lookup failed:', error.message); return { charged: 0 }; }

  let charged = 0;
  for (const r of (rows || [])) {
    try {
      const q = await AI.autopayQuote(deps, r);

      if (!q.ok && q.outcome === 'skipped_zero_balance') {
        await recordRun(deps, r.id, { amount_cents: 0, outcome: 'skipped_zero_balance', detail: 'balance was zero on the due date' });
        await advance(r, deps);
        continue;
      }
      if (!q.ok) {
        await recordRun(deps, r.id, { amount_cents: null, outcome: 'skipped_not_payable', detail: q.detail });
        if (q.cancel) await cancel({ autopayId: r.id, by: 'system', reason: q.detail }, deps);
        continue;
      }
      const amount = q.quote.assessment_cents;
      const total = q.quote.total_cents;

      // Reg E gate, on the ASSESSMENT amount. No notice, or a notice that named
      // a materially different figure, means this debit was never disclosed.
      const noticed = r.noticed_amount_cents;
      // !! deliberately: without it this is null when no notice exists, which
      // is falsy and behaves correctly but reads as "unknown" rather than "no"
      // on a gate that decides whether somebody's account gets debited.
      const noticeAgeOk = !!(r.notice_sent_at && daysBetween(r.notice_sent_at, today) >= NOTICE_DAYS_MIN);
      const amountMatches = noticed != null && Math.abs(amount - noticed) <= Math.max(100, Math.round(noticed * 0.01));
      if (!noticeAgeOk || !amountMatches) {
        await recordRun(deps, r.id, {
          amount_cents: amount, outcome: 'skipped_no_notice',
          detail: !r.notice_sent_at ? 'no advance notice on record'
            : !noticeAgeOk ? `notice sent ${daysBetween(r.notice_sent_at, today)} days ago, needs ${NOTICE_DAYS_MIN}`
              : `balance ${usd(amount)} differs from the ${usd(noticed)} the notice named`,
        });
        // Re-notice for the new figure rather than debiting an undisclosed one.
        await renotice(r, today, deps);
        continue;
      }

      // The fee the notice named must still be what today's fee rules give for
      // that noticed amount. If the rules changed, the disclosed fee is stale:
      // re-notice, never charge an undisclosed fee.
      if (r.noticed_fee_cents == null || q.feeFor(noticed) !== r.noticed_fee_cents) {
        await recordRun(deps, r.id, {
          amount_cents: total, outcome: 'skipped_fee_changed',
          detail: r.noticed_fee_cents == null ? 'the notice did not name a processing fee'
            : `the processing fee changed since the notice (${usd(r.noticed_fee_cents)} noticed, ${usd(q.feeFor(noticed))} now)`,
        });
        await renotice(r, today, deps);
        continue;
      }

      // The homeowner's ceiling, on the total debited. Stop, do not clamp.
      if (r.max_amount_cents != null && total > r.max_amount_cents) {
        await recordRun(deps, r.id, {
          amount_cents: total, outcome: 'skipped_over_cap',
          detail: `${usd(total)} is above the ${usd(r.max_amount_cents)} limit you set`,
        });
        await deps.supabase.from('assessment_autopay').update({
          status: 'paused',
          status_reason: `The payment of ${usd(total)} (including the processing fee) is above the ${usd(r.max_amount_cents)} limit you set, so we did not take the payment.`,
        }).eq('id', r.id);
        continue;
      }

      const res = await AI.chargeAutopayAssessment(deps, { autopay: r, pr: q.pr, quote: q.quote, env });

      if (!res.ok && res.outcome === 'skipped_in_flight') {
        // Not a failure: another payment is moving. The next run decides again.
        await recordRun(deps, r.id, { amount_cents: total, outcome: 'skipped_in_flight', detail: res.reason });
        continue;
      }
      if (!res.ok && res.outcome === 'disabled') { log.warn('[autopay] charges disabled; nothing charged'); continue; }

      if (!res.ok) {
        const fails = (r.consecutive_failures || 0) + 1;
        await recordRun(deps, r.id, { amount_cents: total, outcome: 'failed', detail: res.reason || 'charge failed',
          payment_group_id: res.group_id || null, processor_payment_id: res.payment_intent_id || null });
        await deps.supabase.from('assessment_autopay').update({
          consecutive_failures: fails,
          last_charge_status: 'failed',
          // Three strikes and a person looks at it. Retrying forever against a
          // closed account just accumulates return fees on the homeowner.
          ...(fails >= 3 ? { status: 'failed', status_reason: res.reason || 'payment failed three times' } : {}),
          next_charge_at: fails >= 3 ? null : addDays(today, 3),
        }).eq('id', r.id);
        continue;
      }

      await recordRun(deps, r.id, {
        amount_cents: total, outcome: 'charged',
        processor_payment_id: res.payment_intent_id, payment_group_id: res.group_id,
        detail: `${res.status}${res.replayed ? ' (already charged this cycle)' : ''}: assessment ${usd(amount)} + fee ${usd(q.quote.fee_cents)}`,
      });
      await deps.supabase.from('assessment_autopay').update({
        last_charge_at: new Date().toISOString(),
        last_charge_amount_cents: total,
        // ACH stays 'processing' until the bank settles; the webhook posts it.
        last_charge_status: res.status,
        consecutive_failures: 0,
      }).eq('id', r.id);
      await advance(r, deps);
      charged++;
    } catch (e) {
      log.warn('[autopay] charge failed for', r.id, e.message);
    }
  }
  return { charged };
}

// A changed figure gets a fresh notice and a later charge date.
async function renotice(r, today, deps) {
  await deps.supabase.from('assessment_autopay').update({
    next_notice_at: today, notice_sent_at: null, noticed_amount_cents: null, noticed_fee_cents: null, noticed_total_cents: null,
    next_charge_at: addDays(today, NOTICE_DAYS_TARGET),
  }).eq('id', r.id);
}

// Next cycle, with the notice scheduled ahead of the charge by construction.
async function advance(r, deps = defaultDeps()) {
  const step = { monthly: 30, quarterly: 91, annually: 365, on_due_date: 365 }[r.frequency] || 30;
  const next = addDays(r.next_charge_at || new Date(), step);
  await deps.supabase.from('assessment_autopay').update({
    next_charge_at: next,
    next_notice_at: addDays(next, -NOTICE_DAYS_TARGET),
    notice_sent_at: null,
    noticed_amount_cents: null,
    noticed_fee_cents: null,
    noticed_total_cents: null,
  }).eq('id', r.id);
}

async function recordRun(deps, autopayId, row) {
  const { error } = await deps.supabase.from('assessment_autopay_runs').insert({ autopay_id: autopayId, ...row });
  if (error) console.warn('[autopay] run log failed:', error.message);
}

async function cancel({ autopayId, by = 'homeowner', reason = null }, deps = defaultDeps()) {
  const { error } = await deps.supabase.from('assessment_autopay').update({
    status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: by,
    status_reason: reason, next_charge_at: null, next_notice_at: null,
  }).eq('id', autopayId);
  return { ok: !error, error: error && error.message };
}

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pretty = (d) => (d ? new Date(`${iso(d)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

/** What the portal shows a homeowner about their standing authorisation. */
async function statusForProperty(propertyId, deps = defaultDeps()) {
  const { data, error } = await deps.supabase.from('assessment_autopay')
    .select('id, status, status_reason, amount_mode, max_amount_cents, frequency, '
      + 'method_kind, card_funding, method_label, method_last4, next_charge_at, next_notice_at, '
      + 'notice_sent_at, noticed_amount_cents, noticed_fee_cents, noticed_total_cents, last_charge_at, last_charge_amount_cents, '
      + 'last_charge_status, authorized_at')
    .eq('property_id', propertyId)
    .in('status', ['pending_setup', 'active', 'paused', 'failed'])
    .order('created_at', { ascending: false }).limit(1)
    .maybeSingle();
  if (error) {
    // The table arrives with migration 383 (columns with 573). Its absence must
    // not break the balance card for everyone else.
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
