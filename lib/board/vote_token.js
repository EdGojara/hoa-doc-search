// ============================================================================
// lib/board/vote_token.js  (Ed 2026-08-09)
// ----------------------------------------------------------------------------
// A signed, single-purpose ballot link for a board member — no portal login.
// The email's "vote" link is /board-vote?token=<token>, where <token> is an
// HMAC-signed payload of { motion_id, voter_email }. The voter identity is IN
// the signed token, so it cannot be forged or reassigned — a board member can
// only ever cast THEIR OWN vote from THEIR emailed link. The ballot page still
// requires a click (no auto-consume), so email link-scanners can't cast a vote.
//
// Signed, not a table: no per-link row. Modeled on lib/payments/payment_link.js.
// ============================================================================
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 30; // voting windows are short; a stale ballot shouldn't linger

function secret() {
  return process.env.BOARD_VOTE_SECRET
    || process.env.STAFF_GATE_SECRET
    || process.env.STAFF_PASSWORD
    || process.env.SUPABASE_KEY
    || 'bedrock-board-vote-fallback';
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

// { motion_id, voter_email, ttlDays? } -> token string
function signVoteToken({ motion_id, voter_email, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!motion_id || !voter_email) throw new Error('motion_id and voter_email required');
  const payload = {
    m: motion_id,
    v: String(voter_email).trim().toLowerCase(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlDays * 86400,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

// token -> { ok, motion_id, voter_email } | { ok:false, reason }
function verifyVoteToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return { ok: false, reason: 'malformed' };
    const expected = sign(body);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    const payload = JSON.parse(unb64url(body).toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return { ok: false, reason: 'expired' };
    if (!payload.m || !payload.v) return { ok: false, reason: 'incomplete' };
    return { ok: true, motion_id: payload.m, voter_email: payload.v, issued_at: payload.iat, expires_at: payload.exp };
  } catch (e) {
    return { ok: false, reason: 'invalid' };
  }
}

function voteLinkUrl(token, baseUrl) {
  const base = (baseUrl || process.env.TRUSTED_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/board-vote?token=${token}`;
}

module.exports = { signVoteToken, verifyVoteToken, voteLinkUrl, DEFAULT_TTL_DAYS };
