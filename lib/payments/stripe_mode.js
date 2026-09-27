// ============================================================================
// lib/payments/stripe_mode.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Which Stripe environment the server is actually using, from the secret key.
// Every test-only route calls requireTestMode() first, so it can never run
// against a live key (a real charge on a real homeowner).
// ============================================================================

function stripeMode(key = process.env.STRIPE_SECRET_KEY) {
  const k = String(key || '');
  if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) return 'live';
  if (k.startsWith('sk_test_') || k.startsWith('rk_test_')) return 'test';
  return 'unconfigured';
}

// Sends 403 and returns false unless Stripe is in test mode.
function requireTestMode(res, key) {
  const mode = stripeMode(key);
  if (mode !== 'test') {
    res.status(403).json({ error: 'test_mode_only', detail: `This route runs only while Stripe is in test mode (current: ${mode}).` });
    return false;
  }
  return true;
}

module.exports = { stripeMode, requireTestMode };
