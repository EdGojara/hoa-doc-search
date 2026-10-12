// Mission Control: operations sources, module evidence, and the API (permissions,
// de-duplication, audit trail, completion from authoritative records). No network:
// Supabase and the auth gate are replaced with in-memory fakes.
'use strict';
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const OPS = require('../lib/mission_control/operations');
const MODS = require('../lib/mission_control/modules');
const G = require('../lib/mission_control/graph');
const c = { id: 'cid', name: 'Test Community' };
const p = { id: 'p1', period_start: '2026-09-01' };

console.log('operations: close checklist');
{
  const run = { id: 'r1', run_at: '2026-10-12', results: [
    { code: 'CASH-01', status: 'BLOCK', label: 'Every account reconciled', explanation: 'x', drill: { href: '/accounting.html?community_id=cid&view=bankrec', label: 'Bank Reconciliation' } },
    { code: 'DATA-02', status: 'BLOCK', label: 'Statements', explanation: '1 of 4 accounts have no statement for September 2026: Brokerage.' },
    { code: 'AP-01', status: 'BLOCK', label: 'AP ties', explanation: 'y' },
    { code: 'AP-02', status: 'WARNING', label: 'Held invoices', explanation: 'z' },
    { code: 'GL-01', status: 'PASS', label: 'GL balances', explanation: 'ok' }] };
  const t = OPS.closeTasks(c, p, run, { overrides: [{ control_code: 'AP-01' }], accepted_warnings: [] });
  const by = Object.fromEntries(t.map((x) => [x.source.control, x]));
  check('a passing control is not a task', !by['GL-01']);
  check('an owner-overridden block is not a task', !by['AP-01']);
  check('a warning is a non-blocking task', by['AP-02'] && by['AP-02'].blocking === false);
  check('a missing statement is Ed\'s action, requested by Kat, and blocks the cash reconciliation', by['DATA-02'].owner === 'Ed' && by['DATA-02'].requested_by === 'Kat' && by['DATA-02'].blocks[0] === by['CASH-01'].key && /Brokerage/.test(by['DATA-02'].title));
  check('the cash control blocks the close', by['CASH-01'].blocks[0] === OPS.closeKey('cid', '2026-09-01'));
  check('drill links go to the current accounting screen', by['CASH-01'].action.url.startsWith('/admin/accounting?'));
  const none = OPS.closeTasks(c, p, null, null);
  check('no recorded checklist run is itself a task (blockers unknown, never assumed clear)', none.length === 1 && /checklist/.test(none[0].title));
  const accepted = OPS.closeTasks(c, p, run, { overrides: [], accepted_warnings: [{ control_code: 'AP-02' }] });
  check('an accepted warning is not a task', !accepted.some((x) => x.source.control === 'AP-02'));
}

console.log('operations: Kat\'s runs and deliverables');
{
  const t = OPS.runTasks(c, [
    { id: 'b1', process: 'bank_reconciliation', period_month: '2026-09-01', status: 'prepared', totals: { account: 'Op 5313', difference_cents: 0 }, exceptions: [{ code: 'needs_receipt', text: 'Amazon' }] },
    { id: 'b2', process: 'bank_reconciliation', period_month: '2026-09-01', status: 'held', held_reason: 'No statement', totals: { account: 'Res 3186' }, exceptions: [] },
    { id: 'i1', process: 'interest', period_month: '2026-10-01', run_date: '2026-10-01', status: 'prepared', totals: {}, exceptions: [], preview: { items: [{ interest_cents: 100 }, { exception: true, interest_cents: 50 }] } },
  ], () => 'close:cid:2026-09:CASH-01');
  const [b1, b2, i1] = t;
  check('a prepared reconciliation is Ed\'s approval, deep-linked to the run', b1.owner === 'Ed' && b1.requested_by === 'Kat' && b1.action.url === '/ed.html?run=b1' && /approve/i.test(b1.title));
  check('it blocks the cash control and names its exceptions', b1.blocks[0] === 'close:cid:2026-09:CASH-01' && /needs_receipt/.test(b1.why));
  check('a held run asks for the statement', /statement/.test(b2.title) && b2.why === 'No statement');
  check('interest review is pending, not a blocker', i1.blocking === false && i1.blocks.length === 0 && /1 owners/.test(i1.title));
  const d = OPS.deliverablesForPeriod(c, p, { status: 'closed', closed_at: '2026-10-20' });
  check('a closed period makes the close and the package done', d.every((x) => x.state === 'done'));
  const o = OPS.deliverablesForPeriod(c, p, { status: 'review' });
  check('an open period: close blocks the package, package links the PDF', o[0].blocks[0] === o[1].key && /board_package&period_end=2026-09-30/.test(o[1].action.url));
}

console.log('operations: budget and balance-sheet decisions');
{
  const models = [
    { fund: 'OPR', summary: true, subtitle: 'Operating Fund · x', warnings: [], sections: [] },
    { fund: 'OPR', subtitle: 'Operating Fund · x', warnings: [{ code: 'fund_balance_negative', text: 'Ends at -68,710.51' }], sections: [{ key: 'expense', groups: [{ lines: [
      { account_number: '5115', account_name: 'Electricity', values: { proj: 10154372, prop: 7900000 } }, { account_number: '5200', account_name: 'Landscape', values: { proj: 9776784, prop: 10611600 } }] }] }] },
  ];
  const wf = { lines: [{ kind: 'interfund_transfer', account_number: '4010', account_name: 'Reserve Contribution', transfer: { status: 'needs_board_decision', final_cents: 16400000, from_fund_code: 'OPR', to_fund_code: 'RES' }, base_year: { ytd_actual_cents: 0 } }] };
  const n = OPS.budgetNodes(c, 2027, models, wf, 0);
  const keys = n.map((x) => x.key);
  check('the budget deliverable exists and every decision blocks it', n[0].kind === 'deliverable' && n.slice(1).filter((x) => x.blocking !== false).every((x) => x.blocks[0] === n[0].key));
  check('the provisional reserve contribution is a decision', keys.some((k) => /transfer:4010/.test(k)));
  check('no selected reserve projects is a decision', keys.some((k) => /reserve-projects/.test(k)));
  check('a negative fund is a decision', keys.some((k) => /deficit:OPR/.test(k)));
  check('a large assumption gap is flagged for review, not as a blocker', n.find((x) => /assumption:5115/.test(x.key)).blocking === false && !keys.some((k) => /assumption:5200/.test(k)));
  check('with projects selected (or no reserve fund) there is no project decision', !OPS.budgetNodes(c, 2027, models, wf, 2).some((x) => /reserve-projects/.test(x.key)) && !OPS.budgetNodes(c, 2027, models, wf, null).some((x) => /reserve-projects/.test(x.key)));
  const bs = { period: { as_of: '2026-09-30' }, columns: [{ key: 'fund:OPR', label: 'Operating' }, { key: 'fund:RES', label: 'Reserve' }, { key: 'fund:AAS', label: 'AAS' }, { key: 'total' }],
    interfund: { pairs: [{ label: 'Reserve owes Operating', receivable: { number: '1820' }, payable: { number: '2825' } }, { label: 'Operating owes Reserve', receivable: { number: '1825' }, payable: { number: '2820' } }] },
    sections: [{ key: 'asset', groups: [{ lines: [{ account_number: '1820', values: { total: 13100264 } }, { account_number: '1825', values: { total: 11040900 } }] }], total: { values: {} } },
      { key: 'equity', groups: [], total: { values: { 'fund:AAS': -675680, 'fund:OPR': 100 } } }] };
  const b = OPS.balanceNodes(c, bs, 'package:cid:2026-09');
  check('offsetting interfund balances become one decision with the net', b.length === 2 && /settle/i.test(b[0].title) && /\$20,593.64/.test(b[0].next));
  check('a negative non-operating fund is a decision blocking the package', /negative AAS/.test(b[1].title) && b[1].blocks[0] === 'package:cid:2026-09');
}

console.log('operations: work items');
{
  const w = OPS.workItemNodes([{ id: 'a', title: 'T', assigned_to: 'Ed', status: 'new', workspace: 'operations', blocks: ['x'] }, { id: 'b', title: 'P', assigned_to: 'Eng', status: 'new', workspace: 'platform' }], 'operations');
  check('workspace separation: only operations rows appear in Operations', w.length === 1 && w[0].key === 'wi:a');
  check('an item owned by Ed needs his action; dependencies are kept', w[0].state === 'needs_action' && w[0].blocks[0] === 'x' && w[0].editable);
}

console.log('modules: evidence-based states');
{
  const snap = { issues: { 7: { state: 'open' }, 99: { state: 'closed' } }, pulls: { 34: { state: 'open' }, 140: { state: 'merged' } } };
  const yes = () => true, no = () => false;
  const ok = [{ result: { ok: true } }], bad = [{ result: { ok: false } }];
  check('files missing, no PR: NOT STARTED', MODS.capabilityState({ files: ['a'] }, { checks: [], snapshot: snap, exists: no }).state === 'NOT STARTED');
  check('files missing, PR open: IN PROGRESS', MODS.capabilityState({ files: ['a'], prs: [34] }, { checks: [], snapshot: snap, exists: no }).state === 'IN PROGRESS');
  check('PR merged but code not in this build: MERGED (not deployed)', (() => { const s = MODS.capabilityState({ files: ['a'], prs: [140] }, { checks: [], snapshot: snap, exists: no }); return s.state === 'MERGED' && !s.deployed; })());
  check('deployed with no production evidence: NEEDS VERIFICATION', MODS.capabilityState({ files: ['a'] }, { checks: [], snapshot: snap, exists: yes }).state === 'NEEDS VERIFICATION');
  check('deployed, evidence fails: NEEDS VERIFICATION (a merge is not proof)', MODS.capabilityState({ files: ['a'] }, { checks: bad, snapshot: snap, exists: yes }).state === 'NEEDS VERIFICATION');
  check('deployed, every check passes: VERIFIED', MODS.capabilityState({ files: ['a'] }, { checks: ok, snapshot: snap, exists: yes }).state === 'VERIFIED');
  check('an open blocking issue: BLOCKED even with evidence', MODS.capabilityState({ files: ['a'], blocking_issues: [7] }, { checks: ok, snapshot: snap, exists: yes }).state === 'BLOCKED');
  const caps = [{ state: 'VERIFIED' }, { state: 'VERIFIED', required: true }, { state: 'NOT STARTED', required: false }];
  check('all required verified, not accepted: VERIFIED, never COMPLETE on evidence alone', MODS.moduleState(caps, []) === 'VERIFIED');
  check('accepted by the owner with nothing open: COMPLETE', MODS.moduleState(caps, [], { accepted: true }) === 'COMPLETE');
  check('accepted but Now work still open: VERIFIED', MODS.moduleState(caps, [{ horizon: 'now' }], { accepted: true }) === 'VERIFIED');
  check('accepted but a linked issue is open: VERIFIED', MODS.moduleState([{ state: 'VERIFIED', issues: [{ state: 'open' }] }], [], { accepted: true }) === 'VERIFIED');
  check('one required capability blocked: BLOCKED', MODS.moduleState([{ state: 'VERIFIED' }, { state: 'BLOCKED' }], []) === 'BLOCKED');
  check('every module key is unique and every capability has a name', new Set(MODS.MODULES.map((m) => m.key)).size === MODS.MODULES.length && MODS.MODULES.every((m) => m.capabilities.every((x) => x.key && x.name)));
}

// ---- API with in-memory Supabase and auth --------------------------------------
async function apiTests() {
  console.log('api: permissions, de-duplication, audit, decisions');
  const db = { work_items: [], work_item_events: [] };
  let seq = 0;
  function qb(table) {
    const st = { filters: [], table, op: 'select', patch: null, rows: null, single: false, maybe: false, head: false };
    const rowsOf = () => (db[table] || []).filter((r) => st.filters.every((f) => f(r)));
    const q = {
      select(cols, opts) { if (opts && opts.head) st.head = true; if (table === 'work_items' && cols && /workspace|horizon|links/.test(cols) && !db.ready) st.err = 'column work_items.workspace does not exist'; return q; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return q; }, neq(k, v) { st.filters.push((r) => r[k] !== v); return q; },
      in(k, v) { st.filters.push((r) => v.includes(r[k])); return q; }, like(k, v) { const re = new RegExp('^' + v.replace(/%/g, '.*') + '$'); st.filters.push((r) => re.test(String(r[k] || ''))); return q; },
      not() { return q; }, or() { return q; }, contains() { return q; }, gte() { return q; }, lt() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      insert(row) { st.op = 'insert'; st.rows = Array.isArray(row) ? row : [row]; return q; },
      update(patch) { st.op = 'update'; st.patch = patch; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.maybe = true; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (st.err) return { data: null, error: { message: st.err } };
      if (st.op === 'insert') {
        const out = [];
        for (const r of st.rows) {
          if (table === 'work_items' && r.source_ref && db.work_items.some((x) => x.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(x.status)) && ['new', 'in_progress', 'waiting'].includes(r.status || 'new'))
            return { data: null, error: { message: 'duplicate key value violates unique constraint "ux_work_items_open_source_ref"' } };
          const row = { id: `id${++seq}`, workspace: 'operations', blocks: [], links: [], ...r }; (db[table] = db[table] || []).push(row); out.push(row);
        }
        return { data: st.single ? out[0] : out, error: null };
      }
      if (st.op === 'update') { for (const r of rowsOf()) Object.assign(r, st.patch); return { data: null, error: null }; }
      const rows = rowsOf();
      if (st.head) return { count: rows.length, error: null };
      const copy = JSON.parse(JSON.stringify(rows));
      return { data: st.single || st.maybe ? (copy[0] || null) : copy, error: null };
    }
    return q;
  }
  const fakeSb = { from: qb, auth: { getUser: async () => ({ data: { user: null } }) } };
  const sbPath = require.resolve('@supabase/supabase-js');
  require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => fakeSb } };
  const USERS = { staff: { role: 'staff', full_name: 'Martha Staff', email: 'martha@x.com' }, owner: { role: 'admin', full_name: 'Ed Gojara', email: 'egojara@bedrocktx.com' } };
  const gatePath = require.resolve('../api/_require_admin');
  const who = (req) => USERS[req.headers['x-test-user']] || null;
  require.cache[gatePath] = { id: gatePath, filename: gatePath, loaded: true, exports: {
    getAuthedUser: async (req) => who(req),
    requireStaff: async (req, res) => { const u = who(req); if (!u) { res.status(403).json({ error: 'sign_in_required' }); return null; } return u; },
    requireAdmin: async (req, res) => { const u = who(req); if (!u || u.role !== 'admin') { res.status(403).json({ error: 'admin_only' }); return null; } return u; },
    requireOwner: async (req, res) => { const u = who(req); if (!u || u.email !== 'egojara@bedrocktx.com') { res.status(403).json({ error: 'owner_only' }); return null; } return u; },
    OWNER_EMAIL: 'egojara@bedrocktx.com' } };
  const MC = require('../api/mission_control');
  const WI = require('../api/work_items');
  const express = require('express');
  const app = express(); app.use('/api/mission-control', MC.router); app.use('/api/work-items', WI.router);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, user, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, body: j }; };
  try {
    check('signed-out callers are refused (Mission Control and the work-items board)', (await call('GET', '/api/mission-control', null)).status === 403 && (await call('GET', '/api/work-items', null)).status === 403 && (await call('PATCH', '/api/work-items/x', null, { status: 'done' })).status === 403);
    check('staff cannot open Platform Buildout or Needs my action', (await call('GET', '/api/mission-control?workspace=platform', 'staff')).status === 403 && (await call('GET', '/api/mission-control?workspace=mine', 'staff')).status === 403);
    db.ready = false;
    const pre = await call('POST', '/api/mission-control/items', 'staff', { title: 'x' });
    check('before migration 513 a task cannot be created (409, nothing saved)', pre.status === 409 && db.work_items.length === 0);
    db.ready = true;
    check('staff cannot create Platform work', (await call('POST', '/api/mission-control/items', 'staff', { workspace: 'platform', title: 'y' })).status === 403);
    const a1 = await call('POST', '/api/mission-control/items', 'owner', { title: 'Upload the September statement', source_ref: 'kat:stmt:2026-09', assigned_to: 'Ed', blocks: ['close:cid:2026-09'] });
    const a2 = await call('POST', '/api/mission-control/items', 'owner', { title: 'Upload the September statement (again)', source_ref: 'kat:stmt:2026-09' });
    check('the same open issue updates its task instead of duplicating it', a1.body.created === true && a2.body.created === false && a1.body.id === a2.body.id && db.work_items.length === 1 && db.work_items[0].title.endsWith('(again)'));
    const ag = await MC.upsertAgentTask({ title: 'Kat: statement still missing', source_ref: 'kat:stmt:2026-09', requested_by: 'Kat' });
    check('an agent meeting the same issue touches the same task', ag && ag.id === a1.body.id && db.work_items.length === 1 && db.work_item_events.some((e) => e.event === 'agent_touch' && e.actor === 'Kat'));
    check('an agent task without a stable reference is refused', (await MC.upsertAgentTask({ title: 'no ref' })) === null);
    const plat = await call('POST', '/api/mission-control/items', 'owner', { workspace: 'platform', title: 'Live $1 payment', item_type: 'capability', module_key: 'homeowner_payments', horizon: 'now', links: [{ kind: 'issue', ref: '99' }, { kind: 'pr', ref: '999', url: 'javascript:alert(1)' }] });
    const pr = db.work_items.find((w) => w.id === plat.body.id);
    check('platform work keeps module, Now/Next/Later and safe GitHub links', pr.workspace === 'platform' && pr.horizon === 'now' && pr.links.length === 2 && pr.links[1].url === null);
    check('staff cannot edit a platform item through Mission Control or the legacy board', (await call('PATCH', `/api/mission-control/items/${plat.body.id}`, 'staff', { horizon: 'later' })).status === 403 && (await call('PATCH', `/api/work-items/${plat.body.id}`, 'staff', { status: 'done' })).status === 403);
    const listStaff = await call('GET', '/api/work-items', 'staff');
    check('the legacy board hides platform items from staff', listStaff.status === 200 && !listStaff.body.items.some((i) => i.workspace === 'platform'));
    const done = await call('PATCH', `/api/mission-control/items/${a1.body.id}`, 'owner', { status: 'done' });
    const row = db.work_items.find((w) => w.id === a1.body.id);
    check('closing a task stamps completed_at and records who changed what', done.status === 200 && row.completed_at && db.work_item_events.some((e) => e.work_item_id === a1.body.id && e.event === 'status_changed' && e.actor === 'Ed Gojara' && e.detail.to.status === 'done'));
    const again = await call('POST', '/api/mission-control/items', 'owner', { title: 'Statement missing again', source_ref: 'kat:stmt:2026-09' });
    check('a closed task does not absorb a new occurrence: a new task opens', again.body.created === true && again.body.id !== a1.body.id);
    const ev = await call('GET', `/api/mission-control/items/${a1.body.id}/events`, 'staff');
    check('the audit trail is readable by staff for operations items', ev.status === 200 && ev.body.events.length >= 3);
    check('only the owner records a decision, and it needs a real note', (await call('POST', '/api/mission-control/decide', 'staff', { key: 'budget:cid:2027:reserve-projects', note: 'No projects in 2027' })).status === 403
      && (await call('POST', '/api/mission-control/decide', 'owner', { key: 'budget:cid:2027:reserve-projects', note: 'ok' })).status === 400);
    const dec = await call('POST', '/api/mission-control/decide', 'owner', { key: 'budget:cid:2027:reserve-projects', title: 'Select projects', note: 'No reserve projects in 2027 per board.' });
    check('a recorded decision is a done work item keyed to the derived item, with an audit event', dec.status === 200 && db.work_items.some((w) => w.source_ref === 'budget:cid:2027:reserve-projects' && w.status === 'done') && db.work_item_events.some((e) => e.event === 'closed_by_evidence'));
    check('owner names: the owner account answers to "Ed"', MC.ownerNames(USERS.owner).has('Ed') && !MC.ownerNames(USERS.staff).has('Ed'));
    const gh = MC.withGithub([{ links: [{ kind: 'pr', ref: '140' }, { kind: 'issue', ref: '7' }] }], { pulls: { 140: { state: 'merged', url: 'https://github.com/x/pull/140', title: 'p' } }, issues: { 7: { state: 'open', url: 'https://github.com/x/issues/7', title: 'i' } } });
    check('GitHub state is attached as development status, not business status', gh[0].dev_status === 'merged' && gh[0].links[1].github_state === 'open' && gh[0].state === undefined);
  } finally { await new Promise((r) => srv.close(r)); }
}

apiTests().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; })
  .catch((e) => { console.error(e.stack); process.exit(1); });
