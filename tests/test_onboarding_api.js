// ============================================================================
// tests/test_onboarding_api.js  (Issue #15 Milestone 2) — HTTP layer + UI + repo guards
// ----------------------------------------------------------------------------
// Proves the API cannot be used to bypass the guarded service path:
//   - reads and stage runs need an admin; waive / advance / approve need the
//     OWNER (refused before the service is ever called);
//   - the actor is built from the authenticated user; actor / role / kind in
//     a request body are ignored;
//   - service / database refusals come back as their status with the reason;
//     unexpected errors are sanitized;
//   - the page only talks to /api/onboarding and never sends an identity;
//   - nothing in the app writes the onboarding tables directly (only the 482
//     SQL functions do), and the service's only database call is the rpc
//     allowlist.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { buildRouter } = require('../api/onboarding');
const { ServiceError, RPC } = require('../lib/onboarding/service');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const OWNER_EMAIL = 'owner@example.test';
const USERS = { owner: { user: { id: 'u-owner' }, email: OWNER_EMAIL, role: 'admin' }, admin: { user: { id: 'u-admin' }, email: 'staff@example.test', role: 'admin' } };
const auth = {
  OWNER_EMAIL,
  async requireAdmin(req, res) { const u = USERS[req.headers['x-test-user']]; if (!u) { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
  async requireOwner(req, res) { const u = USERS[req.headers['x-test-user']]; if (!u || u.email !== OWNER_EMAIL) { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
};
function fakeService() {
  const calls = [];
  const rec = (name, ret) => async (...args) => { calls.push({ name, args }); if (typeof ret === 'function') return ret(...args); return ret; };
  return { calls, schemaStatus: rec('schemaStatus', { ready: true, needs: [] }), listBatches: rec('listBatches', []), getBatch: rec('getBatch', (id, actor) => ({ id, actor })),
    getSnapshot: rec('getSnapshot', (id, cid) => (id === 'none' ? null : { completion_id: cid || 'latest', lines: [] })),
    createBatch: rec('createBatch', 'b-new'), registerArtifact: rec('registerArtifact', 'a-1'), runStage: rec('runStage', { status: 'PASS' }),
    waive: rec('waive', 'w-1'), advance: rec('advance', (actor, id, body) => { if (body.to === 'snapshot') throw new ServiceError(409, 'REFUSED_BY_DATABASE', 'stage advance refused: stage source_controls is FAIL; not waived: x'); return 'e-1'; }),
    approve: rec('approve', () => { throw new Error('Supabase exploded with secret details'); }) };
}
async function withServer(fn) {
  const service = fakeService();
  const app = express(); app.use('/api/onboarding', buildRouter({ service, auth, listCommunities: async () => [{ id: 'c2', name: 'Alpha' }, { id: 'c1', name: 'Zeta' }] }));
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/onboarding`;
  const req = async (method, p, { user, body, form } = {}) => {
    const headers = {}; if (user) headers['x-test-user'] = user;
    let payload; if (form) payload = form; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers, body: payload }); return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try { await fn({ req, service }); } finally { srv.close(); }
}

check('reads need an admin; the view gets an actor built from auth (owner email -> role owner, other admin -> role admin)', async () => withServer(async ({ req, service }) => {
  assert.strictEqual((await req('GET', '/batches')).status, 403);
  assert.strictEqual((await req('GET', '/batches/b1', { user: 'admin' })).json.actor.role, 'admin');
  const o = (await req('GET', '/batches/b1', { user: 'owner' })).json.actor;
  assert.deepStrictEqual(o, { kind: 'human', id: 'u-owner', email: OWNER_EMAIL, role: 'owner' });
  assert.strictEqual((await req('GET', '/status', { user: 'admin' })).json.ready, true);
}));
check('waive / advance / approve: an admin (not owner) is refused BEFORE the service is called', async () => withServer(async ({ req, service }) => {
  for (const p of ['/batches/b1/waivers', '/batches/b1/advance', '/batches/b1/approve']) assert.strictEqual((await req('POST', p, { user: 'admin', body: { completion_id: 'c', code: 'x', reason: 'some reason here', to: 'normalize' } })).status, 403, p);
  assert.ok(!service.calls.some((c) => ['waive', 'advance', 'approve'].includes(c.name)));
}));
check('identity in the request body is ignored: the service receives the authenticated owner as a human', async () => withServer(async ({ req, service }) => {
  const r = await req('POST', '/batches/b1/waivers', { user: 'owner', body: { completion_id: 'c1', code: 'gl.x', reason: 'reviewed and documented', actor: { kind: 'agent', id: 'claude' }, actor_kind: 'agent', actor_id: 'someone-else', role: 'owner' } });
  assert.strictEqual(r.status, 200);
  const call = service.calls.find((c) => c.name === 'waive');
  assert.deepStrictEqual(call.args[0], { kind: 'human', id: 'u-owner', email: OWNER_EMAIL, role: 'owner' });
  assert.deepStrictEqual(call.args[2], { completion_id: 'c1', code: 'gl.x', reason: 'reviewed and documented' });
}));
check('a database refusal comes back as 409 with its reason; an unexpected error is sanitized (no vendor detail)', async () => withServer(async ({ req }) => {
  const r = await req('POST', '/batches/b1/advance', { user: 'owner', body: { completion_id: 'c', to: 'snapshot' } });
  assert.strictEqual(r.status, 409); assert.ok(/not waived: x/.test(r.json.error)); assert.strictEqual(r.json.code, 'REFUSED_BY_DATABASE');
  const a = await req('POST', '/batches/b1/approve', { user: 'owner', body: { completion_id: 'c', preflight: {} } });
  assert.strictEqual(a.status, 500);
  assert.strictEqual(a.json.error, require('../api/_safe_error').safeErrorMessage(new Error('Supabase exploded with secret details')), 'unexpected errors go through safeErrorMessage (repo convention)');
}));
check('create validates fields; run passes only roles + authoritative; upload passes the file bytes and name', async () => withServer(async ({ req, service }) => {
  assert.strictEqual((await req('POST', '/batches', { user: 'admin', body: { community_id: 'c1' } })).status, 400);
  assert.strictEqual((await req('POST', '/batches', { user: 'admin', body: { community_id: 'c1', batch_code: 'B', as_of_date: '2026-07-31', source_system: 'vantaca' } })).json.id, 'b-new');
  await req('POST', '/batches/b1/run', { user: 'admin', body: { roles: { ar_account: '1300' }, authoritative: {}, stage: 'execute', actor_kind: 'human' } });
  assert.deepStrictEqual(service.calls.find((c) => c.name === 'runStage').args[2], { roles: { ar_account: '1300' }, authoritative: {}, ap_account: undefined, fund_by_account: undefined });
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('report text')]), 'gl.txt'); fd.append('artifact_type', 'gl_trial_balance');
  assert.strictEqual((await req('POST', '/batches/b1/artifacts', { user: 'admin', form: fd })).json.id, 'a-1');
  const up = service.calls.find((c) => c.name === 'registerArtifact').args;
  assert.strictEqual(up[2].buffer.toString(), 'report text'); assert.strictEqual(up[2].filename, 'gl.txt'); assert.strictEqual(up[2].artifact_type, 'gl_trial_balance');
  assert.deepStrictEqual((await req('GET', '/communities', { user: 'admin' })).json.map((c) => c.name), ['Alpha', 'Zeta']);
}));
check('snapshot read: admin only; latest or a given result; 404 when none', async () => withServer(async ({ req }) => {
  assert.strictEqual((await req('GET', '/batches/b1/snapshot')).status, 403);
  assert.strictEqual((await req('GET', '/batches/b1/snapshot', { user: 'admin' })).json.completion_id, 'latest');
  assert.strictEqual((await req('GET', '/batches/b1/snapshot?completion_id=c9', { user: 'admin' })).json.completion_id, 'c9');
  assert.strictEqual((await req('GET', '/batches/none/snapshot', { user: 'admin' })).status, 404);
}));
check('page: talks only to /api/onboarding (and auth config); never sends an actor, kind or role; owner gate is server-side', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  const urls = [...html.matchAll(/['"](\/api\/[^'"?]*)/g)].map((m) => m[1]);
  assert.ok(urls.length > 5);
  for (const u of urls) assert.ok(u.startsWith('/api/onboarding') || u === '/api/auth/config', u);
  const bodies = [...html.matchAll(/json\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 3, 'found the request bodies');
  assert.ok(!/body = \{[^;]*\b(actor|role|kind)\b/.test(html), 'the run body carries only roles + authoritative');
  for (const b of bodies) assert.ok(!/actor|role|kind/.test(b), 'page must not send identity: ' + b);
  assert.ok(!/fd\.append\(['"](actor|role|kind)/.test(html));
  assert.ok(/still FAIL\/BLOCKED|stays/.test(html), 'page explains a waived control stays failed');
});
check('repo guard: nothing writes the onboarding tables directly (only the 482 SQL functions do)', () => {
  const root = path.join(__dirname, '..'); const hits = [];
  const scan = (d) => { for (const f of fs.readdirSync(d)) { if (['node_modules', '.git', 'migrations', 'tests', 'academy', 'backups'].includes(f)) continue; const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) scan(p); else if (/\.(js|mjs|html)$/.test(f)) { const s = fs.readFileSync(p, 'utf8'); for (const m of s.matchAll(/from\(\s*['"](onboarding_[a-z_]+|conversion_batches|conversion_runs|conversion_control_results)['"]\s*\)([^;]{0,200})/g)) if (/\.(insert|update|upsert|delete)\s*\(/.test(m[2])) hits.push(`${path.relative(root, p)}: ${m[1]}`); } } };
  scan(root);
  assert.deepStrictEqual(hits, []);
});
check('service guard: its only database calls are the onboarding_* rpc allowlist and the write-once artifact store', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'service.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(RPC.length === 12 && RPC.every((n) => /^onboarding_/.test(n)));
  assert.strictEqual((s.match(/\.rpc\(/g) || []).length, 1, 'exactly one rpc call site');
  assert.ok(/if \(!RPC\.includes\(name\)\) throw/.test(s));
  assert.ok(!/\.from\(\s*['"](?!documents)/.test(s.replace(/storage\.from\(bucket\)/g, '').replace(/Buffer\.from\(/g, '')), 'no table access');
  assert.ok(/upsert: false/.test(s), 'artifact bytes are never overwritten');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding API / UI / repo guards (Issue #15 Milestone 2)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
