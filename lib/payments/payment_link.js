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

// No hard-coded fallback: a link signed with a string in the source code could be
// forged by anyone who read it. With no secret configured, minting and
// verifying both fail loudly instead. (Ed 2026-09-27.)
function secret() {
  const s = process.env.PAYMENT_LINK_SECRET
    || process.env.STAFF_GATE_SECRET
    || process.env.STAFF_PASSWORD
    || process.env.STRIPE_WEBHOOK_SECRET
    || process.env.SUPABASE_KEY;
  if (!s) throw new Error('no payment link secret configured');
  return s;
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
// A link belongs to the OWNER it was issued for (tenure), not just the lot: after
// a sale, a link emailed to the seller stops working instead of paying the buyer.
function signPaymentToken({ community_id, property_id, tenure_id, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!community_id || !property_id || !tenure_id) throw new Error('community_id, property_id and tenure_id required');
  const payload = { c: community_id, p: property_id, t: tenure_id, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlDays * 86400 };
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
    if (!payload.t) return { ok: false, reason: 'pre_tenure_link' }; // issued before links were owner-bound
    return { ok: true, community_id: payload.c, property_id: payload.p, tenure_id: payload.t, issued_at: payload.iat, expires_at: payload.exp };
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
}

function paymentLinkUrl(token, baseUrl) {
  const base = (baseUrl || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/pay/${token}`;
}

module.exports = { signPaymentToken, verifyPaymentToken, paymentLinkUrl, DEFAULT_TTL_DAYS };
