// ============================================================================
// lib/ach/token.js  (Ed 2026-09-16)
// ----------------------------------------------------------------------------
// One-time, high-entropy token for a vendor ACH enrollment link. Unlike the
// signed board-vote token (stateless), an ACH link needs single-use, an audit
// row, and revocation, so we store a ROW keyed by the token's HASH. The raw
// token lives only in the emailed link; the DB holds sha256(token) only, so a
// DB leak does not yield a working link.
// ============================================================================
const crypto = require('crypto');

// 32 random bytes, base64url — ~256 bits, unguessable.
function newToken() {
  return crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

// Build the public link. Base from TRUSTED_URL, else the request host.
function achLink(rawToken, baseUrl) {
  const base = (baseUrl || process.env.TRUSTED_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/ach/${rawToken}`;
}

module.exports = { newToken, hashToken, achLink };
