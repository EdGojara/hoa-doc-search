// ============================================================================
// lib/portal/financial_access.js  (Ed 2026-11-16)
// ----------------------------------------------------------------------------
// May homeowners in this association see their balance, and may they pay online?
// The ONE decision every homeowner surface uses: the portal home (balance stat,
// balance tile, Pay button), GET /api/portal/balance, GET /api/portal/transactions,
// and every assessment checkout a homeowner can start (portal Pay, emailed pay
// link) in lib/payments/assessment_checkout.js.
//
// FAIL-CLOSED and per association. Off unless the association's
// portal_module_config carries all of:
//   balance.status === 'live'                      the balance tile is switched on
//   homeowner_financials.verified_at + verified_by  a person recorded that its
//                                                   homeowner balances are verified
//                                                   (conversion done, payments
//                                                   imported and current)
// Payments additionally need homeowner_financials.payments === true AND a Stripe
// connected account whose onboarding is 'enabled'. A connected Stripe account
// alone never enables payments. Anything missing or malformed means off.
//
// Demo communities keep their sample balances (no real homeowner); their
// checkout is still bounded by the Stripe mode gate (test key: sandbox lot only).
// Staff screens are not affected.
// ============================================================================
'use strict';

const HIDDEN_REASON = 'Online balances and payments are not available for this association yet.';

function decideFinancialAccess(community) {
  if (!community || typeof community !== 'object') return { balance: false, payments: false, reason: 'no_community' };
  if (community.is_demo === true) {
    return { balance: true, payments: !!community.stripe_connected_account_id, reason: 'demo_community' };
  }
  const cfg = community.portal_module_config && typeof community.portal_module_config === 'object' ? community.portal_module_config : {};
  const tileLive = !!(cfg.balance && cfg.balance.status === 'live');
  const hf = cfg.homeowner_financials && typeof cfg.homeowner_financials === 'object' ? cfg.homeowner_financials : {};
  const verified = !!(String(hf.verified_at || '').trim() && String(hf.verified_by || '').trim());
  if (!tileLive) return { balance: false, payments: false, reason: 'balance_off' };
  if (!verified) return { balance: false, payments: false, reason: 'balances_not_verified' };
  if (hf.payments !== true) return { balance: true, payments: false, reason: 'payments_off' };
  if (!community.stripe_connected_account_id || community.stripe_onboarding_status !== 'enabled') {
    return { balance: true, payments: false, reason: 'stripe_not_ready' };
  }
  return { balance: true, payments: true, reason: 'enabled' };
}

const COLUMNS = 'id, name, is_demo, portal_module_config, stripe_connected_account_id, stripe_onboarding_status';

// Loads the association and decides. A lookup failure is a refusal, never a pass.
async function financialAccessFor(supabase, communityId) {
  if (!communityId) return { balance: false, payments: false, reason: 'no_community' };
  try {
    const { data, error } = await supabase.from('communities').select(COLUMNS).eq('id', communityId).maybeSingle();
    if (error || !data) {
      if (error) console.warn('[financial_access] lookup failed (refusing):', error.message);
      return { balance: false, payments: false, reason: 'lookup_failed' };
    }
    return decideFinancialAccess(data);
  } catch (e) {
    console.warn('[financial_access] lookup threw (refusing):', e.message);
    return { balance: false, payments: false, reason: 'lookup_failed' };
  }
}

// The portal_module_config the homeowner's browser receives: the balance tile is
// hidden whenever balances are not allowed, whatever the stored config says.
function presentedModuleConfig(cfg, access) {
  const out = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  delete out.homeowner_financials;   // owner bookkeeping, not for the browser
  if (!access.balance) out.balance = { ...(out.balance || {}), status: 'hidden' };
  return out;
}

module.exports = { decideFinancialAccess, financialAccessFor, presentedModuleConfig, HIDDEN_REASON, COLUMNS };
