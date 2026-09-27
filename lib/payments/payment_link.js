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
// lingering. Signed with the dedicated PAYMENT_LINK_SECRET only (never leaves
// the server; see secret() below).
// ============================================================================
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 120;

// Signed ONLY with a dedicated PAYMENT_LINK_SECRET (at least 32 characters).
// Never a hard-coded string and never another credential (staff password, webhook
// secret, service key): reusing a credential as a signing key means leaking one
// leaks both. Missing or short -> minting and verifying both refuse loudly with
// code 'payment_link_not_configured'. (Ed 2026-09-27.)
const MIN_SECRET_LEN = 32;
class PaymentLinkConfigError extends Error {
  constructor(message) { super(message); this.code = 'payment_link_not_configured'; }
}
function secret() {
  const s = process.env.PAYMENT_LINK_SECRET || '';
  if (!s) throw new PaymentLinkConfigError('PAYMENT_LINK_SECRET is not set; payment links are disabled');
  if (s.length < MIN_SECRET_LEN) throw new PaymentLinkConfigError(`PAYMENT_LINK_SECRET must be at least ${MIN_SECRET_LEN} characters; payment links are disabled`);
  return s;
}
function paymentLinksConfigured() {
  try { secret(); return true; } catch (_) { return false; }
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

// token -> { ok, community_id, property_id, tenure_id } | { ok:false, reason }
// A missing/short secret is NOT reported as a bad link: it returns
// reason 'not_configured' (and logs) so callers can say so instead of blaming
// the homeowner's link.
function verifyPaymentToken(token) {
  try { secret(); } catch (e) {
    console.error('[payment_link] verify refused:', e.message);
    return { ok: false, reason: 'not_configured' };
  }
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

module.exports = { signPaymentToken, verifyPaymentToken, paymentLinkUrl, paymentLinksConfigured, PaymentLinkConfigError, DEFAULT_TTL_DAYS };
