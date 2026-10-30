// ============================================================================
// lib/portal/pay_gate.js — the homeowner portal's view of "can this owner pay?"
// ----------------------------------------------------------------------------
// The decision itself lives in ONE place: lib/payments/payment_readiness.js
// (Stripe hardening PR). Ready = Stripe key set, community not ended and
// financials active, communities.online_payments_enabled ON (default OFF,
// migration 534, Ed turns it on per community after his activation gate),
// connected account with charges AND payouts enabled, in the server key's mode.
// The server checkout refuses on the same function (with a live Stripe verify),
// so the portal's Pay button can never offer a payment the server turns down.
//
// This file only adapts that answer for the portal (/me and /pay/checkout).
// The Pay button used to show whenever stripe_connected_account_id existed,
// which offered Pay for Waterview, whose ledger is not converted.
//
// FAILS CLOSED. Until payment_readiness.js is on this branch (the hardening PR
// may merge after this one), or if it throws, the answer is "no Pay". Once that
// PR is merged the module-not-found branch is dead and can be deleted.
// ============================================================================

const CLOSED_MESSAGE = 'Online payment is not available yet.';
let _readiness; // undefined = not loaded yet; null = not present on this branch

function readiness() {
  if (_readiness !== undefined) return _readiness;
  try { _readiness = require('../payments/payment_readiness'); }
  catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /payment_readiness/.test(e.message || '')) _readiness = null;
    else throw e;
  }
  return _readiness;
}

const closed = () => ({ payments_enabled: false, message: CLOSED_MESSAGE, pending: null });

/**
 * For /api/portal/me: { payments_enabled, message, pending }.
 * pending = { amount_cents, since, method, label } while a submitted payment
 * (ACH) is still processing; the balance does not drop until it settles.
 */
async function portalPayState(supabase, { communityId, propertyId, tenureId = null }) {
  const r = readiness();
  if (!r || typeof r.portalPaymentState !== 'function') return closed();
  try {
    const st = await r.portalPaymentState(supabase, { communityId, propertyId, tenureId });
    return { payments_enabled: st.payments_enabled === true, message: st.message || null, pending: st.pending || null };
  } catch (e) {
    console.warn('[pay_gate] portal payment state failed:', e.message);
    return closed();
  }
}

/**
 * For /api/portal/pay/checkout, before the checkout is created:
 * { ready, reason, message }. The checkout itself re-verifies with Stripe.
 */
async function portalCheckoutGate(supabase, communityId) {
  const r = readiness();
  if (!r || typeof r.paymentsReadyFor !== 'function') {
    return { ready: false, reason: 'payment_not_configured', message: CLOSED_MESSAGE };
  }
  try {
    const g = await r.paymentsReadyFor(communityId, { supabase, verify: false });
    return { ready: g.ready === true, reason: g.reason || null, message: g.message || null };
  } catch (e) {
    console.warn('[pay_gate] readiness failed:', e.message);
    return { ready: false, reason: 'payment_not_configured', message: CLOSED_MESSAGE };
  }
}

// Tests only: stand in for payment_readiness (null = absent).
function _setReadinessForTest(mod) { _readiness = mod; }

module.exports = { portalPayState, portalCheckoutGate, _setReadinessForTest };
