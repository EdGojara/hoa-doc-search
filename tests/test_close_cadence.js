// Amanda's close cadence (lib/close/cadence.js): deadlines from the board meeting, one owned
// task per BLOCK, tasks closed when their evidence clears, the packet built as a draft only
// after its months close, Ed's queue sources, and the things it must never do.
// No network: Supabase is an in-memory fake.
'use strict';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

// ---- a small in-memory Supabase ------------------------------------------------------
function fakeDb(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  const writes = [];
  function qb(table) {
    const rows = () => (db[table] = db[table] || []);
    const filters = []; let op = 'select'; let payload = null; let lim = null; let ord = null; let single = null;
    const api = {
      select() { return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
      gte(k, v) { filters.push((r) => r[k] != null && String(r[k]) >= String(v)); return api; },
      lte(k, v) { filters.push((r) => r[k] != null && String(r[k]) <= String(v)); return api; },
      lt(k, v) { filters.push((r) => r[k] != null && String(r[k]) < String(v)); return api; },
      like(k, pat) { const re = new RegExp(`^${pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`); filters.push((r) => re.test(String(r[k] || ''))); return api; },
      not(k, o, v) { const vs = String(v).replace(/[()]/g, '').split(','); filters.push((r) => (o === 'in' ? !vs.includes(r[k]) : r[k] !== null)); return api; },
      order(k, o) { ord = { k, asc: !o || o.ascending !== false }; return api; },
      limit(n) { lim = n; return api; },
      maybeSingle() { single = 'maybe'; return api; },
      single() { single = 'one'; return api; },
      insert(p) { op = 'insert'; payload = p; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (op === 'insert') { const r = { id: `${table}-${rows().length + 1}`, ...payload }; rows().push(r); writes.push({ table, op, row: r }); return { data: single ? r : [r], error: null }; }
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { out.forEach((r) => Object.assign(r, payload)); writes.push({ table, op, payload, n: out.length }); return { data: out, error: null }; }
      if (ord) out = [...out].sort((a, b) => (String(a[ord.k]) < String(b[ord.k]) ? -1 : 1) * (ord.asc ? 1 : -1));
      if (lim != null) out = out.slice(0, lim);
      if (single) return { data: out[0] || null, error: single === 'one' && !out[0] ? { message: 'no rows' } : null };
      return { data: out, error: null };
    }
    return api;
  }
  return { from: qb, rpc: async () => ({ data: null, error: null }), db, writes };
}

const K = require('../lib/close/cadence');
const own = require('../lib/close/ownership');
const svc = require('../lib/close/service');
const OPS = require('../lib/mission_control/operations');

console.log('ownership: one map for every surface');
{
  check('cash is Kat', own.controlOwner('CASH-01') === 'Kat' && own.controlOwner('CASH-04') === 'Kat');
  check('AP, CUT-01, DATA-04 and DATA-05 are Emma', ['AP-01', 'AP-02', 'CUT-01', 'DATA-04', 'DATA-05'].every((c) => own.controlOwner(c) === 'Emma'));
  check('GL, homeowners, recognition, CUT-02/03, DATA-03 are Kat', ['GL-01', 'AR-02', 'REC-01', 'CUT-02', 'CUT-03', 'DATA-03', 'IF-01'].every((c) => own.controlOwner(c) === 'Kat'));
  check('a missing statement stays Ed\'s (only Ed can obtain it)', own.controlOwner('DATA-02') === 'Ed');
  const t = OPS.closeTasks({ id: 'c', name: 'C' }, { id: 'p', period_start: '2026-09-01' }, { id: 'r', results: [{ code: 'AP-02', status: 'WARNING', label: 'Held', explanation: 'x' }] }, null);
  check('Mission Control reads the same map (AP-02 is Emma\'s there too)', t[0] && t[0].owner === 'Emma');
}

console.log('deadlines work back from the meeting in business days');
{
  check('business days skip the weekend', K.addBusinessDays('2026-11-16', -1) === '2026-11-13' && K.addBusinessDays('2026-11-13', 1) === '2026-11-16');
  const d = K.meetingDeadlines('2026-11-19');
  check('Thu Nov 19 meeting: inputs Nov 10, close Nov 12, draft Nov 16, approval Nov 18', d.collect === '2026-11-10' && d.close === '2026-11-12' && d.review_draft === '2026-11-16' && d.approve === '2026-11-18', JSON.stringify(d));
  const o = K.meetingDeadlines('2026-11-19', { collect: -10 });
  check('a community\'s own offsets override the default', o.collect === '2026-11-05' && o.close === '2026-11-12');
  check('urgency: overdue is critical, within 3 days high', K.urgencyFor('2026-10-14', '2026-10-15') === 'critical' && K.urgencyFor('2026-10-17', '2026-10-15') === 'high' && K.urgencyFor('2026-11-17', '2026-10-15') === 'normal');
}

const C = { id: 'cg', name: 'Canyon Gate' };
const R = (code, status, extra = {}) => ({ code, status, label: `${code} label`, explanation: `${code} why`, action: `${code} action`, evidence_hash: `h-${code}`, ...extra });
const aug = (results, extra = {}) => ({ id: 'p8', period_start: '2026-08-01', period_end: '2026-08-31', closed: false, review: { results, run_id: 'r8' }, overrides: new Set(), ...extra });
const sep = (results, extra = {}) => ({ id: 'p9', period_start: '2026-09-01', period_end: '2026-09-30', closed: false, review: { results, run_id: 'r9' }, overrides: new Set(), ...extra });
const oct = (results, extra = {}) => ({ id: 'p10', period_start: '2026-10-01', period_end: '2026-10-31', closed: false, review: { results, run_id: 'r10' }, overrides: new Set(), ...extra });

console.log('plan: no meeting on file');
{
  const p = K.planCommunity({ community: C, today: '2026-10-15', periods: [aug([R('CASH-01', 'BLOCK'), R('AP-02', 'WARNING'), R('GL-01', 'PASS')]), sep([R('AP-01', 'BLOCK'), R('CUT-01', 'BLOCK'), R('DATA-02', 'BLOCK')])], meeting: null });
  const by = Object.fromEntries(p.tasks.map((t) => [t.source_ref, t]));
  check('each BLOCK is one task under Mission Control\'s own key', !!by['close:cg:2026-08:CASH-01'] && !!by['close:cg:2026-09:AP-01'] && !!by['close:cg:2026-09:CUT-01']);
  check('owners follow the map (CASH Kat, AP-01 Emma, CUT-01 Emma, DATA-02 Ed)', by['close:cg:2026-08:CASH-01'].assigned_to === 'Kat' && by['close:cg:2026-09:AP-01'].assigned_to === 'Emma' && by['close:cg:2026-09:CUT-01'].assigned_to === 'Emma' && by['close:cg:2026-09:DATA-02'].assigned_to === 'Ed');
  check('warnings and passes are not tasks', !by['close:cg:2026-08:AP-02'] && !by['close:cg:2026-08:GL-01']);
  check('without a meeting no deadline is invented', p.tasks.every((t) => t.sla_due_at === null));
  check('Amanda gets the meeting date', by['meeting:cg:next'] && by['meeting:cg:next'].assigned_to === 'Amanda');
  check('each open month is Amanda\'s coordination task naming the blockers and owners', by['close:cg:2026-09'].assigned_to === 'Amanda' && /AP-01 \(Emma\)/.test(by['close:cg:2026-09'].next_step));
  check('no packet without a meeting', !p.tasks.some((t) => t.source_ref.startsWith('package:')) && p.packet_action === null);
}

console.log('plan: a meeting sets the deadlines');
{
  const meeting = { id: 'm1', meeting_date: '2026-11-19', meeting_type: 'regular' };
  const p = K.planCommunity({ community: C, today: '2026-10-15', meeting, periods: [aug([R('CASH-01', 'BLOCK')]), sep([R('AR-02', 'BLOCK')]), oct([R('DATA-04', 'BLOCK')])] });
  const by = Object.fromEntries(p.tasks.map((t) => [t.source_ref, t]));
  check('the packet reports months through the prior month end (Aug, Sep, Oct)', p.cutoff === '2026-10-31' && p.covered_months.join() === '2026-08,2026-09,2026-10');
  check('blocker tasks are due by the inputs deadline (5:00 PM Central)', by['close:cg:2026-08:CASH-01'].due_date === '2026-11-10' && by['close:cg:2026-08:CASH-01'].sla_due_at === '2026-11-10T23:00:00.000Z', by['close:cg:2026-08:CASH-01'].sla_due_at);
  check('months are due closed by the close deadline', by['close:cg:2026-09'].due_date === '2026-11-12' && /by Nov 12, 2026/.test(by['close:cg:2026-09'].title));
  check('the packet task waits on the close and is due at the approval deadline', by['package:cg:2026-10'] && by['package:cg:2026-10'].due_date === '2026-11-18' && /Waits on the close of August, September and October/.test(by['package:cg:2026-10'].next_step));
  check('no packet is built while months are open', p.packet_action === null);
  check('no meeting-date task once a meeting is on file', !by['meeting:cg:next']);
  const early = K.planCommunity({ community: C, today: '2026-10-15', meeting: { meeting_date: '2026-10-22' }, periods: [aug([]), sep([]), oct([R('DATA-04', 'BLOCK')])] });
  const eb = Object.fromEntries(early.tasks.map((t) => [t.source_ref, t]));
  check('a month after the cutoff has no meeting deadline', eb['close:cg:2026-10:DATA-04'].sla_due_at === null && eb['close:cg:2026-09'].due_date === '2026-10-15');
  check('a deadline already passed is critical', eb['package:cg:2026-09'].due_date === '2026-10-21' && K.urgencyFor(eb['close:cg:2026-09'].due_date, '2026-10-16') === 'critical');
  check('a clear earliest month says Ed approves the close', /Ed approves and closes/.test(eb['close:cg:2026-08'].next_step) && eb['close:cg:2026-08'].ready_to_close === true);
  check('a clear later month waits for the earlier one (months close in order)', /closes after August/.test(eb['close:cg:2026-09'].next_step) && eb['close:cg:2026-09'].ready_to_close === false);
}

console.log('plan: overrides, closed months, unreadable reviews');
{
  const p = K.planCommunity({ community: C, today: '2026-10-15', meeting: null, periods: [
    aug([R('CASH-01', 'BLOCK'), R('AR-02', 'BLOCK')], { overrides: new Set(['AR-02|h-AR-02']) }),
    sep([R('AP-01', 'BLOCK')], { overrides: new Set(['AP-01|old-hash']) }),
    oct([], { closed: true }),
  ] });
  const refs = p.tasks.map((t) => t.source_ref);
  check('a BLOCK the owner overrode on the same evidence is not a task', !refs.includes('close:cg:2026-08:AR-02'));
  check('an override bound to different evidence no longer applies', refs.includes('close:cg:2026-09:AP-01'));
  check('a closed month has no tasks', !refs.some((r) => r.includes('2026-10')));
  const bad = K.planCommunity({ community: C, today: '2026-10-15', meeting: null, periods: [aug(null, { review: { error: 'boom' } })] });
  check('an unreadable review clears nothing and says so', bad.tasks.filter((t) => t.kind === 'block').length === 0 && /could not be read/.test(bad.notes[0]) && /could not be read/.test(bad.tasks.find((t) => t.kind === 'month').next_step));
}

console.log('plan: the packet');
{
  const meeting = { meeting_date: '2026-11-19' };
  const closed = [aug([], { closed: true }), sep([], { closed: true }), oct([], { closed: true })];
  const a = K.planCommunity({ community: C, today: '2026-11-05', meeting, periods: closed, packet: null });
  check('every reported month closed and no packet: create + assemble as a DRAFT', a.packet_action === 'create_and_assemble' && /DRAFT/.test(a.tasks.find((t) => t.kind === 'packet').next_step));
  const b = K.planCommunity({ community: C, today: '2026-11-05', meeting, periods: closed, packet: { id: 'k', status: 'draft' }, packet_ready: { ok: true, reasons: [] } });
  check('a ready draft asks for Ed\'s approval and builds nothing new', b.packet_action === null && /Ed reviews and approves distribution/.test(b.tasks.find((t) => t.kind === 'packet').next_step));
  const c = K.planCommunity({ community: C, today: '2026-11-05', meeting, periods: closed, packet: { id: 'k', status: 'draft' }, packet_ready: { ok: false, reasons: ['October 2026: snapshot pulled open.'] } });
  check('a draft that fails the gate says why', /snapshot pulled open/.test(c.tasks.find((t) => t.kind === 'packet').next_step));
  const notOver = K.planCommunity({ community: C, today: '2026-10-15', meeting, periods: [aug([], { closed: true }), sep([], { closed: true }), oct(null, { review: undefined, not_ended: true })], packet: null });
  check('a reported month not over yet keeps the packet waiting (never built with October open)', notOver.packet_action === null && /Waits on the close of October/.test(notOver.tasks.find((t) => t.kind === 'packet').next_step));
  check('the unfinished month is tracked to its deadline, not reported as unreadable', /month ends Oct 31, 2026/.test(notOver.tasks.find((t) => t.source_ref === 'close:cg:2026-10').next_step) && !notOver.notes.length);
  const noPeriod = K.planCommunity({ community: C, today: '2026-11-05', meeting, periods: [aug([], { closed: true }), sep([], { closed: true })], packet: null });
  check('no accounting period for the cutoff month: no packet, and it says so', noPeriod.packet_action === null && /No accounting period is on file for October 2026/.test(noPeriod.tasks.find((t) => t.kind === 'packet').next_step));
  const d = K.planCommunity({ community: C, today: '2026-11-05', meeting, periods: closed, packet: { id: 'k', status: 'distributed' } });
  check('a distributed packet has no task', !d.tasks.some((t) => t.kind === 'packet'));
}

console.log('hand-made Canyon Gate tasks are adopted, never duplicated');
{
  const handmade = [
    { source_ref: 'cg-close-2026-08-09:ar02', title: 'CG AR-02: owner credits off by 50.00 (Aug and Sep)' },
    { source_ref: 'cg-close-2026-08-09:bank-recs', title: 'CG Aug/Sep close: 10 bank-rec runs awaiting owner approval' },
    { source_ref: 'cg-close-2026-08:data03-1410', title: 'CG 1410 Prepaid: 621.12 stale converted balance (DATA-03 Aug/Sep)' },
    { source_ref: 'cg-close-2026-09:missing-bills', title: 'CG missing September bills: Star 2 weeks, Gexa 4 accounts' },
    { source_ref: 'cg-close-2026-08-09:board-package', title: 'CG board reporting: next meeting date unknown, no packet beyond August' },
  ];
  const p = K.planCommunity({ community: C, today: '2026-10-15', meeting: null, handmade, periods: [
    aug([R('CASH-01', 'BLOCK'), R('AR-02', 'BLOCK'), R('DATA-03', 'BLOCK')]), sep([R('CASH-01', 'BLOCK'), R('AR-02', 'BLOCK'), R('AP-01', 'BLOCK'), R('CUT-01', 'BLOCK'), R('DATA-03', 'BLOCK')])] });
  const refs = p.tasks.map((t) => t.source_ref);
  const by = Object.fromEntries(p.adopted.map((a) => [a.source_ref, a.adopted_by]));
  check('bank recs (CASH-01) for both months are the hand-made bank-rec task', by['close:cg:2026-08:CASH-01'] === 'cg-close-2026-08-09:bank-recs' && by['close:cg:2026-09:CASH-01'] === 'cg-close-2026-08-09:bank-recs');
  check('AR-02 for both months is the hand-made ar02 task', by['close:cg:2026-08:AR-02'] === 'cg-close-2026-08-09:ar02' && by['close:cg:2026-09:AR-02'] === 'cg-close-2026-08-09:ar02');
  check('a month named in the title extends the ref (DATA-03 "Aug/Sep" covers September too)', by['close:cg:2026-08:DATA-03'] === 'cg-close-2026-08:data03-1410' && by['close:cg:2026-09:DATA-03'] === 'cg-close-2026-08:data03-1410');
  check('a hand-made task scoped to August only does not cover September', K.adoptingTask({ kind: 'block', control: 'DATA-03', period: '2026-09' }, [{ source_ref: 'cg-close-2026-08:data03-1410', title: 'CG 1410 Prepaid stale balance (DATA-03)' }]) === null);
  check('late bills (CUT-01 Sep) are the hand-made missing-bills task', by['close:cg:2026-09:CUT-01'] === 'cg-close-2026-09:missing-bills');
  check('the meeting date is the hand-made board-package task', by['meeting:cg:next'] === 'cg-close-2026-08-09:board-package' && !refs.includes('meeting:cg:next'));
  check('nothing covers Sep AP-01, so it is created', refs.includes('close:cg:2026-09:AP-01'));
  check('adopted items are not planned, so no adopted subject is ever duplicated', p.adopted.every((a) => !refs.includes(a.source_ref)));
  check('a hand-made task on another subject is not adopted by month alone', K.adoptingTask({ kind: 'block', control: 'AP-01', period: '2026-08' }, [{ source_ref: 'cg-close-2026-08:opening-ap', title: 'opening AP from conversion' }]) === null);
}

console.log('Kat\'s review is recorded only when something changed');
{
  const results = [R('CASH-01', 'BLOCK'), R('CUT-01', 'PASS'), R('CUT-02', 'PASS'), R('CUT-03', 'PASS'), R('IF-01', 'PASS')];
  const { ENGINE_VERSION } = require('../lib/close/controls');
  const last = { run_by: 'Kat (AI accountant)', engine_version: ENGINE_VERSION, fingerprint: 'f1', results };
  check('same books, same evidence: no new run', svc.needsNewReview(last, 'f1', results) === false);
  check('ledger fingerprint moved: new run', svc.needsNewReview(last, 'f2', results) === true);
  const approved = results.map((r) => (r.code === 'CASH-01' ? { ...r, status: 'PASS', evidence_hash: 'h2' } : r));
  check('a bank rec approved (evidence moved, ledger did not): new run', svc.needsNewReview(last, 'f1', approved) === true);
  check('no run yet: new run', svc.needsNewReview(null, 'f1', results) === true);
  check('latest run not Kat\'s cutoff review: new run', svc.needsNewReview({ ...last, run_by: 'egojara@bedrocktx.com' }, 'f1', results) === true);
  check('older engine: new run', svc.needsNewReview({ ...last, engine_version: 'close-a.1' }, 'f1', results) === true);
  check('the sweep records as Kat', /^Kat\b/.test(K.KAT_SWEEP.name));
}

(async () => {
  console.log('applying: create, update, leave alone, close what cleared');
  {
    const sb = fakeDb({ work_items: [
      { id: 'w1', source_type: 'agent', status: 'new', source_ref: 'close:cg:2026-08:CASH-01', title: 'Canyon Gate: August 2026 close: CASH-01 label', assigned_to: 'Kat', urgency: 'high', sla_due_at: null, next_step: 'CASH-01 action', why: 'CASH-01 why' },
      { id: 'w2', source_type: 'agent', status: 'new', source_ref: 'close:cg:2026-08:AR-02', title: 'old', assigned_to: 'Kat', urgency: 'high', sla_due_at: null, next_step: 'x', why: 'y' },
      { id: 'w3', source_type: 'agent', status: 'new', source_ref: 'close:cg:2026-08', title: 'stale title', assigned_to: 'Amanda', urgency: 'normal', sla_due_at: null, next_step: 'x', why: 'y' },
      { id: 'w4', source_type: 'manual', status: 'new', source_ref: 'close:cg:2026-07:GL-01', title: 'a person\'s task' },
      { id: 'w5', source_type: 'agent', status: 'new', source_ref: 'cg-close-2026-08-09:bank-recs', title: 'hand-made' },
    ] });
    const plan = K.planCommunity({ community: C, today: '2026-10-15', meeting: null, periods: [aug([R('CASH-01', 'BLOCK')])] });
    const calls = { up: [], res: [] };
    const deps = { upsertAgentTask: async (o) => { calls.up.push(o.source_ref); return { id: 'x', created: !sb.db.work_items.some((w) => w.source_ref === o.source_ref) }; }, resolveAgentTask: async (ref) => { calls.res.push(ref); return { resolved: 1 }; } };
    const r = await K.applyPlan(sb, plan, deps);
    check('an unchanged task is not touched (no event noise)', !calls.up.includes('close:cg:2026-08:CASH-01') && r.unchanged === 1, JSON.stringify(calls));
    check('a changed task is updated and a new one created', calls.up.includes('close:cg:2026-08') && calls.up.includes('meeting:cg:next') && r.updated === 1 && r.created === 1, JSON.stringify(r));
    check('a cleared BLOCK\'s task is closed by evidence', calls.res.includes('close:cg:2026-08:AR-02') && r.resolved === 1);
    check('a person\'s task and hand-made agent tasks are never closed', !calls.res.includes('close:cg:2026-07:GL-01') && !calls.res.includes('cg-close-2026-08-09:bank-recs'));
    check('hand-made tasks are never written at all', !sb.writes.some((w) => w.table === 'work_items'));
  }

  console.log('the run: dry run writes nothing; the packet is built as a draft only when due');
  {
    const closed = [aug([], { closed: true }), sep([], { closed: true })];
    const meeting = { id: 'm', meeting_date: '2026-10-28' };
    const mk = () => ({ community: C, today: '2026-10-15', meeting, periods: closed, packet: null, packet_ready: null });
    let assembled = 0, upserts = 0;
    const deps = { communities: async () => [C], loadState: async () => mk(), assemblePackage: async (a) => { assembled += 1; check('assembled for the meeting with its label', a.meeting_date === '2026-10-28' && a.period_label === 'October 2026 Board Meeting'); return { packet_id: 'pk', period_label: a.period_label, needs: [] }; },
      packetReadiness: async () => ({ ok: false, reasons: ['management report missing.'] }), upsertAgentTask: async () => { upserts += 1; return { id: 'x', created: true }; }, resolveAgentTask: async () => ({ resolved: 0 }) };
    const sb = fakeDb({ work_items: [] });
    const dry = await K.runCadence({ supabase: sb, dryRun: true, deps, env: {} });
    check('dry run: nothing assembled, no task written', assembled === 0 && upserts === 0 && sb.writes.length === 0 && dry.plans[0].packet_action === 'create_and_assemble' && dry.plans[0].would.create.length > 0);
    const live = await K.runCadence({ supabase: sb, deps, env: {} });
    check('live: the packet is created once and the task reflects the draft', assembled === 1 && live.packets_created === 1 && /not ready: management report missing/.test(live.plans[0].tasks.find((t) => t.kind === 'packet').next_step));
    const off = await K.runCadence({ supabase: sb, deps, env: { AMANDA_MANAGER: 'off' } });
    check('AMANDA_MANAGER=off stops it', off.fired === false);
    const boom = await K.runCadence({ supabase: sb, env: {}, deps: { ...deps, loadState: async () => { throw new Error('db down'); } } });
    check('a community failure is recorded, never a quiet success', boom.ok === false && boom.failed === 1 && /db down/.test(boom.errors[0].error));
  }

  console.log('next meeting: meetings first, else a saved agenda becomes the meeting record');
  {
    const sb = fakeDb({ communities: [{ id: 'cg', name: 'Canyon Gate', gl_cutover_date: '2026-08-01', board_package_config: null }], accounting_periods: [], period_closes: [], meetings: [],
      meeting_agendas: [{ id: 'a1', community_id: 'cg', meeting_date: '2026-11-19', meeting_type: 'regular', title: 'November Board Meeting' }], board_packets: [] });
    const dry = await K.loadCommunityState(sb, { id: 'cg' }, { today: '2026-10-15', dryRun: true });
    check('dry run reads the agenda date without creating a meeting', dry.meeting && dry.meeting.meeting_date === '2026-11-19' && dry.meeting.would_create && sb.db.meetings.length === 0);
    const live = await K.loadCommunityState(sb, { id: 'cg' }, { today: '2026-10-15' });
    check('live creates the meeting linked to the agenda', live.meeting.created && sb.db.meetings.length === 1 && sb.db.meetings[0].meeting_agenda_id === 'a1');
    const again = await K.loadCommunityState(sb, { id: 'cg' }, { today: '2026-10-15' });
    check('and finds it next time instead of creating another', sb.db.meetings.length === 1 && again.meeting.source === 'meetings');
    sb.db.accounting_periods.push({ id: 'p9', community_id: 'cg', period_start: '2026-09-01', period_end: '2026-09-30', status: 'open', period_type: 'monthly' },
      { id: 'p10', community_id: 'cg', period_start: '2026-10-01', period_end: '2026-10-31', status: 'open', period_type: 'monthly' },
      { id: 'p11', community_id: 'cg', period_start: '2026-11-01', period_end: '2026-11-30', status: 'open', period_type: 'monthly' });
    const reviewed = [];
    const st = await K.loadCommunityState(sb, { id: 'cg' }, { today: '2026-10-15', dryRun: true, review: async (pid) => { reviewed.push(pid); return { results: [], changed: false }; } });
    check('the months the packet reports are loaded through the cutoff, even if not over', st.periods.map((p) => p.id).join() === 'p9,p10' && st.periods.find((p) => p.id === 'p10').not_ended === true);
    check('Kat reviews only months that are over', reviewed.join() === 'p9');
    const assumed = await K.loadCommunityState(sb, { id: 'cg' }, { today: '2026-10-15', dryRun: true, meeting: { meeting_date: '2026-12-02' }, review: async () => ({ results: [], changed: false }) });
    check('a dry run can assume a meeting date', assumed.meeting.meeting_date === '2026-12-02' && assumed.meeting.source === 'assumed');
  }

  console.log('Ed\'s queue: months ready to close, packets ready for approval');
  {
    const stPath = require.resolve('../lib/close/service');
    const real = require.cache[stPath].exports;
    require.cache[stPath].exports = { ...real, status: async (_sb, _cid, pid) => ({ can_close: pid !== 'p-not' }) };
    const SN = require('../lib/statements/snapshot'); const M = require('../lib/statements/model');
    const snap = (kind) => {
      const m = { kind, period: { as_of: '2026-09-30', period_end: '2026-09-30' }, lifecycle: { status: 'closed', closed_through: '2026-09-30' }, community: { id: 'cg' }, mapping: { available: true, unmapped: [] } };
      m.snapshot_sha256 = M.modelSha(m);
      const models = [m];
      return { source: SN.SNAPSHOT_SOURCE, model_version: m.model_version, models, snapshot_sha256: SN.snapshotSha(models) };
    };
    const sb = fakeDb({
      period_closes: [{ community_id: 'cg', period_id: 'p8', period_start: '2026-08-01', period_end: '2026-08-31', status: 'ready_to_close' },
        { community_id: 'cg', period_id: 'p9', period_start: '2026-09-01', period_end: '2026-09-30', status: 'ready_to_close' }],
      communities: [{ id: 'cg', name: 'Canyon Gate', gl_cutover_date: '2026-08-01' }],
      accounting_periods: [{ id: 'p8', community_id: 'cg', period_start: '2026-08-01', period_end: '2026-08-31', status: 'open', period_type: 'monthly' },
        { id: 'p9', community_id: 'cg', period_start: '2026-09-01', period_end: '2026-09-30', status: 'open', period_type: 'monthly' }],
      board_packets: [{ id: 'k1', community_id: 'cg', period_label: 'October 2026 Board Meeting', meeting_date: '2099-10-28', status: 'draft' },
        { id: 'k2', community_id: 'cg', period_label: 'Empty', meeting_date: '2099-10-29', status: 'draft' }],
      board_packet_sections: [], statement_mapping_overrides: [],
    });
    let src = await K.pendingSources(sb);
    const close = src.find((x) => x.key === 'close_ready');
    check('only the earliest open month is ready for Ed (months close in order)', close && close.count === 1 && /August 2026/.test(close.label) && !/September/.test(close.label), JSON.stringify(src));
    check('a packet without statements pulled from the books is not "ready"', !src.find((x) => x.key === 'packets_ready'));
    const { isSnapshot } = require('../lib/statements/snapshot');
    const bs = snap('balance_sheet');
    if (isSnapshot(bs)) {
      sb.db.board_packet_sections.push({ packet_id: 'k1', section_key: 'balance_sheet', input_data: bs }, { packet_id: 'k1', section_key: 'income_statement', input_data: snap('income_statement') });
      sb.db.accounting_periods[1].status = 'closed';
      src = await K.pendingSources(sb);
      const pk = src.find((x) => x.key === 'packets_ready');
      check('a draft with closed-period statements that passes the gate is ready for Ed', pk && pk.count === 1 && /October 2026 Board Meeting/.test(pk.label), JSON.stringify(src));
    } else check('test snapshot fixture matches the statement snapshot shape', false, 'isSnapshot rejected the fixture');
    require.cache[stPath].exports = real;
  }

  console.log('guards: what the cadence must never do');
  {
    const src = fs.readFileSync(path.join(__dirname, '../lib/close/cadence.js'), 'utf8').replace(/\/\/.*$/gm, '');
    check('never closes a period', !/closePeriod|close_period'|\.rpc\(\s*'close_period/.test(src));
    check('never overrides, accepts warnings or reopens', !/overrideBlock|acceptWarnings|reopenPeriod/.test(src));
    check('never distributes, finalizes or sends', !/distribute\(|\/distribute|status:\s*'final'|queueDraft|sendMail|send_mail|resend/i.test(src));
    check('never posts or approves accounting', !/approveAndPost|post_recognition|journal_entries/.test(src));
    const sched = fs.readFileSync(path.join(__dirname, '../lib/scheduler.js'), 'utf8');
    check('the daily job is registered through the opt-in gate (off unless SCHEDULER_ENABLED names it)', /name: 'close_cadence'/.test(sched) && /scheduler\.register\(\{\s*name: 'close_cadence'/.test(sched));
    const ed = fs.readFileSync(path.join(__dirname, '../api/ed.js'), 'utf8');
    check('Ed\'s pending queue includes the close/packet sources', /close\/cadence'\)\.pendingSources/.test(ed));
  }

  console.log('runtime guard: the live sweep cannot reach close/override/accept/approve/post/distribute/send');
  {
    // Real loader + real reviewIfChanged; only the books gather and the checklist are stubbed.
    const root = path.join(__dirname, '..');
    const gp = require.resolve(path.join(root, 'lib/close/gather')); const cp = require.resolve(path.join(root, 'lib/close/controls'));
    const sp = require.resolve(path.join(root, 'lib/close/service')); const kp = require.resolve(path.join(root, 'lib/close/cadence'));
    const saved = { g: require.cache[gp], c: require.cache[cp], s: require.cache[sp], k: require.cache[kp] };
    const results = [R('CASH-01', 'BLOCK'), R('CUT-01', 'PASS'), R('CUT-02', 'PASS'), R('CUT-03', 'PASS'), R('IF-01', 'PASS')];
    require.cache[gp] = { id: gp, filename: gp, loaded: true, exports: { gatherCloseInput: async (_sb, cid, pid) => ({ period: { id: pid, status: 'open' }, facts: { fingerprint: `fp-${pid}` } }), _parts: {} } };
    require.cache[cp] = { id: cp, filename: cp, loaded: true, exports: { evaluateClose: () => ({ results, summary: { block: 1, warning: 0, pass: 4, total: 5 } }), ENGINE_VERSION: 'close-b.1' } };
    delete require.cache[sp]; delete require.cache[kp];
    const K2 = require(kp);
    const svc2 = require(sp);
    const ALLOWED_RPC = new Set(['close_record_run']);
    const FORBIDDEN_TABLES = new Set(['accounting_runs', 'accounting_run_events', 'bank_reconciliations', 'journal_entries', 'journal_entry_lines', 'period_closes', 'accounting_periods',
      'board_packet_distribution_log', 'outbound_email_drafts', 'email_messages', 'statement_mapping_overrides', 'period_close_events']);
    const base = fakeDb({
      communities: [{ id: 'cg', name: 'Canyon Gate', gl_cutover_date: '2026-08-01', board_package_config: null }],
      accounting_periods: [{ id: 'p8', community_id: 'cg', period_start: '2026-08-01', period_end: '2026-08-31', status: 'open', period_type: 'monthly' },
        { id: 'p9', community_id: 'cg', period_start: '2026-09-01', period_end: '2026-09-30', status: 'closed', period_type: 'monthly' }],
      period_closes: [], period_close_runs: [], period_close_events: [], meetings: [], board_packets: [], board_packet_sections: [], work_items: [],
      meeting_agendas: [{ id: 'a1', community_id: 'cg', meeting_date: '2026-10-28', meeting_type: 'regular', title: 'October Board Meeting' }],
    });
    const rpcs = [];
    const guarded = {
      rpc: async (name) => { rpcs.push(name); if (!ALLOWED_RPC.has(name)) throw new Error(`FORBIDDEN rpc ${name}`); return { data: { run_id: 'run-1', status: 'review' }, error: null }; },
      from: (t) => {
        const q = base.from(t);
        for (const op of ['insert', 'update', 'upsert', 'delete']) {
          const orig = q[op];
          q[op] = (...a) => { if (FORBIDDEN_TABLES.has(t) || (t === 'board_packets' && op === 'update')) throw new Error(`FORBIDDEN ${op} on ${t}`); if (!orig) throw new Error(`unexpected ${op} on ${t}`); return orig.apply(q, a); };
        }
        return q;
      },
    };
    // Every authority path in the close service throws if the sweep reaches it.
    const hits = [];
    for (const fn of ['closePeriod', 'overrideBlock', 'acceptWarnings', 'reopenPeriod', 'addEvidence']) svc2[fn] = () => { hits.push(fn); throw new Error(`FORBIDDEN ${fn}`); };
    const mrPath = require.resolve(path.join(root, 'lib/accounting/monthly_runs'));
    const mrSaved = require.cache[mrPath];
    require.cache[mrPath] = { id: mrPath, filename: mrPath, loaded: true, exports: new Proxy({}, { get: (_t, k) => () => { hits.push(`monthly_runs.${String(k)}`); throw new Error('FORBIDDEN monthly_runs'); } }) };
    const mc = { up: [], res: [] };
    let assembled = null;
    const r = await K2.runCadence({ supabase: guarded, env: {}, now: Date.parse('2026-10-15T15:00:00Z'), deps: {
      communities: async () => [{ id: 'cg' }],
      upsertAgentTask: async (o) => { mc.up.push(o.source_ref); return { id: 'w', created: true }; },
      resolveAgentTask: async (ref) => { mc.res.push(ref); return { resolved: 0 }; },
      assemblePackage: async (a) => { assembled = a; return { packet_id: 'pk', period_label: a.period_label, needs: [] }; },
      packetReadiness: async () => ({ ok: false, reasons: [] }) } });
    check('the live sweep completes against the guarded database', r.ok === true && r.failed === 0, JSON.stringify(r.errors));
    check('no close / override / accept / reopen / accounting-run path was reached', hits.length === 0, hits.join());
    check('the only database function it calls is close_record_run (Kat\'s review)', rpcs.length >= 1 && rpcs.every((n) => n === 'close_record_run'), rpcs.join());
    check('it wrote no period, close record, run approval, posting, distribution or email row', !base.writes.some((w) => FORBIDDEN_TABLES.has(w.table)));
    check('its only direct write is the meeting record from the saved agenda', base.writes.length === 1 && base.writes[0].table === 'meetings', JSON.stringify(base.writes.map((w) => w.table)));
    check('the packet for that meeting is not built while August is open', assembled === null);
    check('tasks go through Mission Control\'s agent upsert', mc.up.includes('close:cg:2026-08:CASH-01'));
    require.cache[mrPath] = mrSaved;
    require.cache[gp] = saved.g; require.cache[cp] = saved.c; require.cache[sp] = saved.s; require.cache[kp] = saved.k;
  }

  console.log('Mission Control: an agent task kept under a derived key is that item, not a second card');
  {
    const nodes = [{ key: 'close:cg:2026-09:AP-01', kind: 'task', owner: 'Kat', priority: 'high' }, { key: 'close:cg:2026-09', kind: 'deliverable', owner: 'Kat' }];
    const rest = OPS.mergeAgentTasks(nodes, [
      { id: 'w1', source_type: 'agent', source_ref: 'close:cg:2026-09:AP-01', assigned_to: 'Emma', sla_due_at: '2026-11-10T23:00:00Z', urgency: 'critical' },
      { id: 'w2', source_type: 'agent', source_ref: 'close:cg:2026-09', assigned_to: 'Amanda', sla_due_at: '2026-11-12T23:00:00Z' },
      { id: 'w3', source_type: 'manual', source_ref: 'close:cg:2026-09:AP-01' },
      { id: 'w4', source_type: 'agent', source_ref: 'something-else' }]);
    check('a control task takes the owner, deadline and urgency', nodes[0].owner === 'Emma' && nodes[0].due === '2026-11-10T23:00:00Z' && nodes[0].priority === 'critical' && nodes[0].work_item_id === 'w1');
    check('a deliverable keeps its owner and shows the coordinator and deadline', nodes[1].owner === 'Kat' && nodes[1].coordinator === 'Amanda' && nodes[1].due === '2026-11-12T23:00:00Z');
    check('only unattached work items remain cards (people\'s tasks are never merged away)', rest.map((w) => w.id).join() === 'w3,w4');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
