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
// ============================================================================
'use strict';
const crypto = require('crypto');
const { resolvePayableAssessment } = require('./assessment_checkout');
const FQ = require('./fee_quote');

const FLOW = 'payment_element';
const PM_ID = /^pm_[A-Za-z0-9_]{6,}$/;

// The publishable key under its standard name or a common alias, so an existing
// Render setting is reused instead of asking for a duplicate (Ed 2026-11-21).
const PK_ENV_NAMES = ['STRIPE_PUBLISHABLE_KEY', 'STRIPE_PUBLIC_KEY', 'STRIPE_PK', 'STRIPE_PUBLISHABLE', 'STRIPE_KEY_PUBLISHABLE', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'VITE_STRIPE_PUBLISHABLE_KEY'];
function publishableKeyFor(mode, env = process.env) {
  const name = PK_ENV_NAMES.find((n) => String(env[n] || '').trim());
  const pk = name ? String(env[name]).trim() : '';
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
    fee_schedule: {
      card: c.card_fee_bps > 0 ? `${FQ.pctText(c.card_fee_bps)}% processing fee on card payments` : 'No processing fee on card payments',
      debit: c.debit_card_fee_bps != null ? (c.debit_card_fee_bps > 0 ? `${FQ.pctText(c.debit_card_fee_bps)}% processing fee on debit and prepaid cards` : 'No processing fee on debit or prepaid cards') : null,
      ach: FQ.achScheduleText(c),
    },
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
async function clearInFlight(deps, propertyId) {
  const { supabase, stripeLib } = deps;
  const { data, error } = await supabase.from('payments')
    .select('payment_group_id, settlement_state, processor_payment_id, processor_session_id, processor_metadata, created_at')
    .eq('property_id', propertyId).eq('product_type', 'assessment_payment').eq('fee_type', 'assessment')
    .in('settlement_state', ['awaiting_payment', 'processing'])
    .order('created_at', { ascending: false }).limit(25);
  if (error) throw new Error(`[assessment_intent] in-flight lookup failed: ${error.message}`);
  for (const row of data || []) {
    if (row.settlement_state === 'processing') {
      return { ok: false, status: 409, error: 'payment_in_progress', hint: 'A bank payment on this account is still processing. Please wait for it to clear before paying again.' };
    }
    const flow = row.processor_metadata && row.processor_metadata.flow;
    if (flow !== FLOW || !row.processor_payment_id) continue;   // open Checkout sessions expire on their own
    const r = await stripeLib.retrievePaymentIntent(row.processor_payment_id);
    if (!r.ok) throw new Error(`[assessment_intent] could not check earlier attempt: ${r.error}`);
    const st = r.payment_intent.status;
    if (st === 'succeeded' || st === 'processing') {
      return { ok: false, status: 409, error: 'payment_in_progress', hint: 'A payment on this account was just made and is being confirmed. Please refresh in a minute before paying again.' };
    }
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(st)) {
      const c = await stripeLib.cancelPaymentIntent(row.processor_payment_id, 'abandoned');
      if (!c.ok) throw new Error(`[assessment_intent] could not cancel earlier attempt: ${c.error}`);
    }
    await failGroup(supabase, row.payment_group_id, 'failed', 'superseded by a newer payment attempt');
  }
  return { ok: true };
}

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
  const feeType = { card_fee: 'card_fee', ach_fee: 'ach_fee' }[quote.fee_kind] || null;
  const recordMeta = { flow: FLOW, fee_kind: quote.fee_kind, card_funding: quote.funding, fee_bps: quote.fee_bps, disclosure: quote.disclosure };
  const common = {
    community_id: community.id, product_type: 'assessment_payment', product_id: identity.property.id,
    // payments.method allows one Stripe value ('stripe_checkout'); the surface is
    // recorded in processor_metadata.flow.
    method: 'stripe_checkout', processor: 'stripe', status: 'pending', initiated_by: opts.initiatedBy,
    payment_group_id: groupId, property_id: identity.property.id, tenure_id: identity.tenure.id,
    contact_id: identity.contact_id, trusted_account_number: identity.property.trusted_account_number,
    portal_user_id: opts.portalUserId || null, payment_method_type: quote.method_kind, livemode: mode === 'live',
    settlement_state: 'awaiting_payment', posting_state: 'not_posted', processor_metadata: recordMeta,
  };
  const assocName = community.hoa_legal_name || community.name;
  const rows = [{ ...common, fee_type: 'assessment', payee: 'community_association', amount_cents: quote.assessment_cents,
    payee_display_name: assocName, connected_account_id: community.stripe_connected_account_id }];
  if (quote.fee_cents > 0) rows.push({ ...common, fee_type: feeType, payee: 'management_company', amount_cents: quote.fee_cents,
    payee_display_name: 'Bedrock Association Management', connected_account_id: null });
  const { error: insErr } = await supabase.from('payments').insert(rows);
  if (insErr) {
    console.error('[assessment_intent] payment ledger insert failed:', insErr.message);
    return { ok: false, status: 500, error: 'payment_ledger_insert_failed' };
  }

  const description = quote.fee_cents > 0
    ? `Assessment payment ${usd(quote.assessment_cents)} + ${quote.fee_label} ${usd(quote.fee_cents)}, ${community.name}`
    : `Assessment payment ${usd(quote.assessment_cents)}, ${community.name}`;
  const r = await stripeLib.createAssessmentPaymentIntent({
    amountCents: quote.total_cents, applicationFeeCents: quote.fee_cents,
    connectedAccountId: community.stripe_connected_account_id, paymentMethodId: b.pm.id, methodKind: quote.method_kind,
    chargeFor: (community.slug || community.name || 'BEDROCK').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 22),
    description, returnUrl: opts.returnUrl, mandate: opts.mandate, idempotencyKey: `asmt-pi-${groupId}`,
    communityId: community.id, sandboxPropertyId: identity.property.id,
    metadata: {
      product_type: 'assessment_payment', product_id: identity.property.id,
      reference_number: `ASMT-${identity.property.trusted_account_number}`,
      community_id: community.id, community_name: community.name,
      payment_group_id: groupId, tenure_id: identity.tenure.id, property_id: identity.property.id,
      trusted_account_number: identity.property.trusted_account_number, initiated_by: opts.initiatedBy,
      payment_flow: FLOW, fee_kind: quote.fee_kind, card_funding: quote.funding || '',
      assessment_cents: String(quote.assessment_cents), fee_cents: String(quote.fee_cents),
    },
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

module.exports = {
  PK_ENV_NAMES, setupAssessmentPayment, quoteAssessmentPayment, confirmAssessmentPayment, publishableKeyFor, FLOW };
