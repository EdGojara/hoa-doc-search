// ============================================================================
// lib/payments/payment_readiness.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// The ONE answer to "can this community take an online assessment payment right
// now?", and "is a payment already in flight for this lot?". The server is the
// source of truth: checkout refuses on it (lib/payments/assessment_checkout.js),
// and the portal shows or hides Pay from the same function, so the button can
// never offer a path the server refuses.
//
// Ready means ALL of:
//   * the server has a Stripe key (test or live)
//   * the community is not archived/ended and its financials are active
//   * communities.online_payments_enabled is ON (default OFF, migration 534)
//   * a connected account is on file, it can take charges AND pay out, and it
//     exists in the SAME mode as the server key (a test-mode account is invisible
//     to a live key and vice versa)
//
// Two ways to check the account:
//   verify: false (portal render) -> the cached columns kept by account.updated
//                                    (stripe_charges_enabled / _payouts_enabled /
//                                    _account_livemode). No Stripe call.
//   verify: true  (checkout)      -> retrieve the account from Stripe with the
//                                    server key. A successful retrieval proves
//                                    the mode matches; the cache is refreshed.
// Fails CLOSED: any lookup error is "not ready", never "ready".
// ============================================================================
const { stripeMode } = require('./stripe_mode');

// lib/community/lifecycle builds a Supabase client when it loads; require it only
// when a decision is made, so the pure parts of this module load anywhere.
const lifecycleEvaluate = (service, row) => require('../community/lifecycle').evaluate(service, row);

const COMMUNITY_SELECT = 'id, name, slug, hoa_legal_name, is_demo, management_status, management_end_date, financials_active, '
  + 'stripe_connected_account_id, online_payments_enabled, stripe_charges_enabled, stripe_payouts_enabled, stripe_account_livemode';

// The homeowner never sees these codes; the portal shows `message`.
const MESSAGES = {
  payment_not_configured: 'Online payment is not available yet.',
  community_not_found: 'Online payment is not available for this community.',
  community_not_taking_payments: 'Online payment is not available for this community.',
  online_payments_off: 'Online payment is not turned on for this community yet.',
  community_stripe_not_onboarded: 'Online payment is not set up for this community yet.',
  connected_account_charges_disabled: 'Online payment is temporarily unavailable for this community.',
  connected_account_payouts_disabled: 'Online payment is temporarily unavailable for this community.',
  connected_account_mode_mismatch: 'Online payment is not available for this community yet.',
  connected_account_unverified: 'Online payment is temporarily unavailable for this community.',
};

function notReady(reason, extra = {}) {
  return { ready: false, reason, message: MESSAGES[reason] || MESSAGES.payment_not_configured, ...extra };
}

/**
 * paymentsReadyFor(community | communityId, { supabase, stripeLib, key, verify })
 * -> { ready:true, mode, community } | { ready:false, reason, message, mode, detail? }
 */
async function paymentsReadyFor(communityOrId, { supabase, stripeLib = null, key = process.env.STRIPE_SECRET_KEY, verify = false, log = console, evaluate = lifecycleEvaluate } = {}) {
  const mode = stripeMode(key);
  if (mode === 'unconfigured') return notReady('payment_not_configured', { mode });

  let community = communityOrId && typeof communityOrId === 'object' ? communityOrId : null;
  // A passed-in row must carry every column the decision reads; otherwise reload it.
  if (!community || !('online_payments_enabled' in community) || !('financials_active' in community)) {
    const id = community ? community.id : communityOrId;
    if (!id || !supabase) return notReady('community_not_found', { mode });
    const { data, error } = await supabase.from('communities').select(COMMUNITY_SELECT).eq('id', id).maybeSingle();
    if (error) {
      log.error('[payments] readiness lookup failed:', error.message);
      return notReady('community_not_found', { mode, detail: 'lookup_failed' });
    }
    if (!data) return notReady('community_not_found', { mode });
    community = data;
  }

  const life = evaluate('payments', community);
  if (!life.allowed) return notReady('community_not_taking_payments', { mode, detail: life.reason });
  if (community.online_payments_enabled !== true) return notReady('online_payments_off', { mode });
  if (!community.stripe_connected_account_id) return notReady('community_stripe_not_onboarded', { mode });

  let charges = community.stripe_charges_enabled;
  let payouts = community.stripe_payouts_enabled;
  let accountLive = community.stripe_account_livemode;

  if (verify) {
    if (!stripeLib || typeof stripeLib.retrieveAccount !== 'function') return notReady('connected_account_unverified', { mode });
    const a = await stripeLib.retrieveAccount(community.stripe_connected_account_id);
    if (!a || !a.ok) {
      // Not found under this key = created in the other mode (or deleted).
      return notReady(a && a.not_found ? 'connected_account_mode_mismatch' : 'connected_account_unverified', { mode, detail: a && a.error ? String(a.error).slice(0, 200) : null });
    }
    charges = !!a.charges_enabled;
    payouts = !!a.payouts_enabled;
    accountLive = mode === 'live';
    if (supabase) {
      const { error: cErr } = await supabase.from('communities').update({
        stripe_charges_enabled: charges, stripe_payouts_enabled: payouts,
        stripe_account_livemode: accountLive, stripe_account_checked_at: new Date().toISOString(),
      }).eq('id', community.id);
      if (cErr) log.warn('[payments] readiness cache not refreshed:', cErr.message);
    }
  }

  if (typeof accountLive !== 'boolean') return notReady('connected_account_unverified', { mode });
  if (accountLive !== (mode === 'live')) return notReady('connected_account_mode_mismatch', { mode });
  if (charges !== true) return notReady('connected_account_charges_disabled', { mode });
  if (payouts !== true) return notReady('connected_account_payouts_disabled', { mode });
  return { ready: true, reason: null, message: null, mode, community };
}

// A Stripe Checkout Session lives at most 24 hours. An 'awaiting_payment' group
// older than this can no longer be paid, whatever our row still says.
const CHECKOUT_MAX_AGE_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000;

/**
 * In-flight assessment checkouts for a lot + owner tenure, one entry per payment
 * group: { payment_group_id, settlement_state, amount_cents (group total),
 * assessment_cents, method, session_id, created_at, stale }.
 */
async function inFlightAssessmentPayments(supabase, { propertyId, tenureId = null, now = Date.now() }) {
  let q = supabase.from('payments')
    .select('id, payment_group_id, settlement_state, amount_cents, fee_type, payment_method_type, processor_session_id, created_at, tenure_id')
    .eq('product_type', 'assessment_payment').eq('property_id', propertyId)
    .in('settlement_state', ['awaiting_payment', 'processing'])
    .not('payment_group_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(50);
  if (tenureId) q = q.eq('tenure_id', tenureId);
  const { data, error } = await q;
  if (error) throw new Error(`[payments] in-flight lookup failed: ${error.message}`);
  const groups = new Map();
  for (const r of data || []) {
    const g = groups.get(r.payment_group_id) || { payment_group_id: r.payment_group_id, settlement_state: r.settlement_state, amount_cents: 0,
      assessment_cents: 0, method: r.payment_method_type, session_id: r.processor_session_id || null, created_at: r.created_at };
    g.amount_cents += Number(r.amount_cents || 0);
    if (r.fee_type === 'assessment') g.assessment_cents += Number(r.amount_cents || 0);
    if (r.settlement_state === 'processing') g.settlement_state = 'processing';
    groups.set(r.payment_group_id, g);
  }
  return [...groups.values()].map((g) => ({ ...g,
    stale: g.settlement_state === 'awaiting_payment' && now - new Date(g.created_at).getTime() > CHECKOUT_MAX_AGE_MS }));
}

/**
 * What the portal shows next to the balance for one lot. Server-side, one call:
 *   { payments_enabled, message, pending: null | { amount_cents, since, method, label } }
 * `pending` is ONLY money the homeowner has actually submitted (ACH processing):
 * the balance does not drop until Stripe settles it, so the portal says
 * "payment processing" instead of inviting a second payment.
 */
async function portalPaymentState(supabase, { communityId, propertyId, tenureId = null, log = console }) {
  const ready = await paymentsReadyFor(communityId, { supabase, verify: false, log });
  let pending = null;
  if (propertyId) {
    try {
      const inflight = await inFlightAssessmentPayments(supabase, { propertyId, tenureId });
      const p = inflight.find((g) => g.settlement_state === 'processing');
      if (p) pending = { amount_cents: p.assessment_cents, since: p.created_at, method: p.method, label: 'Payment processing' };
    } catch (e) {
      log.warn('[payments] pending payment lookup failed:', e.message);
    }
  }
  return { payments_enabled: ready.ready === true, message: ready.ready ? null : ready.message, pending };
}

module.exports = { paymentsReadyFor, inFlightAssessmentPayments, portalPaymentState, CHECKOUT_MAX_AGE_MS, COMMUNITY_SELECT };
