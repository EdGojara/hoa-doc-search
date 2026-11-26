// tests/test_owner_authorization_service.js  (Ed 2026-11-25: Owner Authorization Service, step 1)
// One authorization service for every AI teammate, module and channel (lib/authorization):
// policy (tiers, channels), the action registry and its adapters, the shared event ledger and
// Amanda's follow-up feed, and the wiring of the existing in-app, email and grant paths.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AZ = require('../lib/authorization');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// A tiny fake Supabase client: records inserts, answers selects from fixtures, can fail on demand.
function fakeDb({ rows = [], failInsert = null } = {}) {
  const inserted = [];
  const builder = (table) => {
    const st = { table, filters: [], inRows: null };
    const api = {
      insert(r) { st.inRows = Array.isArray(r) ? r : [r]; return api; },
      select() { return api; },
      eq(k, v) { st.filters.push((x) => x[k] === v); return api; },
      in(k, vs) { st.filters.push((x) => vs.includes(x[k])); return api; },
      order() { return api; },
      limit() { return api; },
      then(res, rej) {
        if (st.inRows) {
          if (failInsert) return Promise.resolve({ data: null, error: { message: failInsert } }).then(res, rej);
          const out = st.inRows.map((r, i) => ({ id: `ev${inserted.length + i + 1}`, ...r }));
          inserted.push(...out);
          return Promise.resolve({ data: out, error: null }).then(res, rej);
        }
        const all = [...rows, ...inserted].filter((x) => x.__table ? x.__table === table : table === 'authorization_events');
        return Promise.resolve({ data: all.filter((x) => st.filters.every((f) => f(x))), error: null }).then(res, rej);
      },
    };
    return api;
  };
  return { from: builder, inserted };
}

check('policy: tier 3 (money movement) only in the signed-in app with step-up; tiers 1-2 on every verified channel; tier 2 reads back on conversational channels', () => {
  for (const c of ['email', 'conversation', 'grant', 'standing', 'in_app']) { assert.ok(AZ.channelAllowed(1, c), c); assert.ok(AZ.channelAllowed(2, c), c); }
  for (const c of ['email', 'conversation', 'grant', 'standing', 'voice', 'integration']) assert.ok(!AZ.channelAllowed(3, c), c);
  assert.ok(AZ.channelAllowed(3, 'in_app') && AZ.needsStepUp(3) && !AZ.needsStepUp(2));
  assert.ok(AZ.needsReadBack(2, 'email') && AZ.needsReadBack(2, 'conversation') && !AZ.needsReadBack(1, 'email') && !AZ.needsReadBack(2, 'in_app'));
  assert.strictEqual(AZ.COORDINATOR, 'ai-team:amanda');
  assert.ok(AZ.isTeammate('ai-team:kat') && !AZ.isTeammate('egojara@x.com'));
});

check('registry: accounting runs and conversion items are executable tier 1; cash transfer, payment release and vendor bank changes are declared tier 3 and never executable', () => {
  assert.strictEqual(AZ.actionForScope('accounting_runs').type, 'accounting_run');
  assert.strictEqual(AZ.actionForScope('conversion_objects').type, 'conversion_object');
  for (const t of ['cash_transfer', 'payment_release', 'vendor_bank_change']) { assert.strictEqual(AZ.ACTIONS[t].tier, 3); assert.strictEqual(AZ.ACTIONS[t].executable, false); }
  assert.strictEqual(AZ.ACTIONS.accounting_run.executor, 'ai-team:kat');
});

check('events: malformed events are refused (unknown event, execution without executor, authorization without authorizer, report without its event)', () => {
  const ok = { authority_kind: 'request', action_type: 'accounting_run', event: 'requested' };
  assert.doesNotThrow(() => AZ.buildEvent(ok));
  assert.throws(() => AZ.buildEvent({ ...ok, event: 'approved' }));
  assert.throws(() => AZ.buildEvent({ ...ok, event: 'executed' }));
  assert.throws(() => AZ.buildEvent({ ...ok, event: 'authorized' }));
  assert.throws(() => AZ.buildEvent({ ...ok, event: 'reported' }));
  assert.throws(() => AZ.buildEvent({ ...ok, channel: 'sms' }));
  assert.strictEqual(AZ.buildEvent(ok).coordinator, 'ai-team:amanda', 'Amanda coordinates by default');
});

check('events: before migration 577 the ledger is skipped (no throw); a write error is logged, never thrown into the action', async () => {
  const pre = fakeDb({ failInsert: 'relation "authorization_events" does not exist' });
  assert.deepStrictEqual(await AZ.recordEvents(pre, { authority_kind: 'request', action_type: 'x', event: 'requested' }), []);
  const bad = fakeDb({ failInsert: 'permission denied' });
  const err = console.error; let logged = ''; console.error = (...a) => { logged += a.join(' '); };
  try { assert.deepStrictEqual(await AZ.recordEvents(bad, { authority_kind: 'request', action_type: 'x', event: 'requested' }), []); } finally { console.error = err; }
  assert.ok(/event not recorded/.test(logged) && /permission denied/.test(logged));
});

check('run approvals: each channel records who authorized, who executed and the version approved', () => {
  const run = { id: 'r1', community_id: 'c1', process: 'journal_entry', period_month: '2026-10-01', prepared_by: 'Kat Reed (AI accounting manager)' };
  const inApp = AZ.runApprovalEvents({ run, approval: { channel: 'in_app', user_id: 'u', email: 'owner@x' }, fingerprint: 'fp1', outcome: 'posted', result: { posted_entries: [{}, {}] } });
  assert.deepStrictEqual(inApp.map((e) => e.event), ['authorized', 'executed']);
  assert.ok(inApp.every((e) => e.channel === 'in_app' && e.authority_kind === 'in_app' && e.fingerprint === 'fp1' && e.authorized_by_email === 'owner@x' && e.requested_by === 'ai-team:kat'));
  assert.strictEqual(inApp[1].result.posted_entries, 2);
  const email = AZ.runApprovalEvents({ run, approval: { channel: 'owner_authorization', authorization_id: 'a1', user_id: 'u', email: 'owner@x', executed_by: 'ai-team:kat' }, outcome: 'posted' });
  assert.deepStrictEqual(email.map((e) => [e.event, e.channel, e.authority_kind, e.executed_by]), [['executed', 'email', 'request', 'ai-team:kat']], 'the reply was already recorded as authorized; only the execution is added');
  const grant = AZ.runApprovalEvents({ run, approval: { channel: 'owner_grant', grant_id: 'g1', user_id: 'u', email: 'owner@x', executed_by: 'ai-team:claude' }, outcome: 'failed', error: 'boom', instruction: 'Approve and post run r1 please' });
  assert.deepStrictEqual(grant.map((e) => e.event), ['authorized', 'execution_failed']);
  assert.strictEqual(grant[0].evidence.instruction, 'Approve and post run r1 please');
  assert.strictEqual(grant[1].executed_by, 'ai-team:claude');
  for (const e of [...inApp, ...email, ...grant]) assert.doesNotThrow(() => AZ.buildEvent(e));
  assert.deepStrictEqual(AZ.runApprovalEvents({ run, approval: { channel: 'unknown' }, outcome: 'posted' }), []);
});

check('dispatcher: unknown scope, non-executable action and tier-3 by reply are refused before anything executes', async () => {
  await assert.rejects(AZ.executeAuthorized({}, { scope: 'payments', items: [] }), /no action adapter/);
  await assert.rejects(AZ.executeAuthorized({}, { scope: 'accounting_runs', sensitivity_tier: 3, items: [{ run_id: 'r' }] }, { channel: 'email' }), /tier-3/);
});

check('dispatcher: an authorized conversion request executes through its module and records authorized + executed / failed per item', async () => {
  const db = fakeDb();
  const calls = [];
  const rpc = async (name, a) => { calls.push([name, a.p_object_id]); if (a && a.p_object_id === 'o2') throw new Error('not proposed'); return {}; };
  const auth = { id: 'a1', scope: 'conversion_objects', requested_by: 'ai-team:claude', authorized_by_user_id: 'u', authorized_by_email: 'owner@x', evidence: { internet_message_id: 'm1' },
    items: [{ object_type: 'adjustment', object_id: 'o1', fingerprint: 'f1', batch_id: 'b1' }, { object_type: 'adjustment', object_id: 'o2', fingerprint: 'f2', batch_id: 'b1' }] };
  const out = await AZ.executeAuthorized({ supabase: db, rpc, operate: async () => ({ stage: 'ok' }) }, auth, { channel: 'email' });
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'conversion_decide_object_delegated').map((c) => c[1]), ['o1', 'o2'], 'executed only through the module function');
  const ev = db.inserted.map((e) => [e.event, e.target_id]);
  assert.deepStrictEqual(ev, [['authorized', 'o1'], ['authorized', 'o2'], ['executed', 'o1'], ['execution_failed', 'o2']]);
  assert.ok(db.inserted.every((e) => e.authorized_by_email === 'owner@x' && e.requested_by === 'ai-team:claude' && e.coordinator === 'ai-team:amanda'));
  assert.ok(db.inserted.filter((e) => /executed|failed/.test(e.event)).every((e) => e.executed_by === 'ai-team:claude'));
  assert.strictEqual(db.inserted[0].evidence.internet_message_id, 'm1', 'the original approval communication travels with the event');
});

check('Amanda follow-up: executed / failed events stay pending until she reports on them', async () => {
  const db = fakeDb({ rows: [
    { id: 'e1', event: 'executed', coordinator: 'ai-team:amanda', authority_kind: 'request', action_type: 'accounting_run', target_id: 'r1', executed_by: 'ai-team:kat', occurred_at: '1' },
    { id: 'e2', event: 'execution_failed', coordinator: 'ai-team:amanda', authority_kind: 'request', action_type: 'accounting_run', target_id: 'r2', executed_by: 'ai-team:kat', occurred_at: '2' },
    { id: 'e3', event: 'reported', coordinator: 'ai-team:amanda', related_event_id: 'e1', authority_kind: 'request', action_type: 'accounting_run', occurred_at: '3' }] });
  assert.deepStrictEqual((await AZ.pendingFollowUps(db)).map((e) => e.id), ['e2']);
  await AZ.recordReport(db, { event: (await AZ.pendingFollowUps(db))[0], note: 'Told Ed run r2 did not post' });
  assert.deepStrictEqual(await AZ.pendingFollowUps(db), []);
});

check('wiring: every existing path writes the shared ledger; Tessa dispatches through the service; migration declares the ledger, tiers and grant kinds', () => {
  const mr = read('lib/accounting/monthly_runs.js');
  assert.ok(/await ledger\('posted', \{ result \}\)/.test(mr) && /await ledger\('failed', \{ error: e\.message \}\)/.test(mr), 'approveAndPost records executed and failed (in-app, email, grant)');
  assert.ok(/accounting_run_fingerprint/.test(mr), 'the approved version is recorded');
  assert.ok(/AZ\.executeAuthorized\(ctx, auth, \{ channel: 'email' \}\)/.test(read('lib/ea/tessa_inbox.js')), 'Tessa uses the one dispatcher');
  assert.ok(/AZ\.recordEvents\(supabase, \(r\.items/.test(read('lib/accounting/owner_run_authorization.js')), 'run packages record requested + sent');
  assert.ok(/action_type: 'conversion_object'/.test(read('lib/onboarding/owner_authorization.js')), 'conversion requests record requested + sent');
  const api = read('api/accounting_runs.js');
  assert.ok(/action_type: 'execution_grant'/.test(api) && /event: 'revoked'/.test(api), 'grant issue and revoke are recorded');
  const sql = read('migrations/577_owner_authorization_service.sql');
  assert.ok(/CREATE TABLE IF NOT EXISTS authorization_events/.test(sql) && /trg_authorization_events_append_only/.test(sql));
  assert.ok(/tier-3 action needs the signed-in owner with step-up/.test(sql), 'tier 3 is never authorized by reply');
  assert.ok(/kind = 'time_limited' AND expires_at <= issued_at \+ interval '24 hours'/.test(sql) && /kind = 'standing'/.test(sql), 'grants: 24-hour time-limited unchanged; standing needs a policy');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
