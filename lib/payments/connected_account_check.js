// ============================================================================
// lib/payments/connected_account_check.js  (Ed 2026-11-27, live activation E1)
// ----------------------------------------------------------------------------
// Does the connected account stored on a community exist in the Stripe mode the
// server is running in, and can it take charges right now?
//
// Why: a connected account created with a TEST key does not exist under a LIVE
// key, and the communities row looks identical either way. Before this check, a
// stored test account marked 'enabled' counted as Stripe-ready under a live key,
// and onboarding reused the dead id, so "Set up online payments" failed for every
// community that had been tried in the sandbox (Waterview, Quail Ridge, Canyon
// Gate, August Meadows on 2026-11-27).
//
// Every reader that decides "can this association be paid" asks here: the
// payment gate (resolvePayableAssessment), the portal's Pay button (/me), the
// onboarding route, and the status screens. FAIL-CLOSED: a lookup that cannot
// be completed is { ok:false } and callers refuse payment; only a definite
// "no such account" from Stripe is { exists:false }, and only that ever lets
// onboarding replace a stored id.
//
// Results are cached briefly per mode + account so the portal and the status
// screen do not call Stripe on every load. account.updated clears the entry.
// ============================================================================
'use strict';

const CACHE_TTL_MS = 2 * 60 * 1000;
const _cache = new Map();

// Stripe's answer when an account id is unknown to this key: HTTP 404 /
// resource_missing (wrong mode: "a similar object exists in test mode, but a
// live mode key was used"), or account_invalid / 403 (not connected to this
// platform). Anything else (network, 5xx, rate limit) is NOT proof of absence.
function isMissingAccountResult(r) {
  if (!r || r.ok) return false;
  if (r.missing === true) return true;
  const code = String(r.stripeCode || '');
  if (code === 'resource_missing' || code === 'account_invalid') return true;
  if (r.httpStatus === 404) return true;
  return /no such account|similar object exists in (test|live) mode|does not have access to account/i.test(String(r.error || ''));
}

function cacheKey(mode, accountId) { return `${mode}:${accountId}`; }

// -> { ok:true, exists:true, charges_enabled, payouts_enabled, details_submitted,
//      currently_due, past_due, disabled_reason }
//  | { ok:true, exists:false, reason:'not_found_in_mode', mode }
//  | { ok:false, error }
async function checkConnectedAccount(stripeLib, accountId, { mode, now = Date.now(), useCache = true } = {}) {
  if (!accountId) return { ok: true, exists: false, reason: 'no_account', mode };
  if (!stripeLib || typeof stripeLib.retrieveAccountRequirements !== 'function') return { ok: false, error: 'stripe_lookup_unavailable' };
  const key = cacheKey(mode, accountId);
  if (useCache) {
    const hit = _cache.get(key);
    if (hit && hit.expires > now) return hit.value;
  }
  let r;
  try { r = await stripeLib.retrieveAccountRequirements(accountId); }
  catch (e) { r = { ok: false, error: e.message }; }
  let value;
  if (r && r.ok) {
    value = { ok: true, exists: true, charges_enabled: !!r.charges_enabled, payouts_enabled: !!r.payouts_enabled,
      details_submitted: !!r.details_submitted, currently_due: r.currently_due || [], past_due: r.past_due || [],
      disabled_reason: r.disabled_reason || null };
  } else if (isMissingAccountResult(r)) {
    value = { ok: true, exists: false, reason: 'not_found_in_mode', mode };
  } else {
    console.warn(`[connected_account_check] lookup failed for ${accountId} (${mode}): ${(r && r.error) || 'unknown'}`);
    return { ok: false, error: (r && r.error) || 'stripe_lookup_failed' };
  }
  _cache.set(key, { value, expires: now + CACHE_TTL_MS });
  return value;
}

// Refusal for the payment gate, or null when the account can take a charge.
function paymentRefusalFor(check, community) {
  const name = (community && (community.hoa_legal_name || community.name)) || 'This association';
  if (!check || !check.ok) {
    return { ok: false, status: 503, error: 'stripe_account_unavailable', hint: 'Online payment is temporarily unavailable. Please try again later or contact management.' };
  }
  if (!check.exists) {
    return { ok: false, status: 503, error: 'community_stripe_not_onboarded', hint: `${name} hasn't completed Stripe onboarding.` };
  }
  if (!check.charges_enabled) {
    return { ok: false, status: 503, error: 'community_stripe_not_enabled', hint: `${name} can't accept online payments yet.` };
  }
  return null;
}

function clearAccountCheck(accountId) {
  if (!accountId) { _cache.clear(); return; }
  for (const k of [..._cache.keys()]) if (k.endsWith(`:${accountId}`)) _cache.delete(k);
}

module.exports = { checkConnectedAccount, isMissingAccountResult, paymentRefusalFor, clearAccountCheck, CACHE_TTL_MS };
