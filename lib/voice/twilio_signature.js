// ============================================================================
// lib/voice/twilio_signature.js  (Issue #29, 2026-10-04)
// ----------------------------------------------------------------------------
// PROVE A VOICE WEBHOOK CAME FROM TWILIO.
//
// /api/voice/incoming, /api/voice/status and the /api/voice/stream WebSocket
// sit outside the staff gate because Twilio never carries a staff cookie. Until
// now nothing checked that a request on those paths was Twilio at all: anyone
// could POST a fake call status into homeowner_calls, or open the media stream
// and run a Claire call (Deepgram + ElevenLabs + Anthropic) on our bill.
//
// Twilio signs every request with X-Twilio-Signature = base64(HMAC-SHA1(
// auth token, full URL + each POST param name+value sorted by name)). This is
// the same algorithm as twilio-node's validateRequest (webhooks.js), including
// its with-port / without-port retry. Written out here rather than pulling in
// the whole twilio SDK for one HMAC; the repo already talks to Twilio by plain
// fetch (lib/notifications/sms.js).
//
// FLAG: TWILIO_SIGNATURE_VALIDATION = 'true' | 'false'. Unset means ON in
// production (NODE_ENV=production or running on Render) and OFF locally. When
// ON and TWILIO_AUTH_TOKEN is missing we fail CLOSED, loudly: a check that
// quietly passes everything because a secret is missing is decoration.
//
// URL: Twilio signs the URL it was configured with. Behind Render's proxy we
// rebuild it from X-Forwarded-Proto/Host, or take TWILIO_WEBHOOK_BASE_URL
// (e.g. https://my.bedrocktxai.com) when set, which is the reliable choice.
// ============================================================================
const crypto = require('crypto');

function validationEnabled(env) {
  const e = env || process.env;
  const flag = String(e.TWILIO_SIGNATURE_VALIDATION || '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'on') return true;
  if (flag === 'false' || flag === '0' || flag === 'off') return false;
  return e.NODE_ENV === 'production' || !!e.RENDER;
}

function toParam(name, value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value)).sort().map((v) => toParam(name, v)).join('');
  }
  return name + (value == null ? '' : value);
}

function computeSignature(authToken, url, params) {
  const p = params || {};
  const data = Object.keys(p).sort().reduce((acc, k) => acc + toParam(k, p[k]), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf-8');
  const bb = Buffer.from(String(b || ''), 'utf-8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const STANDARD_PORT = { 'https:': '443', 'wss:': '443', 'http:': '80', 'ws:': '80' };

// The same URL with and without an explicit port, as twilio-node tries both.
function urlVariants(url) {
  let u;
  try { u = new URL(url); } catch (_) { return [url]; }
  const without = new URL(u.toString()); without.port = '';
  const out = [without.toString()];
  const port = u.port || STANDARD_PORT[u.protocol];
  if (port) {
    // URL() drops a default port on assignment, so splice it in by hand.
    out.push(`${u.protocol}//${u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : ''}${u.hostname}:${port}${u.pathname}${u.search}${u.hash}`);
  }
  out.push(url);
  return Array.from(new Set(out));
}

/** True when signature matches url+params for any accepted URL form. */
function validateRequest(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;
  return urlVariants(url).some((v) => safeEqual(computeSignature(authToken, v, params), signature));
}

// The public origin Twilio called, e.g. https://my.bedrocktxai.com
function publicOrigin(req, env) {
  const e = env || process.env;
  const base = String(e.TWILIO_WEBHOOK_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return base;
  const h = req.headers || {};
  const proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
  const host = String(h['x-forwarded-host'] || '').split(',')[0].trim() || h.host || '';
  return `${proto}://${host}`;
}

/**
 * Express middleware for Twilio form-POST webhooks. Mount after the
 * urlencoded parser so req.body holds the signed params.
 */
function requireTwilioSignature(opts) {
  const env = (opts && opts.env) || null;
  return function twilioSignatureGate(req, res, next) {
    const e = env || process.env;
    if (!validationEnabled(e)) return next();
    const token = e.TWILIO_AUTH_TOKEN;
    if (!token) {
      console.error('[voice/twilio-sig] validation is ON but TWILIO_AUTH_TOKEN is not set; refusing webhook');
      return res.status(503).type('text/plain').send('webhook validation not configured');
    }
    const url = publicOrigin(req, e) + (req.originalUrl || req.url || '');
    const sig = req.get ? req.get('x-twilio-signature') : (req.headers || {})['x-twilio-signature'];
    if (!validateRequest(token, sig, url, req.body || {})) {
      console.warn(`[voice/twilio-sig] rejected ${req.method} ${req.originalUrl || req.url} (signature ${sig ? 'mismatch' : 'missing'})`);
      return res.status(403).type('text/plain').send('invalid signature');
    }
    return next();
  };
}

/**
 * Check the Media Streams WebSocket upgrade. Twilio signs the stream URL from
 * our TwiML with no params. We accept the configured VOICE_WEBSOCKET_URL, the
 * wss:// URL rebuilt from the request, and its https:// twin.
 * Returns { ok, reason }.
 */
function verifyTwilioUpgrade(req, env) {
  const e = env || process.env;
  if (!validationEnabled(e)) return { ok: true, reason: 'validation_off' };
  const token = e.TWILIO_AUTH_TOKEN;
  if (!token) return { ok: false, reason: 'auth_token_missing' };
  const h = req.headers || {};
  const sig = h['x-twilio-signature'];
  if (!sig) return { ok: false, reason: 'signature_missing' };

  const path = req.url || '';
  const origin = publicOrigin(req, e);
  const host = origin.replace(/^[a-z]+:\/\//i, '');
  const candidates = [
    e.VOICE_WEBSOCKET_URL || null,
    `wss://${host}${path}`,
    `https://${host}${path}`,
  ].filter(Boolean);
  const ok = candidates.some((u) => validateRequest(token, sig, u, {}));
  return { ok, reason: ok ? 'valid' : 'signature_mismatch' };
}

module.exports = {
  validationEnabled, computeSignature, validateRequest, publicOrigin,
  requireTwilioSignature, verifyTwilioUpgrade,
};
