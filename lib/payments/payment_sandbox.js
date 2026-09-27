// ============================================================================
// lib/payments/payment_sandbox.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// The ONE exception to demo isolation for Stripe: end-to-end TEST payments on
// the single lot flagged properties.payment_sandbox (migration 469: at most one
// such lot, and only inside a demo community). Everything else about a demo
// stays suppressed by lib/demo/outbound_guard.js.
//
// Allowed only when ALL hold:
//   * the server's Stripe key is a TEST key (live mode: always blocked);
//   * the channel is stripe:checkout (for the sandbox lot itself) or
//     stripe:account (for the demo community that holds the sandbox lot);
//   * the only demo signals are "demo community" / "demo recipient" (a running
//     demo workflow still blocks);
//   * the database confirms the lot is THE sandbox lot, in that community, and
//     that community is a demo.
// Refunds and off-session (autopay) charges are never excepted.
// ============================================================================
const { stripeMode } = require('./stripe_mode');

const EXCEPTABLE_CHANNELS = new Set(['stripe:checkout', 'stripe:account']);
const EXCEPTABLE_REASONS = new Set(['demo_community', 'demo_recipient']);

// Returns { allowed:boolean, why:string }. Any lookup failure means not allowed.
async function sandboxException({ channel, communityId, sandboxPropertyId = null, reasons = [], key = process.env.STRIPE_SECRET_KEY, supabase }) {
  if (stripeMode(key) !== 'test') return { allowed: false, why: 'not_test_mode' };
  if (!EXCEPTABLE_CHANNELS.has(channel)) return { allowed: false, why: 'channel_not_exceptable' };
  if (!communityId) return { allowed: false, why: 'no_community' };
  if (!reasons.length || !reasons.every((r) => EXCEPTABLE_REASONS.has(r))) return { allowed: false, why: 'demo_signal_not_exceptable' };
  if (channel === 'stripe:checkout' && !sandboxPropertyId) return { allowed: false, why: 'no_sandbox_property' };
  try {
    let q = supabase.from('properties').select('id, community_id, payment_sandbox, communities!inner(is_demo)')
      .eq('payment_sandbox', true).eq('community_id', communityId);
    if (channel === 'stripe:checkout') q = q.eq('id', sandboxPropertyId);
    const { data, error } = await q.limit(1);
    if (error) { console.warn('[payment_sandbox] lookup failed:', error.message); return { allowed: false, why: 'lookup_failed' }; }
    const row = (data || [])[0];
    if (!row || row.payment_sandbox !== true || row.community_id !== communityId || !(row.communities && row.communities.is_demo === true)) {
      return { allowed: false, why: 'not_the_sandbox_lot' };
    }
    return { allowed: true, why: 'payment_sandbox_test_mode' };
  } catch (e) {
    console.warn('[payment_sandbox] lookup threw:', e.message);
    return { allowed: false, why: 'lookup_failed' };
  }
}

module.exports = { sandboxException };
