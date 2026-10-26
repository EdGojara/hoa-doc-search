// tests/test_time_attendance_api.js  (Ed 2026-10-26, migration 547) — the Time &
// Attendance API keeps privacy and control where the design says:
//   - employee routes act AS the employee: the anon key plus the employee's own
//     token (so database RLS applies), never the service key; no route takes an
//     employee id; a punch never carries a time;
//   - every /admin route is owner-only, and the deciding administrator comes from
//     the sign-in, never the request body;
//   - a payroll file with open exceptions is refused (409) unless the owner gives
//     a reason, and every export is written to the audit trail;
//   - the read model and Amanda's path never write.
// Runs the real router against in-memory Supabase stubs (no network, no database).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const ROOT = path.join(__dirname, '..');
process.env.SUPABASE_URL = 'http://localhost:1';
process.env.SUPABASE_KEY = 'service-key';
process.env.SUPABASE_ANON_KEY = 'anon-key';
process.env.OWNER_EMAIL = 'owner@example.test';

// ---- in-memory Supabase stub ------------------------------------------------------
const USERS = { 'owner-token': 'u-owner', 'ana-token': 'u-ana', 'cy-token': 'u-cy' };
const PROFILES = [
  { id: 'u-owner', email: 'owner@example.test', full_name: 'Owner', role: 'admin', is_active: true },
  { id: 'u-ana', email: 'ana@example.test', full_name: 'Ana Staff', role: 'staff', is_active: true },
  { id: 'u-cy', email: 'cy@example.test', full_name: 'Cy Staff', role: 'staff', is_active: true },
];
let CALLS; let TABLES; let RPC_RESULT;
function reset() {
  CALLS = { rpc: [], inserts: [], clients: [] };
  RPC_RESULT = {};
  TABLES = {
    user_profiles: PROFILES,
    ta_settings: [{ id: 1, workweek_start_dow: 0, weekly_threshold_minutes: 2400, pay_frequency: null, pay_period_anchor: null }],
    ta_employees: [{ user_id: 'u-ana', flsa_status: 'nonexempt', tracks_time: true, active: true }],
    v_ta_effective_punches: [{ punch_id: 'p1', user_id: 'u-ana', direction: 'in', effective_at: new Date(Date.now() - 3 * 86400000).toISOString(), reason: 'start_shift', is_corrected: false, origin: 'punch' }],
    ta_corrections: [], ta_overtime_requests: [], ta_activity_summaries: [], communities: [{ id: 'c1', name: 'Canyon Gate', management_status: 'active' }],
    audit_events: [],
  };
}
function builder(client, table) {
  const st = { table, filters: [] };
  const rows = () => (TABLES[table] || []).filter((r) => st.filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const b = {
    select() { return b; }, order() { return b; }, limit() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; }, not() { return b; }, or() { return b; },
    eq(k, v) { st.filters.push([k, v]); return b; }, in(k, v) { st.filters.push([k, v]); return b; },
    range(a, z) { st.range = [a, z]; return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    single() { const r = rows()[0]; return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: 'no rows' } }); },
    insert(row) { CALLS.inserts.push({ key: client.key, table, row }); (TABLES[table] = TABLES[table] || []).push({ id: 'ev-1', created_at: 'now', ...row }); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'ev-1', created_at: 'now' }, error: null }) }) }; },
    then(res, rej) { const r = rows(); return Promise.resolve({ data: st.range ? r.slice(st.range[0], st.range[1] + 1) : r, error: null }).then(res, rej); },
  };
  return b;
}
function createClient(url, key, opts = {}) {
  const auth = ((opts.global || {}).headers || {}).Authorization || null;
  const client = { key, auth };
  CALLS && CALLS.clients.push({ key, auth });
  client.from = (t) => builder(client, t);
  client.rpc = (fn, args) => { CALLS.rpc.push({ fn, args, key, auth }); return Promise.resolve(RPC_RESULT[fn] || { data: { ok: true }, error: null }); };
  client.auth = { getUser: async (token) => (USERS[token] ? { data: { user: { id: USERS[token], email: PROFILES.find((p) => p.id === USERS[token]).email } }, error: null } : { data: { user: null }, error: { message: 'bad token' } }) };
  return client;
}
require.cache[require.resolve('@supabase/supabase-js')] = { id: 'supabase-stub', filename: 'supabase-stub', loaded: true, exports: { createClient } };
reset();

const app = express();
app.use('/api/time', require('../api/time_attendance'));
const server = http.createServer(app);

async function call(method, url, { token, body } = {}) {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text, headers: r.headers };
}

let n = 0;
const t = async (name, fn) => { reset(); await fn(); n++; console.log('  ok ', name); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  try {
    await t('no sign-in: 401 on every employee route', async () => {
      for (const [m, u] of [['GET', '/api/time/me'], ['POST', '/api/time/punch'], ['POST', '/api/time/corrections'], ['POST', '/api/time/activity'], ['POST', '/api/time/overtime']]) assert.strictEqual((await call(m, u, { body: {} })).status, 401, u);
    });
    await t('a punch acts as the employee (anon key + their own token) and never carries a time or an id', async () => {
      const r = await call('POST', '/api/time/punch', { token: 'ana-token', body: { direction: 'in', reason: 'start_shift', punched_at: '2020-01-01T00:00:00Z', user_id: 'u-cy' } });
      assert.strictEqual(r.status, 200, r.text);
      const c = CALLS.rpc.find((x) => x.fn === 'ta_punch');
      assert.strictEqual(c.key, 'anon-key');
      assert.strictEqual(c.auth, 'Bearer ana-token');
      assert.ok(!Object.keys(c.args).some((k) => /at$|time|user/i.test(k) && k !== 'p_user_agent'), JSON.stringify(c.args));
    });
    await t('a punch needs a valid direction and reason', async () => {
      assert.strictEqual((await call('POST', '/api/time/punch', { token: 'ana-token', body: { direction: 'in', reason: 'end_of_shift' } })).status, 400);
      assert.strictEqual((await call('POST', '/api/time/punch', { token: 'ana-token', body: { direction: 'sideways', reason: 'x' } })).status, 400);
    });
    await t('database refusals come back in plain words', async () => {
      RPC_RESULT.ta_punch = { data: null, error: { message: 'ta_sequence: already clocked in' } };
      const r = await call('POST', '/api/time/punch', { token: 'ana-token', body: { direction: 'in', reason: 'start_shift' } });
      assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'already_clocked_in');
      RPC_RESULT.ta_punch = { data: null, error: { message: 'ta_not_enrolled: this account is not enrolled' } };
      assert.strictEqual((await call('POST', '/api/time/punch', { token: 'cy-token', body: { direction: 'in', reason: 'start_shift' } })).json.error, 'not_enrolled');
    });
    await t('a correction converts Central wall time to the right instant, as the employee', async () => {
      const r = await call('POST', '/api/time/corrections', { token: 'ana-token', body: { kind: 'add_punch', direction: 'out', date: '2026-10-23', time: '17:05', reason: 'Forgot', user_id: 'u-cy' } });
      assert.strictEqual(r.status, 200, r.text);
      const c = CALLS.rpc.find((x) => x.fn === 'ta_request_correction');
      assert.strictEqual(c.args.p_proposed_at, '2026-10-23T22:05:00.000Z');
      assert.strictEqual(c.key, 'anon-key');
      assert.ok(!('p_user_id' in c.args));
      const { centralToIso } = require('../api/time_attendance')._internal;
      assert.strictEqual(centralToIso('2026-11-02', '08:00'), '2026-11-02T14:00:00.000Z');
    });
    await t('a correction needs a reason', async () => {
      assert.strictEqual((await call('POST', '/api/time/corrections', { token: 'ana-token', body: { kind: 'add_punch', direction: 'out', date: '2026-10-23', time: '17:05', reason: ' ' } })).status, 400);
    });
    await t('GET /me reads through the employee client, never the service key', async () => {
      const r = await call('GET', '/api/time/me', { token: 'ana-token' });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.enrolled, true);
      assert.ok(r.json.timesheet.flags.some((f) => f.code === 'missing_out'));
      assert.ok(CALLS.clients.some((c) => c.key === 'anon-key' && c.auth === 'Bearer ana-token'));
    });
    await t('every /admin route is owner-only', async () => {
      for (const [m, u] of [['GET', '/api/time/admin/overview'], ['GET', '/api/time/admin/timesheet/00000000-0000-4000-8000-000000000001'], ['GET', '/api/time/admin/activity'],
        ['POST', '/api/time/admin/corrections/00000000-0000-4000-8000-000000000001/decide'], ['POST', '/api/time/admin/overtime/00000000-0000-4000-8000-000000000001/decide'],
        ['POST', '/api/time/admin/employees'], ['POST', '/api/time/admin/settings'], ['GET', '/api/time/admin/payroll?from=2026-10-16&to=2026-10-31']]) {
        assert.strictEqual((await call(m, u, { token: 'ana-token', body: {} })).status, 403, `${m} ${u}`);
        assert.strictEqual((await call(m, u, { body: {} })).status, 403, `${m} ${u} (no sign-in)`);
      }
      assert.strictEqual(CALLS.rpc.length, 0);
    });
    await t('the deciding administrator comes from the sign-in, not the body; a reason is required', async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      assert.strictEqual((await call('POST', `/api/time/admin/corrections/${id}/decide`, { token: 'owner-token', body: { decision: 'approved', reason: '' } })).status, 400);
      const r = await call('POST', `/api/time/admin/corrections/${id}/decide`, { token: 'owner-token', body: { decision: 'approved', reason: 'Confirmed', p_actor: 'u-ana', actor: 'u-ana' } });
      assert.strictEqual(r.status, 200, r.text);
      const c = CALLS.rpc.find((x) => x.fn === 'ta_decide_correction');
      assert.strictEqual(c.args.p_actor, 'u-owner');
      assert.strictEqual(c.key, 'service-key');
    });
    await t('the owner overview loads and offers enrollment for staff not yet enrolled (never the owner)', async () => {
      const r = await call('GET', '/api/time/admin/overview', { token: 'owner-token' });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(r.json.not_enrolled.map((u) => u.user_id), ['u-cy']);
      assert.strictEqual(r.json.people.length, 1);
    });
    await t('payroll: open exceptions refuse the file (409) unless the owner gives a reason; the export is audited', async () => {
      const q = '/api/time/admin/payroll?from=2026-10-01&to=' + new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const preview = await call('GET', q, { token: 'owner-token' });
      assert.strictEqual(preview.status, 200, preview.text);
      assert.ok(preview.json.exceptions.length >= 1);
      const refused = await call('GET', q + '&format=csv', { token: 'owner-token' });
      assert.strictEqual(refused.status, 409);
      assert.strictEqual(CALLS.inserts.filter((i) => i.table === 'audit_events').length, 0);
      const ok = await call('GET', q + '&format=csv&override_reason=' + encodeURIComponent('Payroll due today'), { token: 'owner-token' });
      assert.strictEqual(ok.status, 200, ok.text);
      assert.ok(ok.text.startsWith('Employee,Email,Status'));
      const ev = CALLS.inserts.find((i) => i.table === 'audit_events');
      assert.ok(ev && ev.row.action === 'payroll.exported' && ev.row.actor_user_id === 'u-owner' && ev.row.reason === 'Payroll due today' && ev.row.record_ownership === 'workpaper');
    });

    await t('Today notification source: a missing clock-out and a pending correction reach the owner; nobody enrolled means nothing', async () => {
      const RM = require('../lib/time_attendance/read_model');
      TABLES.ta_corrections = [{ id: 'c1', user_id: 'u-ana', kind: 'add_punch', status: 'pending', requested_at: new Date().toISOString() }];
      const a = await RM.ownerAlerts(createClient('x', 'service-key'));
      assert.strictEqual(a.error, null);
      assert.ok(a.missing_punches.some((m) => m.user_id === 'u-ana' && m.code === 'missing_out' && m.employee === 'Ana Staff'));
      assert.strictEqual(a.pending_corrections.length, 1);
      TABLES.ta_employees = [];
      const b = await RM.ownerAlerts(createClient('x', 'service-key'));
      assert.deepStrictEqual([b.missing_punches.length, b.pending_corrections.length, b.error], [0, 0, null]);
    });

    // ---- static guards ----------------------------------------------------------------
    await t('STATIC: the read model never writes', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'lib/time_attendance/read_model.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/\.(insert|update|upsert|delete|rpc)\s*\(/.test(src), 'read_model.js must stay read-only');
    });
    await t('STATIC: employee routes never use the service client or read an employee id from the request', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'api/time_attendance.js'), 'utf8');
      const employeePart = src.slice(src.indexOf("router.get('/me'"), src.indexOf('// ---- owner'));
      assert.ok(employeePart.length > 1000);
      assert.ok(!/service\(\)\.(rpc|from\('ta_)/.test(employeePart), 'employee routes must not use the service client on ta_ data');
      assert.ok(!/(body|query|params)\.user_id/.test(employeePart), 'employee routes must not accept an employee id');
      assert.ok(!/p_punched_at|punched_at:/.test(employeePart), 'a punch must never carry a time');
      for (const m of employeePart.matchAll(/router\.(get|post)\('([^']+)'/g)) {
        const body = employeePart.slice(m.index, employeePart.indexOf('\n});', m.index));
        assert.ok(/employeeContext\(req, res\)/.test(body), `${m[2]} must start with employeeContext`);
      }
    });
    await t('STATIC: every /admin route starts with requireOwner', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'api/time_attendance.js'), 'utf8');
      for (const m of src.matchAll(/router\.(get|post)\('(\/admin[^']+)',\s*(async \(req, res\) => \{\r?\n\s*const owner = await requireOwner|\(req, res\) => decide\()/g)) assert.ok(m[2]);
      const admins = [...src.matchAll(/router\.(get|post)\('(\/admin[^']+)'/g)].length;
      const gated = [...src.matchAll(/router\.(get|post)\('(\/admin[^']+)',\s*(?:async \(req, res\) => \{\r?\n\s*const owner = await requireOwner\(req, res\); if \(!owner\) return;|\(req, res\) => decide\()/g)].length;
      assert.strictEqual(gated, admins, 'an /admin route is missing requireOwner');
      assert.ok(/async function decide\(req, res, fn, label\) \{\r?\n\s*const owner = await requireOwner\(req, res\); if \(!owner\) return;/.test(src));
    });
    await t('STATIC: Amanda gets team activity only in-app, only for the owner, read-only', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'lib/amanda/request.js'), 'utf8');
      assert.ok(/if \(channel === 'app' && isOwnerActor\(actor\) && isTeamQuestion\(text\)\)/.test(src));
      assert.ok(/teamActivityBrief\(/.test(src) && !/time_attendance\/(?!read_model)/.test(src), 'Amanda may load only the read model');
    });
  } finally { server.close(); }
  console.log(`\n${n} passed`);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
