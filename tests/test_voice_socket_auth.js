// =============================================================================
// tests/test_voice_socket_auth.js — who may open a voice socket / hit a webhook
// =============================================================================
//
// Issue #29. WebSocket upgrades skip Express, so the staff gate never ran on
// /api/claire/stt-stream or /api/claire-live/stream: anyone could hold a
// Deepgram / OpenAI stream open on Bedrock's bill. And the Twilio webhooks
// (/api/voice/incoming, /status, the /stream upgrade) never checked that the
// caller was Twilio. This file proves the gates hold, offline (no network, no
// database: identity and session reads are injected fakes).
//
// Run: node tests/test_voice_socket_auth.js   (wired into npm test)
// =============================================================================
const assert = require('assert');

// scope.js builds a Supabase client at load; give it inert values (no request
// is ever made in this file).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';

const wsAuth = require('../lib/voice/ws_auth');
const tw = require('../lib/voice/twilio_signature');
const { ownsSession } = require('../lib/claire/scope');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SID = '11111111-2222-4333-8444-555555555555';
const HOMEOWNER = { role: 'homeowner', portalUserId: 'pu-1', email: 'owner@example.com' };
const STAFF = { role: 'staff', email: 'Staff@Example.com' };
const BOARD = { role: 'board', email: 'board@example.com' };
const LIVE_SESSION = { id: SID, status: 'active', portal_user_id: 'pu-1', board_email: null, visitor_email: 'owner@example.com', language: 'es', seconds_cap: 600 };

function deps({ visitor = HOMEOWNER, session = LIVE_SESSION, visitorThrows = false, sessionThrows = false } = {}) {
  return {
    resolveVisitor: async () => { if (visitorThrows) throw new Error('boom'); return visitor; },
    loadSession: async () => { if (sessionThrows) throw new Error('db down'); return session; },
    ownsSession,
  };
}
const sttReq = (q) => ({ url: '/api/claire/stt-stream' + (q == null ? `?session=${SID}` : q), headers: {} });

// ---- ownership rule (shared with api/claire.js loadOwnedSession) -------------
test('ownsSession: homeowner owns only their portal_user_id', () => {
  assert.strictEqual(ownsSession(HOMEOWNER, LIVE_SESSION), true);
  assert.strictEqual(ownsSession({ ...HOMEOWNER, portalUserId: 'pu-2' }, LIVE_SESSION), false);
  assert.strictEqual(ownsSession(HOMEOWNER, { ...LIVE_SESSION, portal_user_id: null }), false);
});
test('ownsSession: staff/board match email case-insensitively, never by role alone', () => {
  assert.strictEqual(ownsSession(STAFF, { visitor_email: 'staff@example.com' }), true);
  assert.strictEqual(ownsSession(STAFF, { visitor_email: 'other@example.com' }), false);
  assert.strictEqual(ownsSession(STAFF, { visitor_email: null }), false);
  assert.strictEqual(ownsSession(BOARD, { board_email: 'BOARD@example.com' }), true);
  assert.strictEqual(ownsSession(BOARD, { visitor_email: 'board@example.com', board_email: null }), false);
  assert.strictEqual(ownsSession(null, LIVE_SESSION), false);
  assert.strictEqual(ownsSession(HOMEOWNER, null), false);
});

// ---- STT relay upgrade -------------------------------------------------------
test('stt: no session id -> 400, before any identity lookup', async () => {
  let looked = false;
  const d = { ...deps(), resolveVisitor: async () => { looked = true; return HOMEOWNER; } };
  const r = await wsAuth.authorizeSttUpgrade(sttReq(''), d);
  assert.deepStrictEqual([r.ok, r.status], [false, 400]);
  assert.strictEqual(looked, false);
  const r2 = await wsAuth.authorizeSttUpgrade(sttReq('?session=not-a-uuid'), deps());
  assert.strictEqual(r2.status, 400);
});
test('stt: anonymous -> 401 (the Issue #29 hole)', async () => {
  const r = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ visitor: null }));
  assert.deepStrictEqual([r.ok, r.status, r.reason], [false, 401, 'not_signed_in']);
});
test('stt: identity lookup throwing is a denial, not a pass', async () => {
  const r = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ visitorThrows: true }));
  assert.deepStrictEqual([r.ok, r.status], [false, 401]);
});
test('stt: unknown session -> 404; session read error -> 500 (denied)', async () => {
  assert.strictEqual((await wsAuth.authorizeSttUpgrade(sttReq(), deps({ session: null }))).status, 404);
  const r = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ sessionThrows: true }));
  assert.deepStrictEqual([r.ok, r.status], [false, 500]);
});
test("stt: someone else's session -> 403", async () => {
  const r = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ visitor: { ...HOMEOWNER, portalUserId: 'pu-9' } }));
  assert.deepStrictEqual([r.ok, r.status, r.reason], [false, 403, 'not_your_session']);
});
test('stt: ended / expired / handoff session -> 409', async () => {
  for (const status of ['ended', 'expired', 'handoff']) {
    const r = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ session: { ...LIVE_SESSION, status } }));
    assert.deepStrictEqual([r.ok, r.status], [false, 409], status);
  }
});
test('stt: own live session -> ok, capped at the visit seconds_cap and the ceiling', async () => {
  const r = await wsAuth.authorizeSttUpgrade(sttReq(), deps());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.maxSeconds, 600);
  assert.strictEqual(r.session.language, 'es');
  const big = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ session: { ...LIVE_SESSION, seconds_cap: 99999 } }));
  assert.strictEqual(big.maxSeconds, wsAuth.STT_MAX_SECONDS);
  const none = await wsAuth.authorizeSttUpgrade(sttReq(), deps({ session: { ...LIVE_SESSION, seconds_cap: null } }));
  assert.strictEqual(none.maxSeconds, 600);
});

// ---- GPT-Live PoC upgrade ----------------------------------------------------
test('live: anonymous 401, homeowner/board 403, staff ok', async () => {
  const req = { url: '/api/claire-live/stream?community=x', headers: {} };
  assert.strictEqual((await wsAuth.authorizeLiveUpgrade(req, deps({ visitor: null }))).status, 401);
  assert.strictEqual((await wsAuth.authorizeLiveUpgrade(req, deps({ visitor: HOMEOWNER }))).status, 403);
  assert.strictEqual((await wsAuth.authorizeLiveUpgrade(req, deps({ visitor: BOARD }))).status, 403);
  assert.strictEqual((await wsAuth.authorizeLiveUpgrade(req, deps({ visitorThrows: true }))).status, 401);
  const ok = await wsAuth.authorizeLiveUpgrade(req, deps({ visitor: STAFF }));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.maxSeconds, wsAuth.LIVE_MAX_SECONDS);
});

// ---- raw socket refusal + max duration --------------------------------------
test('rejectUpgrade writes an HTTP status and destroys the socket', () => {
  const sock = { writable: true, out: '', destroyed: false, write(s) { this.out += s; }, destroy() { this.destroyed = true; } };
  wsAuth.rejectUpgrade(sock, 401);
  assert.ok(sock.out.startsWith('HTTP/1.1 401 Unauthorized\r\n'));
  assert.strictEqual(sock.destroyed, true);
  const gone = { writable: false, write() { throw new Error('should not write'); }, destroy() { this.destroyed = true; } };
  wsAuth.rejectUpgrade(gone, 403);
  assert.strictEqual(gone.destroyed, true);
});
test('armMaxDuration closes the socket at the cap and clears on close', async () => {
  const handlers = {};
  const ws = { closed: null, on(ev, fn) { handlers[ev] = fn; }, close(code, why) { this.closed = [code, why]; }, terminate() {} };
  wsAuth.armMaxDuration(ws, 0.05, 'test');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(ws.closed, [1008, 'max_duration']);
  const ws2 = { closed: null, on(ev, fn) { handlers[ev] = fn; }, close(code) { this.closed = code; } };
  wsAuth.armMaxDuration(ws2, 0.05, 'test');
  handlers.close();               // client hung up first
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(ws2.closed, null);
});

// ---- Twilio signature --------------------------------------------------------
// Twilio's own documented example (docs: "Validating requests"). Expected value
// was also computed independently with `openssl dgst -sha1 -hmac`.
const DOC_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const DOC_PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
const DOC_SIG = '0/KCTR6DLpKmkAf8muzZqo1nDgQ=';

test('twilio: matches the published reference signature', () => {
  assert.strictEqual(tw.computeSignature('12345', DOC_URL, DOC_PARAMS), DOC_SIG);
  assert.strictEqual(tw.validateRequest('12345', DOC_SIG, DOC_URL, DOC_PARAMS), true);
});
test('twilio: wrong token, tampered param, missing header all fail', () => {
  assert.strictEqual(tw.validateRequest('54321', DOC_SIG, DOC_URL, DOC_PARAMS), false);
  assert.strictEqual(tw.validateRequest('12345', DOC_SIG, DOC_URL, { ...DOC_PARAMS, Digits: '9999' }), false);
  assert.strictEqual(tw.validateRequest('12345', '', DOC_URL, DOC_PARAMS), false);
  assert.strictEqual(tw.validateRequest('12345', undefined, DOC_URL, DOC_PARAMS), false);
  assert.strictEqual(tw.validateRequest('', DOC_SIG, DOC_URL, DOC_PARAMS), false);
});
test('twilio: signed with an explicit :443 still validates (twilio-node port retry)', () => {
  const sig = tw.computeSignature('12345', 'https://mycompany.com:443/myapp.php?foo=1&bar=2', DOC_PARAMS);
  assert.strictEqual(tw.validateRequest('12345', sig, DOC_URL, DOC_PARAMS), true);
});
test('twilio: repeated params sort their values like twilio-node', () => {
  const p = { B: ['2', '1'], A: 'x' };
  const expect = require('crypto').createHmac('sha1', 't').update('https://h/pAxB1B2').digest('base64');
  assert.strictEqual(tw.computeSignature('t', 'https://h/p', p), expect);
});

test('twilio flag: explicit wins; unset = ON in production / on Render, OFF locally', () => {
  assert.strictEqual(tw.validationEnabled({ TWILIO_SIGNATURE_VALIDATION: 'false', NODE_ENV: 'production' }), false);
  assert.strictEqual(tw.validationEnabled({ TWILIO_SIGNATURE_VALIDATION: 'true' }), true);
  assert.strictEqual(tw.validationEnabled({ NODE_ENV: 'production' }), true);
  assert.strictEqual(tw.validationEnabled({ RENDER: 'true' }), true);
  assert.strictEqual(tw.validationEnabled({}), false);
});

function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, type() { return this; }, send(b) { this.body = b; return this; } };
}
function webhookReq({ sig, body = { ...DOC_PARAMS }, path = '/api/voice/status' } = {}) {
  const headers = { host: 'my.example.test', 'x-forwarded-proto': 'https' };
  if (sig !== undefined) headers['x-twilio-signature'] = sig;
  return { method: 'POST', originalUrl: path, url: path.replace('/api/voice', ''), headers, body, get(h) { return headers[h.toLowerCase()]; } };
}
const ENV_ON = { TWILIO_SIGNATURE_VALIDATION: 'true', TWILIO_AUTH_TOKEN: 'tok' };

test('twilio middleware: valid signature passes, using the forwarded https URL', () => {
  const good = tw.computeSignature('tok', 'https://my.example.test/api/voice/status', DOC_PARAMS);
  let nexted = false; const res = fakeRes();
  tw.requireTwilioSignature({ env: ENV_ON })(webhookReq({ sig: good }), res, () => { nexted = true; });
  assert.strictEqual(nexted, true);
});
test('twilio middleware: forged / missing signature -> 403, handler never runs', () => {
  for (const sig of ['forged', undefined]) {
    let nexted = false; const res = fakeRes();
    tw.requireTwilioSignature({ env: ENV_ON })(webhookReq({ sig }), res, () => { nexted = true; });
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.code, 403);
  }
});
test('twilio middleware: TWILIO_WEBHOOK_BASE_URL overrides the request host', () => {
  const env = { ...ENV_ON, TWILIO_WEBHOOK_BASE_URL: 'https://my.bedrocktxai.com/' };
  const good = tw.computeSignature('tok', 'https://my.bedrocktxai.com/api/voice/status', DOC_PARAMS);
  let nexted = false;
  tw.requireTwilioSignature({ env })(webhookReq({ sig: good }), fakeRes(), () => { nexted = true; });
  assert.strictEqual(nexted, true);
});
test('twilio middleware: ON without an auth token fails CLOSED (503)', () => {
  let nexted = false; const res = fakeRes();
  tw.requireTwilioSignature({ env: { TWILIO_SIGNATURE_VALIDATION: 'true' } })(webhookReq({ sig: 'x' }), res, () => { nexted = true; });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res.code, 503);
});
test('twilio middleware: flag OFF passes through untouched', () => {
  let nexted = false;
  tw.requireTwilioSignature({ env: { TWILIO_SIGNATURE_VALIDATION: 'false' } })(webhookReq({}), fakeRes(), () => { nexted = true; });
  assert.strictEqual(nexted, true);
});

test('twilio stream upgrade: signed wss URL ok; unsigned / forged / no token refused', () => {
  const req = (sig) => ({ url: '/api/voice/stream', headers: { host: 'my.example.test', ...(sig ? { 'x-twilio-signature': sig } : {}) } });
  const wssSig = tw.computeSignature('tok', 'wss://my.example.test/api/voice/stream', {});
  assert.strictEqual(tw.verifyTwilioUpgrade(req(wssSig), ENV_ON).ok, true);
  const httpsSig = tw.computeSignature('tok', 'https://my.example.test/api/voice/stream', {});
  assert.strictEqual(tw.verifyTwilioUpgrade(req(httpsSig), ENV_ON).ok, true);
  const cfgSig = tw.computeSignature('tok', 'wss://voice.example.test/api/voice/stream', {});
  assert.strictEqual(tw.verifyTwilioUpgrade(req(cfgSig), { ...ENV_ON, VOICE_WEBSOCKET_URL: 'wss://voice.example.test/api/voice/stream' }).ok, true);
  assert.deepStrictEqual(tw.verifyTwilioUpgrade(req(null), ENV_ON), { ok: false, reason: 'signature_missing' });
  assert.strictEqual(tw.verifyTwilioUpgrade(req('forged'), ENV_ON).ok, false);
  assert.strictEqual(tw.verifyTwilioUpgrade(req(wssSig), { TWILIO_SIGNATURE_VALIDATION: 'true' }).reason, 'auth_token_missing');
  assert.strictEqual(tw.verifyTwilioUpgrade(req(null), { TWILIO_SIGNATURE_VALIDATION: 'false' }).ok, true);
});

// ---- wiring: the gates are actually attached -------------------------------
test('wiring: server.js authenticates every voice upgrade before handleUpgrade', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf("httpServer.on('upgrade'");
  const block = src.slice(start, src.indexOf('httpServer.listen(', start));
  const before = (needle, path) => {
    const p = block.indexOf(`'${path}'`);
    const n = block.indexOf(needle, p);
    const h = block.indexOf('handleUpgrade', p);
    assert.ok(p >= 0 && n > p && h > n, `${needle} must run before handleUpgrade for ${path}`);
  };
  before('verifyTwilioUpgrade', '/api/voice/stream');
  before('authorizeLiveUpgrade', '/api/claire-live/stream');
  before('authorizeSttUpgrade', '/api/claire/stt-stream');
  assert.ok(/armMaxDuration\(ws, a\.maxSeconds, 'claire-stt'\)/.test(block));
  assert.ok(/armMaxDuration\(ws, a\.maxSeconds, 'claire-live'\)/.test(block));
});
test('wiring: Twilio webhook routes carry the signature gate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'voice.js'), 'utf8');
  assert.ok(/router\.post\('\/incoming', twilioOnly,/.test(src));
  assert.ok(/router\.post\('\/status', twilioOnly,/.test(src));
});
test('wiring: /claire passes its session id to the STT socket', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'claire.html'), 'utf8');
  assert.ok(/stt-stream\?session='\+encodeURIComponent\(SESSION\.id\)/.test(src));
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('  ok  ', t.name); }
    catch (e) { console.error('  FAIL', t.name, '\n       ', e.message); process.exitCode = 1; }
  }
  console.log(`\nvoice socket auth: ${passed}/${tests.length} passed`);
})();
