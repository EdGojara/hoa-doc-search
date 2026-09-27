// ============================================================================
// lib/payments/webhook_auth.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Which signing secret verifies a Stripe webhook delivery.
//
// Stripe signs each endpoint's deliveries with that endpoint's own secret:
//   * platform endpoint         -> STRIPE_WEBHOOK_SECRET
//     (checkout / payment_intent / charge / dispute events for our charges)
//   * connected-accounts endpoint -> STRIPE_CONNECT_WEBHOOK_SECRET
//     (account.updated and other events that happen ON a connected account;
//     Stripe marks these with a top-level `account` field)
//
// A delivery is verified with EXACTLY ONE secret, chosen by its source. There is
// no fallback to the other secret and no unsigned path: a platform event signed
// with the connect secret, or a connected-account event signed with the platform
// secret, is refused. Choosing by the (unverified) `account` field is safe: it
// only picks which secret must have produced the signature, and the field is
// inside the signed body, so it cannot be added or removed without breaking it.
// If the secret for that source is missing, the delivery is refused with 503
// (Stripe retries), and the other source keeps working.
// ============================================================================
const { verifyWebhookSignature } = require('./stripe');

function eventSource(rawBody) {
  try {
    const o = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
    if (!o || typeof o !== 'object') return null;
    return typeof o.account === 'string' && o.account ? 'connect' : 'platform';
  } catch (_) {
    return null;
  }
}

// -> { ok:true, source, event } | { ok:false, status, source, error }
// (Never returns or logs a secret value.)
function verifyStripeWebhook(rawBody, sigHeader, {
  platformSecret = process.env.STRIPE_WEBHOOK_SECRET,
  connectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  verify = verifyWebhookSignature,
} = {}) {
  if (!rawBody || !rawBody.length) return { ok: false, status: 400, source: null, error: 'empty_body' };
  if (!sigHeader) return { ok: false, status: 400, source: null, error: 'missing_signature' };
  const source = eventSource(rawBody);
  if (!source) return { ok: false, status: 400, source: null, error: 'malformed_body' };
  const secret = source === 'connect' ? connectSecret : platformSecret;
  if (!secret) {
    return { ok: false, status: 503, source,
      error: source === 'connect' ? 'connect_webhook_secret_not_configured' : 'platform_webhook_secret_not_configured' };
  }
  const v = verify(rawBody, sigHeader, secret);
  if (!v.ok) return { ok: false, status: 400, source, error: v.error || 'signature_invalid' };
  const event = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  return { ok: true, source, event };
}

module.exports = { verifyStripeWebhook, eventSource };
