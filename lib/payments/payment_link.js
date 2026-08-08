// ============================================================================
// lib/payments/payment_link.js  (Ed 2026-08-08)
// ----------------------------------------------------------------------------
// A STABLE, emailable "pay your balance" link for a homeowner — no portal login.
//
// The link is /pay/<token>, where <token> is an HMAC-signed payload of
// {community_id, property_id}. It is deliberately NOT a raw Stripe Checkout URL:
// a Checkout Session expires (~24h) and locks the amount at generation time. The
// stable link instead resolves the CURRENT balance and mints a FRESH checkout
// only when the homeowner clicks — so an emailed link never goes stale and
// always reflects what's actually owed today.
//
// Signed, not a table: no migration, and a homeowner can't tamper with the
// property/amount. A generous expiry (default 120 days) keeps ancient links from
// lingering. The secret is any stable server secret (never leaves the server).
// ============================================================================
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 120;

function secret() {
  // Any stable server-side secret. Payments are inert until Stripe keys land, so
  // this only ever matters server-side; the value never reaches the browser.
  return process.env.PAYMENT_LINK_SECRET
    || process.env.STAFF_GATE_SECRET
    || process.env.STAFF_PASSWORD
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.SUPABASE_KEY
    || 'bedrock-payment-link-fallback';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

// { community_id, property_id, ttlDays? } -> token string
function signPaymentToken({ community_id, property_id, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!community_id || !property_id) throw new Error('community_id and property_id required');
  const payload = { c: community_id, p: property_id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlDays * 86400 };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

// token -> { ok, community_id, property_id } | { ok:false, reason }
function verifyPaymentToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return { ok: false, reason: 'malformed' };
    // Constant-time signature check.
    const expected = sign(body);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    const payload = JSON.parse(unb64url(body).toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return { ok: false, reason: 'expired' };
    if (!payload.c || !payload.p) return { ok: false, reason: 'incomplete' };
    return { ok: true, community_id: payload.c, property_id: payload.p, issued_at: payload.iat, expires_at: payload.exp };
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
}

function paymentLinkUrl(token, baseUrl) {
  const base = (baseUrl || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/pay/${token}`;
}

module.exports = { signPaymentToken, verifyPaymentToken, paymentLinkUrl, DEFAULT_TTL_DAYS };
