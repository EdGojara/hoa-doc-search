'use strict';
// ============================================================================
// tests/test_pull_welcome.js  (Ed 2026-10-18) — owner-only "Pull Welcome"
// ----------------------------------------------------------------------------
// Server: the REAL email_triage router, with only sign-in and ingest stubbed:
//   POST /ingest is owner-only and runs exactly welcome@ / 7 days / full AI / max 50;
//   GET /viewer reports is_owner (and is reachable past the GET /:id param route).
// Page: the REAL pullWelcome() from communications.html in a sandbox: it confirms
// first, calls only /ingest for welcome@, shows scanned/kept/skipped/failed/errors,
// and Pull inbox (pullNow) is unchanged from main.
//   node tests/test_pull_welcome.js
// ============================================================================
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const http = require('http');
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY']) process.env[k] = process.env[k] || (k === 'SUPABASE_URL' ? 'http://localhost:1' : 'test-key');
process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 't'; process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'c'; process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 's';

let pass = 0, fail = 0; const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); } });
const ROOT = path.join(__dirname, '..');

// ---- stubs (installed before the router loads) ----
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const OWNER_EMAIL = 'egojara@bedrocktx.com';
const USERS = { owner: { id: 'u1', role: 'admin', email: OWNER_EMAIL }, admin: { id: 'u2', role: 'admin', email: 'otheradmin@bedrocktx.com' }, staff: { id: 'u3', role: 'staff', email: 'staff@bedrocktx.com' } };
const userFor = (req) => USERS[String(req.headers['x-test-user'] || '')] || null;
stub('../api/_require_admin', {
  OWNER_EMAIL,
  getAuthedUser: async (req) => userFor(req),
  requireAdmin: async (req, res) => { const u = userFor(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
  requireStaff: async (req, res) => { const u = userFor(req); if (!u) { res.status(403).json({ error: 'sign_in_required' }); return null; } return u; },
  requireOwner: async (req, res) => { const u = userFor(req); if (!u || u.email !== OWNER_EMAIL) { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
});
const ingestCalls = []; let pullCalls = 0;
const realGI = require('../lib/email/graph_ingest');
stub('../lib/email/graph_ingest', { ...realGI, isConfigured: () => true,
  ingestMailbox: async (mbx, opts) => { ingestCalls.push({ mbx, opts }); return { scanned: 3, kept: 3, skipped: 0, linked: 0, failed: 0, errors: [] }; } });

const express = require('express');
const { router } = require('../api/email_triage');
const origPull = router.stack.find((l) => l.route && l.route.path === '/pull');
if (origPull) { const h = origPull.route.stack[origPull.route.stack.length - 1]; const f = h.handle; h.handle = (req, res, next) => { pullCalls++; return f(req, res, next); }; }
const app = express(); app.use('/api/email-triage', router);
let server, base;
async function call(method, p, user, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
const WELCOME_BODY = { mailbox: 'welcome@bedrocktx.com', since_days: 7, light: false, only_linked: false, max: 50 };

console.log('Pull Welcome (owner only)');

check('SERVER: the owner runs it: exactly welcome@, 7-day window, full AI (not light), nothing filtered out, max 50', async () => {
  ingestCalls.length = 0;
  const t0 = Date.now();
  const r = await call('POST', '/api/email-triage/ingest', 'owner', WELCOME_BODY);
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.ok, true);
  assert.equal(ingestCalls.length, 1); const c = ingestCalls[0];
  assert.equal(c.mbx, 'welcome@bedrocktx.com'); assert.equal(c.opts.light, false); assert.equal(c.opts.onlyLinked, false); assert.equal(c.opts.max, 50);
  const days = (t0 - Date.parse(c.opts.sinceISO)) / 864e5; assert.ok(days > 6.99 && days < 7.01, `window ${days} days`);
  for (const k of ['scanned', 'kept', 'skipped', 'failed', 'errors']) assert.ok(k in r.j, `response has ${k}`);
});

check('SERVER: another admin, a staff member and a signed-out request are refused; nothing is ingested', async () => {
  ingestCalls.length = 0;
  assert.equal((await call('POST', '/api/email-triage/ingest', 'admin', WELCOME_BODY)).status, 403);
  assert.equal((await call('POST', '/api/email-triage/ingest', 'staff', WELCOME_BODY)).status, 403);
  assert.equal((await call('POST', '/api/email-triage/ingest', null, WELCOME_BODY)).status, 403);
  assert.equal(ingestCalls.length, 0);
});

check('SERVER: GET /viewer says owner only for the owner, and is reachable past the GET /:id param route', async () => {
  assert.deepEqual((await call('GET', '/api/email-triage/viewer', 'owner')).j, { is_owner: true });
  assert.deepEqual((await call('GET', '/api/email-triage/viewer', 'admin')).j, { is_owner: false });
  assert.equal((await call('GET', '/api/email-triage/viewer', 'staff')).status, 403);
});

check('SERVER: running Pull Welcome never calls Pull inbox (/pull)', async () => {
  pullCalls = 0;
  await call('POST', '/api/email-triage/ingest', 'owner', WELCOME_BODY);
  assert.equal(pullCalls, 0);
});

// ---- page ----
const html = fs.readFileSync(path.join(ROOT, 'public/communications.html'), 'utf8');
function extract(src, start, endMarker) { const i = src.indexOf(start); assert.ok(i >= 0, 'missing ' + start); const j = src.indexOf(endMarker, i); return src.slice(i, j); }
const pwSrc = extract(html, "const PULL_WELCOME = ", 'async function showOwnerActions');
function sandbox({ confirmAnswer = true, response = { ok: true, status: 200, body: { ok: true, scanned: 3, kept: 3, skipped: 0, failed: 0, errors: [] } } } = {}) {
  const calls = []; const els = { pullWelcomeBtn: { disabled: false, innerHTML: 'Pull Welcome', style: {} }, pullStatus: { style: {}, textContent: '', innerHTML: '' } };
  const ctx = {
    window: {}, confirm: () => confirmAnswer, JSON, Array, console,
    document: { getElementById: (id) => els[id] },
    esc: (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])),
    loadStats() {}, loadList() {},
    af: async (u, o) => { calls.push({ u, o }); if (response instanceof Error) throw response; return { ok: response.ok, status: response.status, json: async () => response.body }; },
  };
  vm.createContext(ctx); vm.runInContext(pwSrc, ctx);
  return { run: () => ctx.window.pullWelcome(), calls, els };
}

check('PAGE: nothing happens unless the owner confirms', async () => {
  const s = sandbox({ confirmAnswer: false }); await s.run();
  assert.equal(s.calls.length, 0);
});

check('PAGE: once confirmed it calls ONLY /api/email-triage/ingest with welcome@ / 7 days / full AI / max 50', async () => {
  const s = sandbox(); await s.run();
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].u, '/api/email-triage/ingest'); assert.equal(s.calls[0].o.method, 'POST');
  assert.deepEqual(JSON.parse(s.calls[0].o.body), WELCOME_BODY);
  assert.ok(!s.calls.some((c) => /\/pull\b/.test(c.u)), 'never Pull inbox');
});

check('PAGE: shows scanned, kept, skipped, failed and errors after it runs', async () => {
  const s = sandbox(); await s.run();
  const out = s.els.pullStatus.innerHTML;
  for (const w of ['scanned <strong>3</strong>', 'kept <strong>3</strong>', 'skipped <strong>0</strong>', 'failed <strong>0</strong>', 'errors: none']) assert.ok(out.includes(w), `${w} in ${out}`);
  assert.equal(s.els.pullWelcomeBtn.disabled, false, 'button re-enabled');
});

check('PAGE: failures and per-message errors are shown, not hidden', async () => {
  const withErr = sandbox({ response: { ok: true, status: 200, body: { ok: true, scanned: 3, kept: 2, skipped: 0, failed: 1, errors: [{ subject: 'Test', error: 'model timeout' }] } } });
  await withErr.run();
  assert.ok(withErr.els.pullStatus.innerHTML.includes('failed <strong>1</strong>')); assert.ok(withErr.els.pullStatus.innerHTML.includes('Test: model timeout'));
  const denied = sandbox({ response: { ok: false, status: 403, body: { error: 'owner_only', detail: 'Only the account owner can run a single-mailbox ingest.' } } });
  await denied.run();
  assert.match(denied.els.pullStatus.textContent, /HTTP 403/); assert.match(denied.els.pullStatus.textContent, /account owner/);
  const net = sandbox({ response: new Error('network down') }); await net.run();
  assert.match(net.els.pullStatus.textContent, /network down/);
});

check('PAGE: the button is hidden by default and shown only when the server says the viewer is the owner', () => {
  assert.ok(/<button id="pullWelcomeBtn"[^>]*style="display:none;/.test(html));
  const so = extract(html, 'async function showOwnerActions', '\n}\n');
  assert.ok(/\/api\/email-triage\/viewer/.test(so) && /is_owner/.test(so));
  assert.ok(/loadDraftCount\(\); showOwnerActions\(\);/.test(html));
});

check('PAGE: Pull inbox (pullNow) is byte-for-byte unchanged from main', () => {
  const { execSync } = require('child_process');
  let mainHtml;
  try { mainHtml = execSync('git show origin/main:public/communications.html', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch (_) { mainHtml = null; }
  if (!mainHtml) { console.log('     (origin/main not available here; skipped)'); return; }
  const a = extract(mainHtml, 'window.pullNow = async function(){', '\n};\n'), b = extract(html, 'window.pullNow = async function(){', '\n};\n');
  assert.equal(b, a);
});

(async () => {
  server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
  for (const t of pending) await t();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
