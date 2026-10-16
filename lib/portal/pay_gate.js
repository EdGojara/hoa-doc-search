// ============================================================================
// lib/portal/pay_gate.js — may this community's owners pay online from the portal?
// ----------------------------------------------------------------------------
// ONE decision, read by BOTH the homeowner portal's "Pay now" button (via
// /api/portal/me payments_enabled) and the server's /api/portal/pay/checkout.
// The button used to show whenever stripe_connected_account_id existed, while
// checkout asked something else, so an owner could be offered a payment the
// association was not ready to take (Waterview: account exists, ledger not
// converted).
//
// Ed's activation gate (2026-10-16): a community takes portal payments only when
//   1. the per-community switch communities.portal_pay_enabled is ON
//      (migration 540, DEFAULT FALSE, never turned on by a migration; Ed turns
//      it on per community after ownership, conversion, AR and bank checks),
//   2. financial work is active for it (lifecycle canDo('payments')),
//   3. it has a connected Stripe account whose onboarding is complete:
//      charges AND payouts enabled, as Stripe reports it right now, and
//   4. that account lives in the same mode as the server key (retrievable with
//      it), and in production the server key is a LIVE key.
// Any failure → no button, and checkout refuses with the reason.
//
// evaluatePayGate() is pure so the rules can be tested without Stripe or a
// database. portalPayGate() gathers the facts (Stripe status cached briefly so
// /me does not call Stripe on every page load).
// ============================================================================

const STRIPE_CACHE = new Map();
const STRIPE_TTL_MS = 5 * 60 * 1000;

function serverKeyMode(key = process.env.STRIPE_SECRET_KEY) {
  const k = String(key || '');
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return null;
}

/**
 * @param {object} f
 *   community      { id, name, portal_pay_enabled, stripe_connected_account_id }
 *   lifecycle      { allowed, reason } from canDo('payments')
 *   stripe         { ok, charges_enabled, payouts_enabled } from retrieveAccount (null = not checked)
 *   keyMode        'live' | 'test' | null
 *   isProduction   boolean
 * @returns {{ enabled: boolean, reason: string|null, code: string|null }}
 */
function evaluatePayGate({ community, lifecycle, stripe, keyMode, isProduction }) {
  const no = (code, reason) => ({ enabled: false, code, reason });
  if (!community) return no('no_community', 'No community on file for this property.');
  const name = community.name || 'this community';
  if (community.portal_pay_enabled !== true) {
    return no('pay_not_enabled', `Online payments are not turned on for ${name} yet.`);
  }
  if (lifecycle && lifecycle.allowed === false) {
    return no('community_not_taking_payments', lifecycle.reason || `Online payments are switched off for ${name}.`);
  }
  if (!community.stripe_connected_account_id) {
    return no('stripe_not_onboarded', `${name} has no payment account set up.`);
  }
  if (!keyMode) return no('stripe_not_configured', 'Online payments are not configured on this server.');
  if (isProduction && keyMode !== 'live') {
    return no('stripe_not_live', 'Online payments are not in live mode on this server.');
  }
  if (!stripe || !stripe.ok) {
    // Not retrievable with this key: wrong mode (a test account under a live key
    // or the reverse), deleted, or Stripe unreachable. Refuse either way.
    return no('stripe_account_unavailable', `${name}'s payment account could not be confirmed.`);
  }
  if (!stripe.charges_enabled || !stripe.payouts_enabled) {
    return no('stripe_onboarding_incomplete', `${name}'s payment account has not finished setup.`);
  }
  return { enabled: true, code: null, reason: null };
}

async function stripeStatus(accountId, { fresh = false } = {}) {
  const hit = STRIPE_CACHE.get(accountId);
  if (!fresh && hit && (Date.now() - hit.at) < STRIPE_TTL_MS) return hit.value;
  const { retrieveAccount } = require('../payments/stripe');
  const value = await retrieveAccount(accountId);
  // Only cache a definite answer; a transient failure is re-asked next time.
  if (value && value.ok) STRIPE_CACHE.set(accountId, { at: Date.now(), value });
  return value;
}

/**
 * Gather the facts and decide. `community` must carry id, name,
 * portal_pay_enabled, stripe_connected_account_id. `fresh` skips the Stripe
 * cache (checkout uses it; the page render does not).
 */
async function portalPayGate(community, { fresh = false } = {}) {
  const base = { community, keyMode: serverKeyMode(), isProduction: process.env.NODE_ENV === 'production' };
  // Cheap checks first: with the switch off (the default) nothing else runs,
  // so /me never calls Stripe for a community that is not live.
  const pre = evaluatePayGate({ ...base, lifecycle: null, stripe: { ok: true, charges_enabled: true, payouts_enabled: true } });
  if (!pre.enabled) return pre;
  const { canDo } = require('../community/lifecycle');
  const lifecycle = await canDo('payments', community.id);
  let stripe = null;
  try { stripe = await stripeStatus(community.stripe_connected_account_id, { fresh }); }
  catch (e) { stripe = { ok: false, error: e.message }; }
  return evaluatePayGate({ ...base, lifecycle, stripe });
}

/**
 * Load the community's pay facts by id and decide. Read separately from the
 * page's community query on purpose: portal_pay_enabled arrives with migration
 * 540, and naming an unknown column fails the WHOLE PostgREST query. Until the
 * migration runs, the read fails here alone and the answer is "off".
 */
async function portalPayGateForCommunityId(supabase, communityId, opts = {}) {
  if (!communityId) return evaluatePayGate({ community: null });
  const { data, error } = await supabase.from('communities')
    .select('id, name, stripe_connected_account_id, portal_pay_enabled')
    .eq('id', communityId).maybeSingle();
  if (error) {
    if (!/does not exist|schema cache/i.test(error.message || '')) console.warn('[pay_gate] community lookup failed:', error.message);
    return { enabled: false, code: 'pay_not_enabled', reason: 'Online payments are not turned on for this community yet.' };
  }
  return portalPayGate(data, opts);
}

module.exports = { evaluatePayGate, portalPayGate, portalPayGateForCommunityId, serverKeyMode };
