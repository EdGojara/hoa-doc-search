// ============================================================================
// lib/meetings/upload_token.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Per-recording-session upload key. A board meeting can run 4 hours and the
// staff login token expires hourly, so segment uploads, heartbeats and markers
// authenticate with a key scoped to ONE session, valid 12 hours. Only the
// sha256 of the secret is stored (meeting_recording_sessions.upload_token_hash);
// the key itself is shown once, to the recording device. Renewing replaces the
// hash, so an old key stops working.
//
// Token format: "<session uuid>.<random secret>"
// ============================================================================
const crypto = require('crypto');

const TTL_MS = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function issueUploadToken(sessionId, now = Date.now()) {
  const secret = crypto.randomBytes(24).toString('base64url');
  return { token: `${sessionId}.${secret}`, hash: sha256(secret), expires_at: new Date(now + TTL_MS).toISOString() };
}

function parseUploadToken(token) {
  const t = String(token || '');
  const dot = t.indexOf('.');
  if (dot < 0) return null;
  const sessionId = t.slice(0, dot), secret = t.slice(dot + 1);
  if (!UUID.test(sessionId) || secret.length < 16) return null;
  return { sessionId, secret };
}

// Returns 'ok' | 'invalid' | 'expired' | 'wrong_session'.
function checkUploadToken(token, session, expectSessionId, now = Date.now()) {
  const p = parseUploadToken(token);
  if (!p || !session || !session.upload_token_hash) return 'invalid';
  if (expectSessionId && p.sessionId !== expectSessionId) return 'wrong_session';
  if (p.sessionId !== session.id) return 'wrong_session';
  const a = Buffer.from(sha256(p.secret), 'hex'), b = Buffer.from(String(session.upload_token_hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'invalid';
  if (!session.upload_token_expires_at || Date.parse(session.upload_token_expires_at) <= now) return 'expired';
  return 'ok';
}

module.exports = { issueUploadToken, parseUploadToken, checkUploadToken, TTL_MS };
