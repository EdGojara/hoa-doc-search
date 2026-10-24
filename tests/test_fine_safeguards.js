// Phase 1 fine safeguards (Ed 2026-10-24). Ed is the only fine approver; a fine
// needs fines turned on AND a real board schedule row; free-text overrides are
// never accepted; posting fails closed until a notice-and-hearing record exists;
// the actor always comes from the session; automation never reaches a fine.
//
// Runs the REAL route handlers against an in-memory database: the Supabase
// client is stubbed before anything loads, so this never touches a real DB.
const assert = require('assert');
const path = require('path');
const Module = require('module');

for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost.test', SUPABASE_KEY: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test',
  OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', STRIPE_SECRET_KEY: 'sk_test_x', RESEND_API_KEY: 'test',
})) { if (!process.env[k]) process.env[k] = v; }
process.env.SUPABASE_URL = 'http://localhost.test'; // never a real project from this test

// ---------------------------------------------------------------- fake database
const T = {};
let seq = 0;
const tokens = {};
function reset(seed) {
  for (const k of Object.keys(T)) delete T[k];
  for (const [k, rows] of Object.entries(seed)) T[k] = rows.map((r) => ({ ...r }));
}
const rowsOf = (t) => (T[t] = T[t] || []);
function builder(table) {
  const st = { op: 'select', filters: [], patch: null, rows: null, limit: null };
  const match = (r) => st.filters.every(([op, k, v]) => {
    if (op === 'eq') return r[k] === v;
    if (op === 'neq') return r[k] !== v;
    if (op === 'in') return v.includes(r[k]);
    if (op === 'is') return (r[k] == null) === (v == null) && (v == null || r[k] === v);
    if (op === 'gte') return r[k] != null && String(r[k]) >= String(v);
    if (op === 'lt') return r[k] != null && String(r[k]) < String(v);
    return true;
  });
  const run = () => {
    const all = rowsOf(table);
    if (st.op === 'insert') { const ins = st.rows.map((r) => ({ id: 'id' + (++seq), ...r })); all.push(...ins); return { data: ins.map((r) => ({ ...r })), error: null }; }
    if (st.op === 'update') { const hit = all.filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit.map((r) => ({ ...r })), error: null }; }
    if (st.op === 'delete') { const keep = all.filter((r) => !match(r)); const n = all.length - keep.length; T[table] = keep; return { data: null, error: null, count: n }; }
    let out = all.filter(match).map((r) => ({ ...r }));
    if (st.limit != null) out = out.slice(0, st.limit);
    return { data: out, error: null };
  };
  const api = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(run()).then(res, rej);
      if (prop === 'eq' || prop === 'neq' || prop === 'in' || prop === 'is' || prop === 'gte' || prop === 'lt') return (k, v) => { st.filters.push([prop, k, v]); return api; };
      if (prop === 'insert') return (r) => { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return api; };
      if (prop === 'update') return (p) => { st.op = 'update'; st.patch = p; return api; };
      if (prop === 'delete') return () => { st.op = 'delete'; return api; };
      if (prop === 'limit') return (n) => { st.limit = n; return api; };
      if (prop === 'maybeSingle') return () => { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); };
      if (prop === 'single') return () => { const r = run(); const d = (r.data || [])[0] || null; return Promise.resolve({ data: d, error: d ? r.error : { message: 'no rows' } }); };
      return () => api; // select, order, not, or, range, ilike...: no-ops for this test
    },
  });
  return api;
}
const fake = {
  from: builder,
  auth: { getUser: async (tok) => (tokens[tok] ? { data: { user: tokens[tok] }, error: null } : { data: { user: null }, error: { message: 'bad token' } }) },
  storage: { from: () => ({ remove: async () => ({}), upload: async () => ({}), download: async () => ({ data: null }), createSignedUrl: async () => ({ data: null }) }) },
  rpc: async () => ({ data: null, error: null }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
};
const supaPath = require.resolve('@supabase/supabase-js');
const stub = new Module(supaPath); stub.filename = supaPath; stub.loaded = true;
stub.exports = { createClient: () => fake };
require.cache[supaPath] = stub;

const { OWNER_EMAIL } = require('../lib/auth/owner_email');
const FA = require('../lib/enforcement/fine_authority');
const enforcement = require('../api/enforcement');
const communities = require('../api/communities');

// ---------------------------------------------------------------- route runner
function handlerFor(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function call(router, method, routePath, { params = {}, body = {}, query = {}, token = null } = {}) {
  const h = handlerFor(router, method, routePath);
  const req = { params, body, query, headers: token ? { authorization: 'Bearer ' + token } : {} };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      setHeader() {}, set() { return this; },
    };
    Promise.resolve(h(req, res, (e) => (e ? reject(e) : resolve({ status: 404, body: 'next' })))).catch(reject);
  });
}

// ---------------------------------------------------------------- seed data
const ED = { id: 'u-ed', email: OWNER_EMAIL };
const STAFF = { id: 'u-staff', email: 'martha@bedrocktx.com' };
const ADMIN2 = { id: 'u-admin2', email: 'second.admin@bedrocktx.com' };
tokens.ed = ED; tokens.staff = STAFF; tokens.admin2 = ADMIN2;
const PROFILES = [
  { id: 'u-ed', role: 'admin', is_active: true, full_name: 'Ed Gojara', email: OWNER_EMAIL },
  { id: 'u-staff', role: 'staff', is_active: true, full_name: 'Martha Bravo', email: STAFF.email },
  { id: 'u-admin2', role: 'admin', is_active: true, full_name: 'Second Admin', email: ADMIN2.email },
];
const recent = (days) => new Date(Date.now() - days * 864e5).toISOString();
const vio = (over) => ({ id: 'v1', property_id: 'p1', community_id: 'c-on', primary_category_id: 'k1', current_stage: 'certified_209', current_stage_started_at: recent(40), cure_period_ends_at: recent(5), opened_at: recent(90), resolved_at: null, resolved_via: null, quality_status: 'verified', board_priority_at_open: 'standard', ...over });
const sched = (over) => ({ community_id: 'c-on', category_id: 'k1', community_fines_enabled: true, effective_fines_enabled: true, first_offense_amount: 50, second_offense_amount: 100, third_offense_amount: 150, recurring_offense_amount: 200, source_row: 'category_specific', ...over });
function world(over = {}) {
  reset({
    user_profiles: PROFILES,
    communities: [
      { id: 'c-on', name: 'Fines On HOA', fines_enabled: true, active: true },
      { id: 'c-cg', name: 'Canyon Gate', fines_enabled: false, active: true },
    ],
    violations: [vio()],
    v_resolved_fine_schedule: [sched()],
    enforcement_category_aliases: [],
    fine_posting_queue: [],
    interactions: [],
    ...over,
  });
}
const queueRows = () => rowsOf('fine_posting_queue');
const stageOf = (id) => rowsOf('violations').find((v) => v.id === id).current_stage;

let passed = 0;
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

console.log('fine_safeguards:');
(async () => {
  // ---------------------------------------------------------- who approves
  await at('only Ed (active admin with the owner email) is a fine approver; staff, a second admin, inactive or missing users are not', async () => {
    assert.strictEqual(FA.isFineApprover({ role: 'admin', email: OWNER_EMAIL, is_active: true }, 'c-on'), true);
    assert.strictEqual(FA.isFineApprover({ user: { id: 'u-ed' }, role: 'admin', email: OWNER_EMAIL.toUpperCase() }, 'c-on'), true, 'getAuthedUser shape, case-insensitive');
    assert.strictEqual(FA.isFineApprover({ role: 'staff', email: OWNER_EMAIL }, 'c-on'), false, 'owner email without admin role');
    assert.strictEqual(FA.isFineApprover({ role: 'admin', email: ADMIN2.email }, 'c-on'), false, 'a second admin');
    assert.strictEqual(FA.isFineApprover({ role: 'admin', email: OWNER_EMAIL, is_active: false }, 'c-on'), false, 'deactivated');
    assert.strictEqual(FA.isFineApprover(null, 'c-on'), false);
  });
  await at('a named delegate can be added later in one place, scoped to communities, with no call-site change', async () => {
    FA.FINE_APPROVER_DELEGATES.push({ email: 'delegate@bedrocktx.com', community_ids: ['c-on'] });
    try {
      assert.strictEqual(FA.isFineApprover({ role: 'staff', email: 'delegate@bedrocktx.com' }, 'c-on'), true);
      assert.strictEqual(FA.isFineApprover({ role: 'staff', email: 'delegate@bedrocktx.com' }, 'c-cg'), false);
    } finally { FA.FINE_APPROVER_DELEGATES.length = 0; }
    assert.strictEqual(FA.FINE_APPROVER_DELEGATES.length, 0, 'today the delegate list is empty');
  });

  // ---------------------------------------------------------- authority
  await at('authority: fines off, no schedule, category off, no amount, not certified, closed, superseded -> refused with a reason', async () => {
    world();
    const chk = (v, extraSeed) => { if (extraSeed) Object.assign(T, extraSeed); return FA.checkFineAuthority({ supabase: fake, violation: v, offenseCount: 1 }); };
    assert.strictEqual((await chk(vio({ community_id: 'c-cg' }))).reason, 'fines_not_enabled');
    assert.strictEqual((await chk(vio(), { v_resolved_fine_schedule: [sched({ source_row: 'no_schedule', first_offense_amount: null })] })).reason, 'no_fine_schedule');
    assert.strictEqual((await chk(vio(), { v_resolved_fine_schedule: [] })).reason, 'no_fine_schedule');
    assert.strictEqual((await chk(vio(), { v_resolved_fine_schedule: [sched({ effective_fines_enabled: false })] })).reason, 'category_fines_not_enabled');
    assert.strictEqual((await chk(vio(), { v_resolved_fine_schedule: [sched({ first_offense_amount: null })] })).reason, 'no_fine_amount');
    T.v_resolved_fine_schedule = [sched()];
    assert.strictEqual((await chk(vio({ current_stage: 'courtesy_2' }))).reason, 'certified_notice_required');
    assert.strictEqual((await chk(vio({ resolved_at: recent(1) }))).reason, 'violation_closed');
    assert.strictEqual((await chk(vio({ quality_status: 'superseded' }))).reason, 'violation_superseded');
    const ok = await chk(vio());
    assert.ok(ok.ok && ok.amount === 50 && ok.source === 'category_specific', JSON.stringify(ok));
  });
  await at('authority fails CLOSED when the database errors (a broken query is never read as permission)', async () => {
    const broken = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: { message: 'column does not exist' } }) }) };
    const r = await FA.checkFineAuthority({ supabase: broken, violation: vio(), offenseCount: 1 });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'authority_check_failed');
  });

  // ---------------------------------------------------------- assess-fine
  const ASSESS = '/violations/:id/assess-fine';
  const OVERRIDE = { board_resolution_ref: 'Board minutes 2026-09-01', override_reason: 'board said so', amount: 999, user_id: 'u-spoof' };
  await at('assess-fine: no session -> refused, nothing written', async () => {
    world();
    const r = await call(enforcement.router, 'post', ASSESS, { params: { id: 'v1' }, body: OVERRIDE });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'sign_in_required');
    assert.strictEqual(queueRows().length, 0); assert.strictEqual(stageOf('v1'), 'certified_209');
  });
  await at('assess-fine: signed-in staff who is not the approver -> refused, nothing written', async () => {
    world();
    for (const tok of ['staff', 'admin2']) {
      const r = await call(enforcement.router, 'post', ASSESS, { params: { id: 'v1' }, body: OVERRIDE, token: tok });
      assert.strictEqual(r.status, 403, tok); assert.strictEqual(r.body.error, 'fine_approver_only');
    }
    assert.strictEqual(queueRows().length, 0); assert.strictEqual(stageOf('v1'), 'certified_209');
  });
  await at('assess-fine: fines disabled (Canyon Gate) -> refused even WITH board_resolution_ref + override_reason + amount', async () => {
    world({ violations: [vio({ community_id: 'c-cg' })], v_resolved_fine_schedule: [sched({ community_id: 'c-cg', community_fines_enabled: false })] });
    const r = await call(enforcement.router, 'post', ASSESS, { params: { id: 'v1' }, body: OVERRIDE, token: 'ed' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'fines_not_enabled');
    assert.ok(r.body.message && !/—/.test(r.body.message), 'plain-English reason, no em-dash');
    assert.strictEqual(queueRows().length, 0); assert.strictEqual(stageOf('v1'), 'certified_209');
  });
  await at('assess-fine: fines on but no schedule row for the category -> refused even with override fields', async () => {
    world({ v_resolved_fine_schedule: [sched({ source_row: 'no_schedule', effective_fines_enabled: false, first_offense_amount: null, second_offense_amount: null, third_offense_amount: null, recurring_offense_amount: null })] });
    const r = await call(enforcement.router, 'post', ASSESS, { params: { id: 'v1' }, body: OVERRIDE, token: 'ed' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'no_fine_schedule');
    assert.strictEqual(queueRows().length, 0); assert.strictEqual(stageOf('v1'), 'certified_209');
  });
  await at('assess-fine (authorized): amount comes ONLY from the schedule (body amount ignored), actor from the session (body user_id ignored), queued not posted', async () => {
    world({
      enforcement_category_aliases: [{ alias_category_id: 'k-alias', canonical_category_id: 'k1', status: 'confirmed' }],
      violations: [
        vio(),
        vio({ id: 'p-alias', primary_category_id: 'k-alias', current_stage: 'cured', resolved_at: recent(100), opened_at: recent(120) }), // counts (alias)
        vio({ id: 'p-super', quality_status: 'superseded', opened_at: recent(60) }),                                                   // never counts
        vio({ id: 'p-void', current_stage: 'voided', resolved_via: 'voided', opened_at: recent(70) }),                                 // never counts
        vio({ id: 'p-old', current_stage: 'cured', resolved_at: recent(400), opened_at: recent(400) }),                                // outside 12 months
        vio({ id: 'p-other', primary_category_id: 'k-unrelated', opened_at: recent(30) }),                                             // different category
      ],
    });
    const r = await call(enforcement.router, 'post', ASSESS, { params: { id: 'v1' }, body: OVERRIDE, token: 'ed' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.offense_count, 2, 'this case + one alias prior; self, superseded, voided, old, unrelated excluded');
    assert.strictEqual(r.body.fine_amount, 100, 'second-offense amount from the schedule, never the body amount');
    assert.strictEqual(r.body.posted, false);
    const q = queueRows();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].status === undefined || q[0].status === 'queued', true);
    assert.strictEqual(q[0].assessed_by_user_id, 'u-ed', 'actor from the session, not body.user_id');
    assert.ok(!/board said so|Board minutes/.test(q[0].notes), 'override text is not recorded as authority');
    assert.strictEqual(stageOf('v1'), 'fine_assessed');
  });

  // ---------------------------------------------------------- fine queue
  const qRow = (over) => ({ id: 'q1', violation_id: 'v1', property_id: 'p1', community_id: 'c-on', amount: 100, status: 'queued', posted_to_vantaca_at: null, posted_by_user_id: null, vantaca_charge_ref: null, notes: null, ...over });
  await at('fine queue GET: no session -> refused; signed-in staff can view', async () => {
    world({ fine_posting_queue: [qRow()] });
    const r0 = await call(enforcement.router, 'get', '/fine-queue', { query: {} });
    assert.strictEqual(r0.status, 403);
    const r1 = await call(enforcement.router, 'get', '/fine-queue', { query: {}, token: 'staff' });
    assert.strictEqual(r1.status, 200); assert.strictEqual(r1.body.queue.length, 1);
  });
  await at('fine queue PATCH: no session -> refused; staff may not change status (but may add a note)', async () => {
    world({ fine_posting_queue: [qRow()] });
    const r0 = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'reversed' } });
    assert.strictEqual(r0.status, 403);
    const r1 = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'reversed' }, token: 'staff' });
    assert.strictEqual(r1.status, 403); assert.strictEqual(r1.body.error, 'fine_approver_only');
    const r2 = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { vantaca_charge_ref: 'X1' }, token: 'staff' });
    assert.strictEqual(r2.status, 403, 'the Vantaca reference is approver-only');
    const r3 = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { notes: 'owner called' }, token: 'staff' });
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(queueRows()[0].status, 'queued'); assert.strictEqual(queueRows()[0].notes, 'owner called');
  });
  await at('fine queue PATCH: posting is REFUSED for everyone, Ed included (notice_and_hearing_not_recorded); nothing stamped', async () => {
    world({ fine_posting_queue: [qRow()] });
    for (const tok of ['ed', 'staff']) {
      const r = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'posted', vantaca_charge_ref: 'V-1', user_id: 'u-spoof' }, token: tok });
      assert.ok(r.status === 409 || r.status === 403, tok);
      if (tok === 'ed') { assert.strictEqual(r.body.error, 'notice_and_hearing_not_recorded'); assert.match(r.body.message, /notice and hearing/); assert.ok(!/—/.test(r.body.message)); }
    }
    const q = queueRows()[0];
    assert.strictEqual(q.status, 'queued'); assert.strictEqual(q.posted_to_vantaca_at, null); assert.strictEqual(q.posted_by_user_id, null); assert.strictEqual(q.vantaca_charge_ref, null);
  });
  await at('fine queue PATCH: illegal moves refused (reversed -> queued, reversed -> error, nonsense status)', async () => {
    world({ fine_posting_queue: [qRow({ status: 'reversed' })] });
    for (const status of ['queued', 'error']) {
      const r = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status }, token: 'ed' });
      assert.strictEqual(r.status, 409, status); assert.strictEqual(r.body.error, 'illegal_transition');
    }
    const bad = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'paid' }, token: 'ed' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(queueRows()[0].status, 'reversed');
  });
  await at('fine queue PATCH: Ed may reverse; the audit names Ed from the session, a spoofed body.user_id is ignored', async () => {
    world({ fine_posting_queue: [qRow()] });
    const r = await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'reversed', user_id: 'u-spoof' }, token: 'ed' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const q = queueRows()[0];
    assert.strictEqual(q.status, 'reversed'); assert.strictEqual(q.posted_by_user_id, null); assert.strictEqual(q.posted_to_vantaca_at, null);
    const note = rowsOf('interactions').find((i) => /Fine reversed/.test(i.subject));
    assert.ok(note && note.sent_by_user_id === 'u-ed' && /Ed Gojara/.test(note.content), JSON.stringify(rowsOf('interactions')));
    // error -> queued and posted -> reversed are allowed moves too
    world({ fine_posting_queue: [qRow({ status: 'error' })] });
    assert.strictEqual((await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'queued' }, token: 'ed' })).status, 200);
    world({ fine_posting_queue: [qRow({ status: 'posted' })] });
    assert.strictEqual((await call(enforcement.router, 'patch', '/fine-queue/:id', { params: { id: 'q1' }, body: { status: 'reversed' }, token: 'ed' })).status, 200);
  });

  // ---------------------------------------------------------- advance to fine_assessed
  const ADV = '/violations/:violationId/advance-stage';
  await at('advance to Fine Assessed: staff refused; Ed refused with fines off or no schedule; stage unchanged', async () => {
    world();
    const s = await call(enforcement.router, 'post', ADV, { params: { violationId: 'v1' }, body: { note: 'still there' }, token: 'staff' });
    assert.strictEqual(s.status, 403); assert.strictEqual(s.body.error, 'fine_approver_only');
    world({ violations: [vio({ community_id: 'c-cg' })] });
    const off = await call(enforcement.router, 'post', ADV, { params: { violationId: 'v1' }, body: { note: 'still there' }, token: 'ed' });
    assert.ok(off.status === 400 || off.status === 409); assert.strictEqual(stageOf('v1'), 'certified_209');
    world({ v_resolved_fine_schedule: [sched({ source_row: 'no_schedule', first_offense_amount: null })] });
    const none = await call(enforcement.router, 'post', ADV, { params: { violationId: 'v1' }, body: { note: 'still there', board_resolution_ref: 'x', override_reason: 'y' }, token: 'ed' });
    assert.strictEqual(none.status, 409); assert.strictEqual(none.body.error, 'no_fine_schedule');
    assert.strictEqual(stageOf('v1'), 'certified_209');
    world({ violations: [vio({ current_stage: 'courtesy_1' })] });
    const jump = await call(enforcement.router, 'post', ADV, { params: { violationId: 'v1' }, body: { note: 'x', override_stage: 'fine_assessed' }, token: 'ed' });
    assert.strictEqual(jump.status, 409); assert.strictEqual(jump.body.error, 'certified_notice_required', 'no jumping from Courtesy 1 to a fine');
    assert.strictEqual(stageOf('v1'), 'courtesy_1');
  });
  await at('a case can never be OPENED at Fine Assessed (manual entry)', async () => {
    world();
    const r = await call(enforcement.router, 'post', '/violations/manual', { body: { community_id: 'c-on', property_id: 'p1', primary_category_id: 'k1', override_stage: 'fine_assessed' }, token: 'ed' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'fine_requires_approval');
    assert.strictEqual(rowsOf('violations').length, 1);
  });

  // ---------------------------------------------------------- automation
  await at('automation (cure-lapse cron) NEVER reaches Fine Assessed, even with fines on and a full schedule', async () => {
    world({ violations: [vio({ cure_period_ends_at: recent(3) })] });
    const out = await enforcement.processCureLapses({ communityId: 'c-on' });
    assert.strictEqual(out.processed, 1, 'the case was actually evaluated: ' + JSON.stringify(out));
    assert.strictEqual(out.fines_assessed, 0);
    assert.strictEqual(stageOf('v1'), 'certified_209');
    assert.strictEqual(queueRows().length, 0);
    assert.ok(rowsOf('interactions').some((i) => /staff review/.test(i.subject || '')), 'left for a person');
  });

  // ---------------------------------------------------------- the switches that make a fine possible
  await at('turning fines on and writing the fine schedule are approver-only', async () => {
    world();
    const t = await call(enforcement.router, 'patch', '/fine-schedule/:community_id/community-toggle', { params: { community_id: 'c-cg' }, body: { fines_enabled: true }, token: 'staff' });
    assert.strictEqual(t.status, 403);
    const p = await call(enforcement.router, 'put', '/fine-schedule/:community_id/row', { params: { community_id: 'c-cg' }, body: { category_id: 'k1', first_offense_amount: 50 }, token: 'staff' });
    assert.strictEqual(p.status, 403);
    const lc = await call(communities.router, 'patch', '/:communityId/letter-config', { params: { communityId: 'c-cg' }, body: { fines_enabled: true }, token: 'staff' });
    assert.strictEqual(lc.status, 403); assert.strictEqual(lc.body.error, 'fine_approver_only');
    const lc0 = await call(communities.router, 'patch', '/:communityId/letter-config', { params: { communityId: 'c-cg' }, body: { fines_enabled: true } });
    assert.strictEqual(lc0.status, 403, 'no session');
    assert.strictEqual(rowsOf('communities').find((c) => c.id === 'c-cg').fines_enabled, false, 'Canyon Gate fines stay off');
    assert.strictEqual(rowsOf('community_category_fine_schedule').length, 0);
  });

  console.log(`\nfine_safeguards: ${passed} passed`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
