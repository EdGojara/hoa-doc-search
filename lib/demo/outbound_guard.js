// ============================================================================
// lib/demo/outbound_guard.js  (Ed 2026-09-20)
// ----------------------------------------------------------------------------
// THE final outbound-action enforcement boundary. Every real-world sender
// (Microsoft Graph email, Resend email, Twilio SMS, Lob certified mail, Stripe
// money) calls guardOutbound() before it touches the vendor. If the action
// belongs to a demo organization, the real call is SUPPRESSED and a
// would-have-sent record is written to demo_suppressed_actions so it can be
// inspected inside the demo. This is defense in depth: even if every upstream
// filter is forgotten, a demo-originated action cannot leave the system here.
//
// Three independent demo signals — ANY one blocks (fail closed toward "demo"):
//   1. explicit community id resolves to a demo community (Lob, Stripe, and any
//      sender given a communityId),
//   2. the ambient demo execution context is active (a demo workflow), or
//   3. the recipient matches a reserved demo pattern (fictional demo contact).
// Production sends trip none of these and pass through unchanged.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const guard = require('./demo_guard');
const { isDemoContextActive } = require('./demo_context');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Decide whether an outbound action is a demo action and, if so, record it.
// Returns { blocked:boolean, reason?:string }. Never throws into the sender.
async function guardOutbound({ channel, communityId = null, to = null, subject = null, summary = null, payload = null } = {}) {
  const reasons = [];
  try {
    if (communityId && await guard.isDemoCommunity(communityId)) reasons.push('demo_community');
  } catch (e) { console.warn('[outbound_guard] community check failed:', e.message); } // fall back to other signals
  try { if (isDemoContextActive()) reasons.push('demo_context'); } catch (_) {}
  try { if (guard.recipientIsDemo(to)) reasons.push('demo_recipient'); } catch (_) {}

  if (!reasons.length) return { blocked: false };

  const reason = reasons.join('+');
  // Record the suppressed action (best effort; a logging failure must not turn a
  // blocked demo action into a real send).
  try {
    await supabase.from('demo_suppressed_actions').insert({
      channel: String(channel || 'unknown'),
      community_id: communityId || null,
      recipient: to ? String(to).slice(0, 400) : null,
      subject: subject ? String(subject).slice(0, 500) : null,
      summary: summary ? String(summary).slice(0, 1000) : null,
      reason,
      payload: payload || null,
    });
  } catch (e) {
    console.warn('[outbound_guard] could not record suppressed action:', e.message);
  }
  console.log('[outbound_guard] SUPPRESSED demo action', JSON.stringify({ channel, communityId, to: to ? String(to).slice(0, 80) : null, reason }));
  return { blocked: true, reason };
}

module.exports = { guardOutbound };
