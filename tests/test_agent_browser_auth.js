// tests/test_agent_browser_auth.js  (Ed 2026-10-23) — regression: Ed opened the run URL in the
// address bar while signed in and got owner_only. A typed URL carries only the shared staff cookie,
// which cannot identify the owner; the owner check reads the Supabase session token that trustEd's
// pages send. The fix keeps requireOwner exactly as it is and starts runs from a signed-in page.
// Supabase and the runner are stubbed; no browser, no network.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
process.env.SUPABASE_URL = 'http://localhost:1'; process.env.SUPABASE_KEY = 'test-key';
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const USERS = { 'owner-token': { id: 'u-ed', email: 'egojara@bedrocktx.com', role: 'admin' }, 'staff-token': { id: 'u-staff', email: 'staff@bedrocktx.com', role: 'staff' } };
stub('@supabase/supabase-js', { createClient: () => ({
  auth: { getUser: async (t) => (USERS[t] ? { data: { user: { id: USERS[t].id, email: USERS[t].email } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }) },
  from: () => { let id = null; const q = { select() { return q; }, eq(c, v) { if (c === 'id') id = v; return q; }, order() { return q; }, limit() { return q; },
    maybeSingle: async () => { const u = Object.values(USERS).find((x) => x.id === id); return { data: u ? { role: u.role, is_active: true, full_name: 'X', email: u.email } : null }; },
    then(r) { return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/x.png' }, error: null }) }) },
}) });
const runs = [];
stub('../lib/agent_browser/runner', { SKILLS: { 'newfirst.login_navigation': () => ({}) }, JOB: 'agent_browser', BUCKET: 'documents',
  runSkill: async (skill, o) => { runs.push({ skill, trigger: o.trigger }); return { run_id: 'r1', status: 'completed', skill }; } });

const express = require('express');
const app = express(); app.use('/api/agent-browser', require('../api/agent_browser'));
const tests = []; const check = (n, fn) => tests.push([n, fn]);

(async () => {
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/agent-browser`;
  const call = (method, p, token, cookie = 'staff_session=signed') => fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Cookie: cookie } });

  check('a typed URL (staff cookie, no session token) is refused as before: the owner gate is unchanged', async () => {
    const r = await call('POST', '/run/newfirst.login_navigation', null);
    assert.strictEqual(r.status, 403); assert.strictEqual((await r.json()).error, 'owner_only'); assert.strictEqual(runs.length, 0);
  });
  check('another signed-in staffer is refused', async () => {
    const r = await call('POST', '/run/newfirst.login_navigation', 'staff-token');
    assert.strictEqual(r.status, 403); assert.strictEqual(runs.length, 0);
  });
  check('the owner, from the signed-in page (session token), starts the run; the run records who started it', async () => {
    const r = await call('POST', '/run/newfirst.login_navigation', 'owner-token');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(runs, [{ skill: 'newfirst.login_navigation', trigger: 'owner:egojara@bedrocktx.com' }]);
  });
  check('there is no GET form of the action (a link can never start a run)', async () => {
    const r = await call('GET', '/run/newfirst.login_navigation', 'owner-token');
    assert.strictEqual(r.status, 404); assert.strictEqual(runs.length, 1);
  });
  check('evidence comes back as JSON for the signed-in page (no redirect a token-less image tag would need)', async () => {
    const r = await call('GET', '/evidence?path=agent-browser/123e4567-e89b-12d3-a456-426614174000/01-open_home.png', 'owner-token');
    assert.strictEqual(r.status, 200); assert.strictEqual((await r.json()).url, 'https://signed.example/x.png');
    assert.strictEqual((await call('GET', '/evidence?path=../../etc/passwd', 'owner-token')).status, 400);
  });
  check('the owner page sends the session token and POSTs; it is served and linked from the Finance menu', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'agent-browser.html'), 'utf8');
    assert.match(page, /h\.Authorization='Bearer '\+s\.access_token/);
    assert.match(page, /af\('\/api\/agent-browser\/run\/newfirst\.login_navigation',\{method:'POST'\}\)/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /app\.get\('\/admin\/agent-browser'/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'), /href: '\/admin\/agent-browser'/);
    const gate = fs.readFileSync(path.join(__dirname, '..', 'api', '_require_admin.js'), 'utf8');
    assert.match(gate, /if \(!u \|\| u\.role !== 'admin' \|\| email !== OWNER_EMAIL\)/, 'requireOwner itself is unchanged');
  });

  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log('  ✓ ' + n); }
    catch (e) { fail += 1; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); }
  }
  console.log(`\nagent_browser_auth: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  srv.closeAllConnections(); srv.close();
})();
