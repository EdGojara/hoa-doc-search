// ============================================================================
// lib/payments/assessment_intent.js  (Ed 2026-11-21)
// ----------------------------------------------------------------------------
// Funding-aware homeowner assessment payment: the payment method is collected
// FIRST (Stripe Payment Element, deferred intent, paymentMethodCreation
// 'manual'), the server reads its funding type, lib/payments/fee_quote.js sets
// the fee for that type, the homeowner reviews assessment / fee / total, and
// only then is a PaymentIntent created and confirmed here, server-side.
//
// Why not a SetupIntent: nothing needs to be saved for later, and a SetupIntent
// would add a second Stripe object (and a mandate for ACH) to every payment.
// The deferred-intent Payment Element produces a plain PaymentMethod with no
// money moved and no amount fixed, which is exactly what the quote needs.
//
// Same architecture as Checkout (lib/payments/assessment_checkout.js):
//   * identical gates: resolvePayableAssessment (identity, mode gate,
//     financial_access, connected account, balance), plus a valid per-association
//     fee config (fail-closed)
//   * destination charge: on_behalf_of + transfer_data.destination = the
//     association; Bedrock's fee = application_fee_amount
//   * payments rows written BEFORE the PaymentIntent exists: one 'assessment'
//     row (community_association) + one fee row (management_company) when the
//     fee is non-zero, same payment_group_id, settlement_state 'awaiting_payment'
//   * nothing is credited here. payment_intent.succeeded / processing /
//     payment_failed drive the ledger (lib/payments/payment_lifecycle.js).
//
// Every PaymentIntent from this flow carries metadata.payment_flow =
// 'payment_element'. That is how the webhook tells it apart from a Checkout
// PaymentIntent, which settles only through its checkout.session.* events.
//
// One PaymentIntent per attempt. A decline at confirm cancels that
// PaymentIntent and fails its group, so it can never be re-confirmed later; a
// retry is a new quote and a new group. Before a new attempt, an earlier
// attempt left waiting (abandoned 3-D Secure) is cancelled, and an attempt that
// is processing or already paid blocks a second payment.
//
// AUTOPAY (Ed 2026-11-21) runs through this same file, so a recurring payment
// can never drift from a one-time one: autopayQuote() applies the identical
// gates (resolvePayableAssessment: identity, mode gate, financial_access
// payments switch, connected account, balance) and the identical fee
// (FQ.computeFee on the actual amount, by the saved method's kind and card
// funding); chargeAutopayAssessment() writes the identical payments rows and
// creates the identical destination-charge PaymentIntent, off-session against
// the method saved on the platform customer, with metadata.payment_flow
// 'autopay'. Settlement and posting come only from the webhook
// (payment_lifecycle.js), exactly as for a one-time payment. Charges run only
// when AUTOPAY_CHARGES_ENABLED=true (default OFF).
// ============================================================================
'use strict';
const crypto = require('crypto');
const { resolvePayableAssessment } = require('./assessment_checkout');
const FQ = require('./fee_quote');

const FLOW = 'payment_element';
const AUTOPAY_FLOW = 'autopay';
// Flows whose PaymentIntent we create server-side and settle from payment_intent.* events.
const DIRECT_FLOWS = [FLOW, AUTOPAY_FLOW];

// The ONE switch for automatic payments: enrollment, advance notices and
// charges all refuse unless it is exactly 'true'. Default OFF, so production
// stays off until live autopay is approved.
function autopayChargesEnabled(env = process.env) {
  return String((env && env.AUTOPAY_CHARGES_ENABLED) || '').trim().toLowerCase() === 'true';
}
// Per community (Ed 2026-11-22): the global switch, OR Stripe TEST mode for a
// demo community (Drama Creek), so autopay can be verified in the sandbox
// without turning recurring charges on for any real association. Under a live
// key a demo community is never allowed (the switch alone governs real ones).
function autopayAllowedFor(community, env = process.env) {
  if (autopayChargesEnabled(env)) return true;
  const testKey = /^sk_test_/.test(String((env && env.STRIPE_SECRET_KEY) || ''));
  return testKey && !!(community && community.is_demo === true);
}
const PM_ID = /^pm_[A-Za-z0-9_]{6,}$/;

function publishableKeyFor(mode, env = process.env) {
  const pk = String(env.STRIPE_PUBLISHABLE_KEY || '').trim();
  if (!pk) return { ok: false, status: 503, error: 'publishable_key_not_configured', hint: 'Online card and bank payment is not set up on this server yet.' };
  const pkMode = pk.startsWith('pk_live_') ? 'live' : pk.startsWith('pk_test_') ? 'test' : 'bad';
  if (pkMode !== mode) {
    console.error(`[assessment_intent] STRIPE_PUBLISHABLE_KEY mode (${pkMode}) does not match the secret key (${mode}); refusing`);
    return { ok: false, status: 503, error: 'publishable_key_mode_mismatch', hint: 'Online payment is temporarily unavailable.' };
  }
  return { ok: true, key: pk };
}

function feeConfigOrRefuse(community) {
  const fc = FQ.feeConfigFromCommunity(community);
  if (!fc.ok) {
    console.warn(`[assessment_intent] refused: ${fc.error} (${fc.detail}) community=${community.id}`);
    return { ok: false, status: 409, error: 'payment_fees_not_configured', hint: FQ.NOT_CONFIGURED_HINT };
  }
  return fc;
}

// resolvePaymentIdentity selects only the columns it needs; the fee config lives
// on portal_module_config, read here.
async function loadFeeConfig(supabase, community) {
  const { data, error } = await supabase.from('communities').select('id, portal_module_config').eq('id', community.id).maybeSingle();
  if (error) throw new Error(`[assessment_intent] fee config lookup failed: ${error.message}`);
  return feeConfigOrRefuse({ id: community.id, portal_module_config: data && data.portal_module_config });
}

const usd = (c) => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// POST /pay/setup: what the Payment Element needs. No Stripe object is created.
async function setupAssessmentPayment(deps, { propertyId, initiatedBy, testAmountCents = null, env = process.env }) {
  const pr = await resolvePayableAssessment(deps, { propertyId, initiatedBy, testAmountCents });
  if (!pr.ok) return pr;
  const fc = await loadFeeConfig(deps.supabase, pr.community);
  if (!fc.ok) return fc;
  const pk = publishableKeyFor(pr.mode, env);
  if (!pk.ok) return pk;
  const c = fc.config;
  return {
    ok: true,
    publishable_key: pk.key,
    mode: pr.mode,
    // Elements deferred-intent options (stripe.elements({...})).
    elements: { mode: 'payment', amount: pr.amount, currency: 'usd', paymentMethodCreation: 'manual',
      onBehalfOf: pr.community.stripe_connected_account_id, paymentMethodTypes: ['card', 'us_bank_account'] },
    assessment_cents: pr.amount,
    association_name: pr.community.hoa_legal_name || pr.community.name,
    // Plain-language fee schedule shown BEFORE the homeowner enters anything.
    fee_schedule: feeSchedule(c),
  };
}

// Plain-language fee schedule (one-time Pay page and autopay enrollment).
function feeSchedule(c) {
  return {
    card: c.card_fee_bps > 0 ? `${FQ.pctText(c.card_fee_bps)}% processing fee on card payments` : 'No processing fee on card payments',
    debit: c.debit_card_fee_bps != null ? (c.debit_card_fee_bps > 0 ? `${FQ.pctText(c.debit_card_fee_bps)}% processing fee on debit and prepaid cards` : 'No processing fee on debit or prepaid cards') : null,
    ach: FQ.achScheduleText(c),
  };
}

// Shared by quote and confirm: every number recomputed from the database and
// Stripe's own PaymentMethod, never from the request.
async function buildQuote(deps, { propertyId, initiatedBy, paymentMethodId, testAmountCents = null }) {
  if (!PM_ID.test(String(paymentMethodId || ''))) return { ok: false, status: 400, error: 'payment_method_id_required' };
  const pr = await resolvePayableAssessment(deps, { propertyId, initiatedBy, testAmountCents });
  if (!pr.ok) return pr;
  const fc = await loadFeeConfig(deps.supabase, pr.community);
  if (!fc.ok) return fc;
  const r = await deps.stripeLib.retrievePaymentMethod(paymentMethodId);
  if (!r.ok) {
    console.warn(`[assessment_intent] payment method lookup failed: ${r.error}`);
    return { ok: false, status: r.skipped ? 503 : 400, error: 'payment_method_not_found', hint: 'We could not read that card or bank account. Please enter it again.' };
  }
  const pm = r.payment_method;
  // Only a freshly collected, unattached method. A method saved to some
  // customer is not this homeowner's to spend.
  if (pm.customer) return { ok: false, status: 400, error: 'payment_method_not_usable', hint: 'Please enter your card or bank account again.' };
  const cls = FQ.classifyPaymentMethod(pm);
  if (!cls.ok) return { ok: false, status: 400, error: cls.error, hint: 'Only cards and US bank accounts can be used.' };
  const fee = FQ.computeFee({ assessmentCents: pr.amount, config: fc.config, methodKind: cls.method_kind, funding: cls.funding });
  const quote = {
    assessment_cents: pr.amount, fee_cents: fee.fee_cents, fee_kind: fee.fee_kind, fee_label: fee.fee_label,
    disclosure: fee.disclosure, total_cents: pr.amount + fee.fee_cents, method_kind: cls.method_kind,
    funding: cls.funding, method_display: cls.display, fee_bps: fee.fee_bps || 0,
    association_name: pr.community.hoa_legal_name || pr.community.name,
  };
  return { ok: true, pr, pm, quote };
}

function tokenFor(pr, pmId, q) {
  return FQ.signQuote({ v: 1, p: pr.identity.property.id, t: pr.identity.tenure.id, pm: pmId, k: q.method_kind,
    f: q.funding, a: q.assessment_cents, fee: q.fee_cents, tot: q.total_cents });
}

// POST /pay/quote
async function quoteAssessmentPayment(deps, opts) {
  const b = await buildQuote(deps, opts);
  if (!b.ok) return b;
  return { ok: true, ...b.quote, quote_token: tokenFor(b.pr, b.pm.id, b.quote) };
}

// Refuse a second payment while one is in flight; clear abandoned attempts.
// Applies in BOTH directions: a one-time payment refuses while an autopay
// charge is processing (or paid and not yet settled), and an autopay charge
// refuses while a one-time payment is. forAutopay is stricter, because the
// homeowner is not there to see it: an open Checkout session, or a recent
// one-time attempt waiting on 3-D Secure, also blocks the charge (it retries on
// the next run) instead of being cancelled from under the homeowner.
const RECENT_MS = 24 * 60 * 60 * 1000;
async function clearInFlight(deps, propertyId, { forAutopay = false, excludeGroupId = null, now = Date.now() } = {}) {
  const { supabase, stripeLib } = deps;
  const { data, error } = await supabase.from('payments')
    .select('payment_group_id, settlement_state, processor_payment_id, processor_session_id, processor_metadata, created_at')
    .eq('property_id', propertyId).eq('product_type', 'assessment_payment').eq('fee_type', 'assessment')
    .in('settlement_state', ['awaiting_payment', 'processing'])
    .order('created_at', { ascending: false }).limit(25);
  if (error) throw new Error(`[assessment_intent] in-flight lookup failed: ${error.message}`);
  for (const row of data || []) {
    if (excludeGroupId && row.payment_group_id === excludeGroupId) continue;
    const flow = row.processor_metadata && row.processor_metadata.flow;
    const auto = flow === AUTOPAY_FLOW;
    const busy = (hint) => ({ ok: false, status: 409, error: 'payment_in_progress', in_flight_group: row.payment_group_id, hint });
    if (row.settlement_state === 'processing') {
      return busy(auto ? 'An automatic payment on this account is still processing. Please wait for it to clear before paying again.'
        : 'A bank payment on this account is still processing. Please wait for it to clear before paying again.');
    }
    const recent = now - new Date(row.created_at || 0).getTime() < RECENT_MS;
    if (!DIRECT_FLOWS.includes(flow) || !row.processor_payment_id) {
      // Open Checkout sessions expire on their own. For autopay a recent one may be paid any minute.
      if (forAutopay && recent) return busy('A payment on this account was just started.');
      continue;
    }
    const r = await stripeLib.retrievePaymentIntent(row.processor_payment_id);
    if (!r.ok) throw new Error(`[assessment_intent] could not check earlier attempt: ${r.error}`);
    const st = r.payment_intent.status;
    if (st === 'succeeded' || st === 'processing') {
      return busy(auto ? 'An automatic payment on this account was just made and is being confirmed. Please refresh in a minute before paying again.'
        : 'A payment on this account was just made and is being confirmed. Please refresh in a minute before paying again.');
    }
    if (forAutopay && !auto && st === 'requires_action' && recent) return busy('The homeowner is completing a payment right now.');
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(st)) {
      const c = await stripeLib.cancelPaymentIntent(row.processor_payment_id, 'abandoned');
      if (!c.ok) throw new Error(`[assessment_intent] could not cancel earlier attempt: ${c.error}`);
    }
    await failGroup(supabase, row.payment_group_id, 'failed', 'superseded by a newer payment attempt');
  }
  return { ok: true };
}

// The payments rows for one assessment payment: the assessment
// (community_association) and, when non-zero, Bedrock's processing fee
// (management_company), one payment_group_id. Shared by one-time and autopay.
function paymentGroupRows({ groupId, pr, quote, initiatedBy, portalUserId = null, flow, extraMeta = {} }) {
  const { identity, community, mode } = pr;
  const feeType = { card_fee: 'card_fee', ach_fee: 'ach_fee' }[quote.fee_kind] || null;
  const recordMeta = { flow, fee_kind: quote.fee_kind, card_funding: quote.funding, fee_bps: quote.fee_bps, disclosure: quote.disclosure, ...extraMeta };
  const common = {
    community_id: community.id, product_type: 'assessment_payment', product_id: identity.property.id,
    // payments.method allows one Stripe value ('stripe_checkout'); the surface is
    // recorded in processor_metadata.flow.
    method: 'stripe_checkout', processor: 'stripe', status: 'pending', initiated_by: initiatedBy,
    payment_group_id: groupId, property_id: identity.property.id, tenure_id: identity.tenure.id,
    contact_id: identity.contact_id, trusted_account_number: identity.property.trusted_account_number,
    portal_user_id: portalUserId || null, payment_method_type: quote.method_kind, livemode: mode === 'live',
    settlement_state: 'awaiting_payment', posting_state: 'not_posted', processor_metadata: recordMeta,
  };
  const assocName = community.hoa_legal_name || community.name;
  const rows = [{ ...common, fee_type: 'assessment', payee: 'community_association', amount_cents: quote.assessment_cents,
    payee_display_name: assocName, connected_account_id: community.stripe_connected_account_id }];
  if (quote.fee_cents > 0) rows.push({ ...common, fee_type: feeType, payee: 'management_company', amount_cents: quote.fee_cents,
    payee_display_name: 'Bedrock Association Management', connected_account_id: null });
  return rows;
}

// PaymentIntent metadata the webhook settles by. Shared by one-time and autopay.
function intentMetadata({ groupId, pr, quote, initiatedBy, flow, extra = {} }) {
  const { identity, community } = pr;
  return {
    product_type: 'assessment_payment', product_id: identity.property.id,
    reference_number: `ASMT-${identity.property.trusted_account_number}`,
    community_id: community.id, community_name: community.name,
    payment_group_id: groupId, tenure_id: identity.tenure.id, property_id: identity.property.id,
    trusted_account_number: identity.property.trusted_account_number, initiated_by: initiatedBy,
    payment_flow: flow, fee_kind: quote.fee_kind, card_funding: quote.funding || '',
    assessment_cents: String(quote.assessment_cents), fee_cents: String(quote.fee_cents),
    ...extra,
  };
}

const chargeForOf = (community) => (community.slug || community.name || 'BEDROCK').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 22);
const descriptionOf = (quote, community, prefix) => (quote.fee_cents > 0
  ? `${prefix} ${usd(quote.assessment_cents)} + ${quote.fee_label} ${usd(quote.fee_cents)}, ${community.name}`
  : `${prefix} ${usd(quote.assessment_cents)}, ${community.name}`);

async function failGroup(supabase, groupId, state, reason) {
  const { error } = await supabase.from('payments')
    .update({ settlement_state: state, status: state === 'checkout_failed' ? 'cancelled' : 'failed', failure_reason: String(reason || '').slice(0, 300) })
    .eq('payment_group_id', groupId).eq('settlement_state', 'awaiting_payment');
  if (error) console.error(`[assessment_intent] could not mark group ${groupId} ${state}:`, error.message);
}

// POST /pay/confirm
// opts: { propertyId, initiatedBy, paymentMethodId, quoteToken, payer, portalUserId,
//         testAmountCents, returnUrl, mandate: { ip, userAgent } }
async function confirmAssessmentPayment(deps, opts) {
  const { supabase, stripeLib } = deps;
  const v = FQ.verifyQuote(opts.quoteToken);
  if (!v.ok) return { ok: false, status: v.error === 'quote_expired' ? 409 : 400, error: v.error, hint: 'Please review your payment again.' };
  const tq = v.quote;
  if (String(tq.p) !== String(opts.propertyId) || tq.pm !== opts.paymentMethodId) {
    return { ok: false, status: 400, error: 'quote_mismatch', hint: 'Please review your payment again.' };
  }
  const b = await buildQuote(deps, opts);
  if (!b.ok) return b;
  const { pr, quote } = b;
  const { identity, community, mode } = pr;
  if (tq.t !== identity.tenure.id || tq.a !== quote.assessment_cents || tq.fee !== quote.fee_cents
      || tq.tot !== quote.total_cents || tq.k !== quote.method_kind) {
    console.warn(`[assessment_intent] quote changed between review and confirm (property=${identity.property.id}); asking the homeowner to re-review`);
    return { ok: false, status: 409, error: 'quote_changed', hint: 'The amount changed since you reviewed it. Please review the new total.',
      quote: { ...quote, quote_token: tokenFor(pr, b.pm.id, quote) } };
  }

  const inflight = await clearInFlight(deps, identity.property.id);
  if (!inflight.ok) return inflight;

  const groupId = crypto.randomUUID();
  const rows = paymentGroupRows({ groupId, pr, quote, initiatedBy: opts.initiatedBy, portalUserId: opts.portalUserId, flow: FLOW });
  const { error: insErr } = await supabase.from('payments').insert(rows);
  if (insErr) {
    console.error('[assessment_intent] payment ledger insert failed:', insErr.message);
    return { ok: false, status: 500, error: 'payment_ledger_insert_failed' };
  }

  const r = await stripeLib.createAssessmentPaymentIntent({
    amountCents: quote.total_cents, applicationFeeCents: quote.fee_cents,
    connectedAccountId: community.stripe_connected_account_id, paymentMethodId: b.pm.id, methodKind: quote.method_kind,
    chargeFor: chargeForOf(community), description: descriptionOf(quote, community, 'Assessment payment'),
    returnUrl: opts.returnUrl, mandate: opts.mandate, idempotencyKey: `asmt-pi-${groupId}`,
    communityId: community.id, sandboxPropertyId: identity.property.id,
    metadata: intentMetadata({ groupId, pr, quote, initiatedBy: opts.initiatedBy, flow: FLOW }),
  });

  if (!r.ok) {
    if (r.payment_intent_id) {
      const { error: pe } = await supabase.from('payments').update({ processor_payment_id: r.payment_intent_id }).eq('payment_group_id', groupId);
      if (pe) console.error('[assessment_intent] PI id not recorded:', pe.message);
      // Cancel so this declined attempt can never be confirmed later.
      const c = await stripeLib.cancelPaymentIntent(r.payment_intent_id, 'abandoned');
      if (!c.ok) console.error(`[assessment_intent] could not cancel declined PI ${r.payment_intent_id}: ${c.error}`);
      await failGroup(supabase, groupId, 'failed', r.error || 'payment declined');
      return { ok: false, status: 402, error: r.declined ? 'payment_declined' : 'payment_failed', group_id: groupId,
        hint: r.declined ? `${r.error || 'Your card was declined.'} Please try another card or a bank account.` : 'The payment could not be completed. Please try again.' };
    }
    await failGroup(supabase, groupId, 'checkout_failed', r.error || 'payment intent not created');
    console.error(`[assessment_intent] payment intent not created: ${r.error}`);
    return { ok: false, status: r.skipped || r.suppressed ? 503 : 502, error: 'payment_failed', hint: 'The payment could not be started. Please try again.' };
  }

  const pi = r.payment_intent;
  const { error: idErr } = await supabase.from('payments').update({ processor_payment_id: pi.id }).eq('payment_group_id', groupId);
  if (idErr) console.error('[assessment_intent] PI id not recorded (webhook still matches by group id):', idErr.message);

  const base = { group_id: groupId, payment_intent_id: pi.id, status: pi.status, quote };
  if (pi.status === 'requires_action') return { ok: true, ...base, client_secret: pi.client_secret };
  if (pi.status === 'succeeded' || pi.status === 'processing') return { ok: true, ...base };
  // requires_payment_method etc. after a "successful" create = a failed attempt.
  const c = await stripeLib.cancelPaymentIntent(pi.id, 'abandoned');
  if (!c.ok) console.error(`[assessment_intent] could not cancel PI ${pi.id}: ${c.error}`);
  await failGroup(supabase, groupId, 'failed', `payment intent ${pi.status}`);
  return { ok: false, status: 402, error: 'payment_failed', group_id: groupId, hint: 'The payment could not be completed. Please try another card or a bank account.' };
}

// ============================================================================
// AUTOPAY (Ed 2026-11-21): the same gates, fee, rows and PaymentIntent as a
// one-time payment, charged off-session against the method the homeowner saved
// on the platform customer at enrollment (SetupIntent on_behalf_of = the
// association). lib/payments/autopay.js decides WHEN (notice, cap, cadence);
// this decides WHAT and HOW, so it cannot drift from the Pay page.
// ============================================================================
const BEDROCK_CANCEL_EMAIL = 'info@bedrocktx.com';

// The recurring-payment disclosure shown on the enrollment screen BEFORE the
// homeowner authorises, and stored verbatim on the enrollment. The version is a
// hash of the exact text, so enrollment refuses if the terms changed between
// what the homeowner read and what they authorised.
function autopayTerms(config, { associationName = 'your association' } = {}) {
  const fs = feeSchedule(config);
  const feeText = [fs.card, fs.debit, fs.ach].filter(Boolean).join('; ');
  const disclosure = [
    `Each automatic payment is your full account balance owed to ${associationName} on the scheduled payment date.`,
    `A processing fee is added to each payment. It is calculated on that payment's actual amount at the time of the charge, by your payment method, under the fee schedule in effect then. Today's schedule: ${feeText}.`,
    'At least 10 days before each payment, we email you the assessment amount, the processing fee for your payment method, the total that will be debited, and the date.',
    'If you set a maximum, it applies to the total debited including the fee. A payment above it is not taken: we stop and ask you instead.',
    'If the balance or the fee schedule changes after a notice, we send a new notice before charging the new amount.',
    `To cancel, turn off automatic payments in the portal, or email ${BEDROCK_CANCEL_EMAIL}, at least 3 business days before the scheduled payment date.`,
  ];
  const version = crypto.createHash('sha256').update(JSON.stringify(disclosure)).digest('hex').slice(0, 16);
  return { fee_schedule: fs, disclosure, version, cancel_email: BEDROCK_CANCEL_EMAIL };
}

// Enrollment gates: everything a charge needs except a balance (a standing
// authorisation can be set up while nothing is owed), plus a valid fee config.
// -> { ok:true, pr, config, terms } | { ok:false, status, error, hint }
async function autopayEnrollmentTerms(deps, { propertyId }) {
  const pr = await resolvePayableAssessment(deps, { propertyId, initiatedBy: 'autopay_enrollment', allowZeroBalance: true });
  if (!pr.ok) return pr;
  const fc = await loadFeeConfig(deps.supabase, pr.community);
  if (!fc.ok) return fc;
  const terms = autopayTerms(fc.config, { associationName: pr.community.hoa_legal_name || pr.community.name });
  return { ok: true, pr, config: fc.config, terms };
}

// What this cycle's charge would be, right now, through the one-time gates.
// -> { ok:true, pr, quote, feeFor(cents) }
//  | { ok:false, outcome: 'skipped_zero_balance' | 'skipped_not_payable', detail, cancel? }
async function autopayQuote(deps, autopay) {
  const notPayable = (detail, extra = {}) => ({ ok: false, outcome: 'skipped_not_payable', detail, ...extra });
  if (!autopay || !autopay.property_id) return notPayable('no enrollment');
  if (!['card', 'us_bank_account'].includes(autopay.method_kind) || !autopay.stripe_payment_method_id || !autopay.stripe_customer_id) {
    return notPayable('no saved payment method on this enrollment');
  }
  const pr = await resolvePayableAssessment(deps, { propertyId: autopay.property_id, initiatedBy: 'autopay' });
  if (!pr.ok) {
    if (pr.error === 'nothing_due') return { ok: false, outcome: 'skipped_zero_balance', detail: 'nothing owed' };
    return notPayable(`payment refused: ${pr.error}`);
  }
  // A sale ends the tenure and migration 469's trigger cancels the enrollment;
  // this is the belt to that braces.
  if (autopay.tenure_id && pr.identity.tenure.id !== autopay.tenure_id) {
    return notPayable('the owner on record changed; this authorisation belonged to the previous owner', { cancel: true });
  }
  // The saved method and its mandate are bound (on_behalf_of) to the account
  // the homeowner authorised. A different association account needs a new authorisation.
  if (!autopay.connected_account_id || autopay.connected_account_id !== pr.community.stripe_connected_account_id) {
    return notPayable('the association payment account changed since this was set up; the homeowner must set up automatic payments again');
  }
  const fc = await loadFeeConfig(deps.supabase, pr.community);
  if (!fc.ok) return notPayable('payment fees are not configured for this association');
  const funding = autopay.method_kind === 'card' ? (autopay.card_funding || 'unknown') : null;
  const feeOf = (cents) => FQ.computeFee({ assessmentCents: cents, config: fc.config, methodKind: autopay.method_kind, funding });
  const fee = feeOf(pr.amount);
  const quote = {
    assessment_cents: pr.amount, fee_cents: fee.fee_cents, fee_kind: fee.fee_kind, fee_label: fee.fee_label,
    disclosure: fee.disclosure, total_cents: pr.amount + fee.fee_cents, method_kind: autopay.method_kind,
    funding, fee_bps: fee.fee_bps || 0, association_name: pr.community.hoa_legal_name || pr.community.name,
  };
  return { ok: true, pr, quote, feeFor: (cents) => feeOf(cents).fee_cents };
}

// Idempotency per cycle: autopay id + the scheduled date. A re-run of the same
// cycle reuses the same payment group and the same Stripe idempotency key, so it
// can never raise a second charge.
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
function autopayCycleKey(autopay) {
  const day = isoDate(autopay && autopay.next_charge_at);
  return autopay && autopay.id && day ? `autopay-${autopay.id}-${day}` : null;
}
function groupIdForCycle(cycleKey) {
  const h = crypto.createHash('sha256').update(`trusted-autopay-group-v1:${cycleKey}`).digest('hex');
  // RFC 4122 shape (version 5-style, variant 10xx) so it fits a uuid column.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Charge one due cycle. The caller (autopay.js chargeDue) has already applied
// the Reg E notice gate and the homeowner's cap to this quote.
// -> { ok:true, outcome:'charged', group_id, payment_intent_id, status, replayed? }
//  | { ok:false, outcome:'disabled' | 'skipped_in_flight' | 'failed', reason, group_id? }
async function chargeAutopayAssessment(deps, { autopay, pr, quote, env = process.env }) {
  const { supabase, stripeLib } = deps;
  const { identity, community } = pr;
  if (!autopayAllowedFor(community, env)) return { ok: false, outcome: 'disabled', reason: 'autopay is not enabled for this association; nothing charged' };
  const cycleKey = autopayCycleKey(autopay);
  if (!cycleKey) return { ok: false, outcome: 'failed', reason: 'enrollment has no scheduled date' };
  const groupId = groupIdForCycle(cycleKey);

  // This cycle already attempted (a re-run, or a crash mid-way)?
  const { data: prior, error: pErr } = await supabase.from('payments')
    .select('fee_type, amount_cents, settlement_state, processor_payment_id').eq('payment_group_id', groupId).limit(5);
  if (pErr) throw new Error(`[assessment_intent] autopay cycle lookup failed: ${pErr.message}`);
  const priorAsmt = (prior || []).find((p) => p.fee_type === 'assessment');
  if (priorAsmt) {
    if (priorAsmt.processor_payment_id) {
      const pi = await stripeLib.retrievePaymentIntent(priorAsmt.processor_payment_id);
      if (!pi.ok) throw new Error(`[assessment_intent] could not check this cycle's earlier charge: ${pi.error}`);
      const st = pi.payment_intent.status;
      if (st === 'succeeded' || st === 'processing') return { ok: true, outcome: 'charged', replayed: true, group_id: groupId, payment_intent_id: pi.payment_intent.id, status: st };
      return { ok: false, outcome: 'failed', group_id: groupId, reason: `this cycle was already attempted (payment ${st})` };
    }
    if (['failed', 'checkout_failed', 'expired'].includes(priorAsmt.settlement_state)) {
      return { ok: false, outcome: 'failed', group_id: groupId, reason: 'this cycle was already attempted and failed' };
    }
    const priorFee = (prior || []).filter((p) => p.fee_type !== 'assessment').reduce((s, p) => s + Number(p.amount_cents || 0), 0);
    if (Number(priorAsmt.amount_cents) !== quote.assessment_cents || priorFee !== quote.fee_cents) {
      await failGroup(supabase, groupId, 'failed', 'autopay cycle amount changed before the charge was created');
      return { ok: false, outcome: 'failed', group_id: groupId, reason: 'the amount changed during an interrupted attempt; needs a person to look' };
    }
  }

  const inflight = await clearInFlight(deps, identity.property.id, { forAutopay: true, excludeGroupId: groupId });
  if (!inflight.ok) return { ok: false, outcome: 'skipped_in_flight', reason: inflight.hint || 'another payment is in progress', in_flight_group: inflight.in_flight_group };

  if (!priorAsmt) {
    const rows = paymentGroupRows({ groupId, pr, quote, initiatedBy: 'autopay', portalUserId: autopay.portal_user_id, flow: AUTOPAY_FLOW,
      extraMeta: { autopay_id: autopay.id, cycle: cycleKey } });
    const { error: insErr } = await supabase.from('payments').insert(rows);
    if (insErr) {
      console.error('[assessment_intent] autopay ledger insert failed:', insErr.message);
      return { ok: false, outcome: 'failed', reason: 'payment ledger insert failed' };
    }
  }

  const r = await stripeLib.createAssessmentPaymentIntent({
    amountCents: quote.total_cents, applicationFeeCents: quote.fee_cents,
    connectedAccountId: community.stripe_connected_account_id, paymentMethodId: autopay.stripe_payment_method_id,
    methodKind: autopay.method_kind, customerId: autopay.stripe_customer_id, offSession: true,
    mandateId: autopay.method_kind === 'us_bank_account' ? (autopay.mandate_reference || undefined) : undefined,
    chargeFor: chargeForOf(community), description: descriptionOf(quote, community, 'Automatic assessment payment'),
    idempotencyKey: cycleKey, communityId: community.id, sandboxPropertyId: identity.property.id,
    metadata: intentMetadata({ groupId, pr, quote, initiatedBy: 'autopay', flow: AUTOPAY_FLOW, extra: { autopay_id: autopay.id } }),
  });

  if (!r.ok) {
    if (r.payment_intent_id) {
      const { error: pe } = await supabase.from('payments').update({ processor_payment_id: r.payment_intent_id }).eq('payment_group_id', groupId);
      if (pe) console.error('[assessment_intent] autopay PI id not recorded:', pe.message);
      const c = await stripeLib.cancelPaymentIntent(r.payment_intent_id, 'abandoned');
      if (!c.ok) console.error(`[assessment_intent] could not cancel declined autopay PI ${r.payment_intent_id}: ${c.error}`);
    }
    const reason = r.stripeCode === 'authentication_required'
      ? 'the card issuer asked the cardholder to confirm this payment, which cannot happen automatically (authentication_required)'
      : (r.error || 'payment declined');
    await failGroup(supabase, groupId, r.payment_intent_id ? 'failed' : 'checkout_failed', reason);
    return { ok: false, outcome: 'failed', group_id: groupId, reason, suppressed: !!r.suppressed };
  }

  const pi = r.payment_intent;
  const { error: idErr } = await supabase.from('payments').update({ processor_payment_id: pi.id }).eq('payment_group_id', groupId);
  if (idErr) console.error('[assessment_intent] autopay PI id not recorded (webhook still matches by group id):', idErr.message);
  if (pi.status === 'succeeded' || pi.status === 'processing') {
    return { ok: true, outcome: 'charged', group_id: groupId, payment_intent_id: pi.id, status: pi.status };
  }
  // requires_action off-session = the issuer wants the cardholder present.
  const c = await stripeLib.cancelPaymentIntent(pi.id, 'abandoned');
  if (!c.ok) console.error(`[assessment_intent] could not cancel autopay PI ${pi.id}: ${c.error}`);
  const reason = pi.status === 'requires_action'
    ? 'the card issuer asked the cardholder to confirm this payment, which cannot happen automatically (authentication_required)'
    : `payment intent ${pi.status}`;
  await failGroup(supabase, groupId, 'failed', reason);
  return { ok: false, outcome: 'failed', group_id: groupId, payment_intent_id: pi.id, reason };
}

module.exports = {
  setupAssessmentPayment, quoteAssessmentPayment, confirmAssessmentPayment, publishableKeyFor, FLOW,
  AUTOPAY_FLOW, DIRECT_FLOWS, autopayChargesEnabled, autopayAllowedFor, autopayTerms, autopayEnrollmentTerms, autopayQuote,
  chargeAutopayAssessment, autopayCycleKey, groupIdForCycle, feeSchedule, clearInFlight,
};
