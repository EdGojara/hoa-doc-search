// tests/test_manager_phase1.js  (Issue #27 Phase 1) — wake -> preflight -> objective state -> sleep
// In-memory supabase fake with the two unique rules migration 489 adds
// (manager_wakes.dedup_key; one OPEN objective per subject_key). No network,
// no model, no business action. Every write is logged so tests can prove what
// was (and was not) touched.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost.test';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
delete process.env.AMANDA_MANAGER;

const { emitWake, dedupKey } = require('../lib/manager/wake');
const { runSweep } = require('../lib/manager/sweep');
const S = require('../lib/manager/subjects');
const { buildShadow, sweepSchedule } = require('../lib/manager/shadow');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
let seq = 0; const uid = (p) => `${p}-${++seq}`;

function fakeDb(seed = {}) {
  const T = { objectives: [], objective_events: [], manager_wakes: [], ap_invoices: [], ap_intake_exceptions: [], board_packets: [], cron_runs: [], communities: [], ...JSON.parse(JSON.stringify(seed)) };
  const writes = [];
  const conflict = (t, row, selfId) => {
    if (t === 'manager_wakes') return T.manager_wakes.some((r) => r.dedup_key === row.dedup_key && r.id !== selfId);
    if (t === 'objectives' && row.subject_key && !['resolved', 'closed'].includes(row.status || 'open')) return T.objectives.some((r) => r.id !== selfId && r.subject_key === row.subject_key && OPEN.includes(r.status));
    return false;
  };
  function from(t) {
    const f = []; let order = null; let lim = null; let mode = 'select'; let payload = null; let opts = {}; let wantSingle = false;
    const rows = () => T[t] || (T[t] = []);
    const q = {
      select() { return q; },
      eq(c, v) { f.push((r) => r[c] === v); return q; },
      in(c, v) { f.push((r) => v.includes(r[c])); return q; },
      is(c, v) { f.push((r) => (r[c] ?? null) === v); return q; },
      not(c, op, v) { f.push((r) => (op === 'is' ? (r[c] ?? null) !== v : true)); return q; },
      lte(c, v) { f.push((r) => r[c] != null && String(r[c]) <= String(v)); return q; },
      gte(c, v) { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return q; },
      order(c, o = {}) { order = [c, o.ascending !== false]; return q; },
      limit(n) { lim = n; return q; },
      insert(r) { mode = 'insert'; payload = r; return q; },
      update(p) { mode = 'update'; payload = p; return q; },
      upsert(r, o) { mode = 'upsert'; payload = r; opts = o || {}; return q; },
      single() { wantSingle = true; return q; },
      maybeSingle() { wantSingle = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    function exec() {
      if (mode === 'insert' || mode === 'upsert') {
        const row = { id: uid(t), created_at: new Date().toISOString(), ...payload };
        if (t === 'objectives') { row.status = row.status || 'open'; if (row.needs_reasoning === undefined) row.needs_reasoning = false; }
        if (conflict(t, row)) {
          if (mode === 'upsert' && opts.ignoreDuplicates) return { data: null, error: null };
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        rows().push(row); writes.push({ t, op: 'insert', row });
        return { data: wantSingle ? { id: row.id } : [row], error: null };
      }
      let out = rows().filter((r) => f.every((p) => p(r)));
      if (mode === 'update') {
        for (const r of out) {
          const next = { ...r, ...payload };
          if (conflict(t, next, r.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(r, payload); writes.push({ t, op: 'update', id: r.id, patch: payload });
        }
        return { data: wantSingle ? out[0] || null : out, error: null };
      }
      if (order) { const [c, asc] = order; out = [...out].sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1)); }
      if (lim != null) out = out.slice(0, lim);
      out = out.map((r) => ({ ...r }));
      return { data: wantSingle ? out[0] || null : out, error: null };
    }
    return q;
  }
  return { from, T, writes };
}

const inv = (o = {}) => ({ id: uid('inv'), community_id: 'C1', vendor_id: 'V1', vendor_invoice_number: 'A-1', total_cents: 12500, status: 'awaiting_approval', dedup_status: 'unique', needs_review: false, classification_reason: null, ...o });
const exc = (o = {}) => ({ id: uid('exc'), community_id: null, reason: 'no_community', status: 'pending', vendor_name: 'Lake Pro', invoice_number: '262093', total_cents: 118522, notes: 'association not matched', suggested_vendor_id: null, ...o });
const wakeFor = (db, kind, row, state) => emitWake(db, { kind, sourceTable: kind === 'ap_invoice' ? 'ap_invoices' : 'ap_intake_exceptions', sourceId: row.id, communityId: row.community_id, wakeReason: kind, state: state || { status: row.status, needs_review: row.needs_review, reason: row.reason } });
const aiLoaded = () => Object.keys(require.cache).filter((k) => /[\\/](lib[\\/]ai[\\/](anthropic|router|model_client)|node_modules[\\/](openai|@anthropic-ai))[\\/.]/.test(k));
const NOW = Date.parse('2026-10-05T14:00:00Z'); // a Monday, 9am Central

check('no-op event: a routine bill wakes, the sweep classifies it EXECUTE (classification only) and makes 0 model calls; no objective', async () => {
  const before = aiLoaded().length;
  const i = inv(); const db = fakeDb({ ap_invoices: [i] });
  assert.ok((await wakeFor(db, 'ap_invoice', i)).emitted);
  const s = await runSweep({ supabase: db, now: NOW, env: {} });
  assert.strictEqual(s.model_calls, 0); assert.strictEqual(s.actions_executed, 0);
  assert.strictEqual(s.execute_candidates, 1);
  assert.strictEqual(db.T.objectives.length, 0, 'routine work does not become an Amanda item');
  assert.strictEqual(db.T.manager_wakes[0].status, 'consumed'); assert.strictEqual(db.T.manager_wakes[0].outcome, 'execute_candidate');
  assert.strictEqual(aiLoaded().length, before, 'no model client was loaded');
});

check('no-op sweep: empty state -> 0 candidates, 0 model calls, 0 writes (immediate sleep)', async () => {
  const db = fakeDb();
  const s = await runSweep({ supabase: db, now: NOW, env: {} });
  assert.strictEqual(s.candidates, 0); assert.strictEqual(s.model_calls, 0);
  assert.strictEqual(db.writes.length, 0);
});

check('duplicate AP event does not duplicate Amanda work (one wake row, one objective)', async () => {
  const i = inv({ needs_review: true, classification_reason: 'new payee' }); const db = fakeDb({ ap_invoices: [i] });
  await wakeFor(db, 'ap_invoice', i); await wakeFor(db, 'ap_invoice', i);
  assert.strictEqual(db.T.manager_wakes.length, 1, 'same event at the same state is one wake');
  await wakeFor(db, 'ap_invoice', i, { status: 'awaiting_approval', needs_review: true, outcome: 'loaded-again' });
  assert.strictEqual(db.T.manager_wakes.length, 2, 'a different state is a different wake');
  const s = await runSweep({ supabase: db, now: NOW, env: {} });
  assert.strictEqual(db.T.objectives.length, 1, 'still one objective for the bill');
  assert.strictEqual(db.T.objectives[0].autonomy_class, 'REVIEW'); assert.strictEqual(db.T.objectives[0].subject_key, `ap_invoice:${i.id}`);
  assert.strictEqual(db.T.objective_events.length, 1, 'one opened event, no echo from the second wake');
  assert.deepStrictEqual(db.T.manager_wakes.map((w) => w.outcome).sort(), ['review', 'unchanged']);
  assert.strictEqual(s.model_calls, 0);
});

check('unchanged sweep does not re-advance or log noise', async () => {
  const i = inv({ status: 'on_hold', dedup_status: 'suspected_duplicate' }); const e = exc();
  const db = fakeDb({ ap_invoices: [i], ap_intake_exceptions: [e], board_packets: [{ id: 'bp1', community_id: 'C1', period_label: 'October 2026', meeting_date: '2026-10-07', status: 'draft' }] });
  await wakeFor(db, 'ap_invoice', i); await wakeFor(db, 'ap_exception', e);
  await runSweep({ supabase: db, now: NOW, env: {} });
  const n = db.writes.filter((w) => w.t !== 'manager_wakes').length;
  assert.ok(n > 0);
  const s2 = await runSweep({ supabase: db, now: NOW + 3600000, env: {} });
  const s3 = await runSweep({ supabase: db, now: NOW + 7200000, env: {} });
  assert.strictEqual(db.writes.filter((w) => w.t !== 'manager_wakes').length, n, 'second and third sweeps wrote nothing');
  assert.strictEqual(s2.created + s2.updated + s2.resolved, 0); assert.strictEqual(s3.created + s3.updated + s3.resolved, 0);
  assert.ok(s2.unchanged >= 3);
});

check('AP exception becomes the expected deterministic state: missing piece -> BLOCK with dependency; unreadable -> REVIEW; duplicate hold -> REVIEW high', async () => {
  const e1 = exc(); const e2 = exc({ reason: 'unreadable_attachment', notes: 'HEIC photo; ask for a PDF' }); const i = inv({ status: 'on_hold', dedup_status: 'suspected_duplicate' });
  const db = fakeDb({ ap_intake_exceptions: [e1, e2], ap_invoices: [i] });
  for (const [k, r] of [['ap_exception', e1], ['ap_exception', e2], ['ap_invoice', i]]) await wakeFor(db, k, r);
  await runSweep({ supabase: db, now: NOW, env: {} });
  const by = (id) => db.T.objectives.find((o) => o.subject_refs && o.subject_refs.id === id);
  const b = by(e1.id);
  assert.strictEqual(b.autonomy_class, 'BLOCK'); assert.match(b.blocked_reason, /community/);
  assert.deepStrictEqual(b.depends_on, [{ table: 'ap_intake_exceptions', id: e1.id, condition: 'not_pending' }]);
  assert.strictEqual(b.accountable_persona, 'amanda'); assert.strictEqual(b.owner_kind, 'workflow'); assert.strictEqual(b.owner_key, 'ap.intake'); assert.strictEqual(b.domain, 'ap'); assert.strictEqual(b.needs_reasoning, false);
  assert.strictEqual(by(e2.id).autonomy_class, 'REVIEW'); assert.match(by(e2.id).next_action, /HEIC/);
  assert.strictEqual(by(i.id).autonomy_class, 'REVIEW'); assert.strictEqual(by(i.id).priority, 'high');
});

check('a BLOCKED dependency becoming satisfied wakes the objective exactly once', async () => {
  const e = exc(); const db = fakeDb({ ap_intake_exceptions: [e] });
  await wakeFor(db, 'ap_exception', e); await runSweep({ supabase: db, now: NOW, env: {} });
  const o = db.T.objectives[0]; assert.strictEqual(o.autonomy_class, 'BLOCK');
  let s = await runSweep({ supabase: db, now: NOW + 60000, env: {} });
  assert.strictEqual(s.unblocked, 0, 'still pending: stays blocked, no event');
  db.T.ap_intake_exceptions[0].status = 'resolved';
  s = await runSweep({ supabase: db, now: NOW + 120000, env: {} });
  assert.strictEqual(s.unblocked, 1);
  assert.strictEqual(o.status, 'resolved'); assert.match(o.closed_reason, /resolved/);
  const closeEvents = db.T.objective_events.filter((x) => x.objective_id === o.id && x.kind === 'closed');
  assert.strictEqual(closeEvents.length, 1); assert.match(closeEvents[0].summary, /Dependency satisfied/);
  const n = db.T.objective_events.length;
  s = await runSweep({ supabase: db, now: NOW + 180000, env: {} });
  assert.strictEqual(db.T.objective_events.length, n, 'no second wake'); assert.strictEqual(s.unblocked, 0);
});

check('board packet near its meeting -> REVIEW (high inside 3 days); finalizing it resolves on the next sweep', async () => {
  const db = fakeDb({ board_packets: [{ id: 'bp1', community_id: 'C1', period_label: 'October 2026', meeting_date: '2026-10-07', status: 'draft' }, { id: 'bp2', community_id: 'C1', period_label: 'Far', meeting_date: '2026-11-30', status: 'draft' }] });
  await runSweep({ supabase: db, now: NOW, env: {} });
  assert.strictEqual(db.T.objectives.length, 1, 'only the packet inside the lead time');
  const o = db.T.objectives[0];
  assert.strictEqual(o.autonomy_class, 'REVIEW'); assert.strictEqual(o.priority, 'high'); assert.strictEqual(o.domain, 'board');
  assert.strictEqual(o.next_action_due, '2026-10-07T05:00:00.000Z', 'due at midnight Central (CDT) as a full instant');
  db.T.board_packets[0].status = 'final';
  await runSweep({ supabase: db, now: NOW + 3600000, env: {} });
  assert.strictEqual(o.status, 'resolved');
});

check('due rule: an objective opened elsewhere gets ONE note when it goes overdue, none on repeat', async () => {
  const db = fakeDb({ objectives: [{ id: 'o1', title: 'Call back homeowner', status: 'open', next_action: 'Call back about the fence', next_action_due: '2026-10-05T12:00:00.000Z', last_activity_at: '2026-10-01T00:00:00Z', subject_key: null, state_hash: null }] });
  let s = await runSweep({ supabase: db, now: NOW, env: {} });
  assert.strictEqual(s.due_marked, 1); assert.strictEqual(db.T.objective_events.length, 1); assert.match(db.T.objective_events[0].summary, /Overdue/);
  s = await runSweep({ supabase: db, now: NOW + 3600000, env: {} });
  assert.strictEqual(s.due_marked, 0); assert.strictEqual(db.T.objective_events.length, 1);
  assert.strictEqual(db.T.objectives[0].status, 'open', 'status untouched: Phase 1 never acts on work it did not open');
});

check('sweep run is bounded (MANAGER_MAX_CANDIDATES) and leaves the rest for the next sweep', async () => {
  const bills = Array.from({ length: 60 }, () => inv({ needs_review: true }));
  const db = fakeDb({ ap_invoices: bills });
  for (const b of bills) await wakeFor(db, 'ap_invoice', b);
  const s = await runSweep({ supabase: db, now: NOW, env: { MANAGER_MAX_CANDIDATES: '10' } });
  assert.strictEqual(s.candidates, 10); assert.ok(s.bounded); assert.ok(s.deferred >= 1);
  assert.strictEqual(db.T.manager_wakes.filter((w) => w.status === 'pending').length, 50);
  assert.strictEqual(db.T.objectives.length, 10);
});

check('no autonomous action in Phase 1: writes touch only objectives / objective_events / manager_wakes; no model, mail or AP-mutation code is reachable', async () => {
  const i = inv({ needs_review: true }); const e = exc();
  const db = fakeDb({ ap_invoices: [i], ap_intake_exceptions: [e], board_packets: [{ id: 'bp1', community_id: 'C1', period_label: 'Oct', meeting_date: '2026-10-06', status: 'in_review' }] });
  await wakeFor(db, 'ap_invoice', i); await wakeFor(db, 'ap_exception', e);
  const snap = JSON.stringify([db.T.ap_invoices, db.T.ap_intake_exceptions, db.T.board_packets]);
  await runSweep({ supabase: db, now: NOW, env: {} });
  assert.deepStrictEqual([...new Set(db.writes.map((w) => w.t))].sort(), ['manager_wakes', 'objective_events', 'objectives']);
  assert.strictEqual(JSON.stringify([db.T.ap_invoices, db.T.ap_intake_exceptions, db.T.board_packets]), snap, 'source records untouched');
  const dir = path.join(__dirname, '..', 'lib', 'manager');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of reqs) assert.ok(!/ai\/|anthropic|openai|graph_send|notifications|\/ap\/|sms|resend|email/.test(r), `${f} requires ${r}`);
    assert.ok(!/messages\.create|sendAs|sendEmail|textOwner/.test(src), `${f} calls a model or sends`);
  }
});

check('kill switch: AMANDA_MANAGER=off stops wakes and the sweep', async () => {
  const i = inv(); const db = fakeDb({ ap_invoices: [i] });
  process.env.AMANDA_MANAGER = 'off';
  try { assert.strictEqual((await wakeFor(db, 'ap_invoice', i)).skipped, 'disabled'); } finally { delete process.env.AMANDA_MANAGER; }
  const s = await runSweep({ supabase: db, now: NOW, env: { AMANDA_MANAGER: 'off' } });
  assert.strictEqual(s.fired, false); assert.strictEqual(db.writes.length, 0);
});

check('wake failure never breaks the caller: missing table is a quiet skip; a real failure is captured to system_errors; nothing throws', async () => {
  const caps = [];
  const missing = { from: () => ({ upsert: async () => ({ error: { code: '42P01', message: 'relation "manager_wakes" does not exist' } }) }) };
  const broken = { from: () => ({ upsert: async () => { throw new Error('socket hang up'); } }) };
  const r1 = await emitWake(missing, { kind: 'ap_invoice', sourceId: 'x', state: {} }, { captureError: async (e) => caps.push(e) });
  assert.strictEqual(r1.skipped, 'not_deployed'); assert.strictEqual(caps.length, 0);
  const r2 = await emitWake(broken, { kind: 'ap_invoice', sourceId: 'x', state: {} }, { captureError: async (e) => caps.push(e) });
  assert.strictEqual(r2.ok, false); assert.strictEqual(caps.length, 1); assert.match(caps[0].message, /wake not recorded/);
  assert.strictEqual(dedupKey('ap_invoice', 'x', { a: 1, b: 2 }), dedupKey('ap_invoice', 'x', { b: 2, a: 1 }), 'dedup key is order-independent');
});

check('AP chokepoints emit AFTER their own write and keep their result (wired, source check)', () => {
  const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const intake = lf(path.join(__dirname, '..', 'lib', 'ap', 'intake.js'));
  const m = intake.match(/const result = \{ outcome: suspected[\s\S]*?await emitWake\(supabase, \{ kind: 'ap_invoice'[\s\S]*?\n  return result;\n\}/);
  assert.ok(m, 'commitInvoice builds its result, emits, then returns the same result');
  const ex = lf(path.join(__dirname, '..', 'lib', 'ap', 'intake_exceptions.js'));
  assert.ok(/insert\(row\)\.select\('id'\)\.single\(\);[\s\S]*?await emitWake\(supabase, \{ kind: 'ap_exception'[\s\S]*?return \{ ok: true, id: data\.id \};/.test(ex), 'recordException emits only after a NEW insert');
});

check('scheduler: manager_sweep is OFF unless allow-listed; two business-day slots by default; never weekends or overnight', () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const { Scheduler, jobGate, managerSweepHours, centralParts } = require('../lib/scheduler');
  const reg = (allow) => { const prev = process.env.SCHEDULER_ENABLED; if (allow == null) delete process.env.SCHEDULER_ENABLED; else process.env.SCHEDULER_ENABLED = allow; const sc = new Scheduler({ supabase: {}, logger: { log() {}, warn() {} } }); sc.register({ name: 'manager_sweep', targetHours: managerSweepHours(), businessDaysOnly: true, run: async () => ({}) }); if (prev == null) delete process.env.SCHEDULER_ENABLED; else process.env.SCHEDULER_ENABLED = prev; return sc.jobs; };
  assert.strictEqual(reg(null).length, 0, 'unset allow-list: not registered, no sweep');
  assert.strictEqual(reg('cure_lapse').length, 0);
  assert.strictEqual(reg('cure_lapse,manager_sweep').length, 1);
  assert.deepStrictEqual(managerSweepHours({}), [8, 15], 'startup default: two sweeps');
  assert.deepStrictEqual(managerSweepHours({ MANAGER_SWEEP_HOURS: '8,12,15' }), [8, 12, 15], 'a third is opt-in');
  assert.deepStrictEqual(managerSweepHours({ MANAGER_SWEEP_HOURS: '2,23' }), [8, 15], 'overnight hours are refused');
  const job = { targetHours: [8, 15], businessDaysOnly: true };
  const at = (iso) => jobGate(job, centralParts(new Date(iso)), new Date(iso));
  assert.ok(at('2026-10-05T12:30:00Z').skip, 'Mon 7:30am Central: before the first slot');
  const m = at('2026-10-05T14:10:00Z'); assert.ok(!m.skip); assert.strictEqual(m.lookbackIso, '2026-10-05T13:00:00.000Z', 'morning slot starts 8am Central');
  assert.strictEqual(at('2026-10-05T21:00:00Z').lookbackIso, '2026-10-05T20:00:00.000Z', 'afternoon slot starts 3pm Central');
  assert.ok(at('2026-10-04T15:00:00Z').skip, 'Sunday: no sweep');
  assert.ok(at('2026-10-10T15:00:00Z').skip, 'Saturday: no sweep');
  // existing job modes are unchanged
  assert.ok(jobGate({ targetHour: 7 }, centralParts(new Date('2026-10-05T11:00:00Z'))).skip, 'daily job before its hour waits');
  assert.strictEqual(jobGate({ minIntervalMin: 15 }, centralParts(new Date('2026-10-05T11:00:00Z')), new Date('2026-10-05T11:00:00Z')).pollMode, true);
});

check('shadow view: needs-people / blocked lists, routine count, pending wakes, schedule; a failed source is reported, not zero', async () => {
  const i = inv({ needs_review: true }); const e = exc(); const ok = inv();
  const db = fakeDb({ ap_invoices: [i, ok], ap_intake_exceptions: [e] });
  for (const [k, r] of [['ap_invoice', i], ['ap_exception', e], ['ap_invoice', ok]]) await wakeFor(db, k, r);
  await runSweep({ supabase: db, now: Date.now(), env: {} });
  const sh = await buildShadow(db, { env: { SCHEDULER_ENABLED: 'manager_sweep' } });
  assert.strictEqual(sh.available, true); assert.strictEqual(sh.model_calls, 0);
  assert.strictEqual(sh.needs_people.length, 1); assert.strictEqual(sh.blocked.length, 1);
  assert.strictEqual(sh.last_24h.routine_would_continue, 1); assert.strictEqual(sh.pending_wakes, 0);
  assert.deepStrictEqual(sh.schedule, { hours: [8, 15], business_days_only: true, scheduled: true });
  assert.strictEqual(sweepSchedule({}).scheduled, false);
  const bad = { from: () => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q, gte: () => q, order: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'relation "manager_wakes" does not exist' } }) }; return q; } };
  const sb = await buildShadow(bad, {});
  assert.strictEqual(sb.available, false); assert.ok(sb.section_errors.objectives); assert.strictEqual(sb.pending_wakes, null, 'unknown, not zero');
});

check('subject rules are pure and invent no thresholds: priority only from facts on the row', () => {
  assert.strictEqual(S.apInvoice(inv({ total_cents: 99999999 })).action, 'clear', 'a large clean bill is still routine (no invented dollar cutoff)');
  assert.strictEqual(S.apInvoice(inv({ status: 'paid' })).outcome, 'resolved');
  assert.strictEqual(S.apException(exc({ status: 'dismissed' })).action, 'clear');
  assert.strictEqual(S.boardPacket({ id: 'b', status: 'draft', meeting_date: null }, NOW).action, 'clear', 'no meeting date: nothing to infer');
  assert.strictEqual(S.dueCondition('2026-10-05T13:00:00Z', NOW), 'overdue'); assert.strictEqual(S.dueCondition('2026-10-06T10:00:00Z', NOW), 'due_soon'); assert.strictEqual(S.dueCondition('2026-10-09T10:00:00Z', NOW), null);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass += 1; console.log(`  ✓ ${n}`); } catch (e) { fail += 1; console.log(`  ✗ ${n}\n    ${String(e.stack).split('\n').slice(0, 4).join('\n    ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
