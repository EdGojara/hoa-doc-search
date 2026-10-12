#!/usr/bin/env node
// Manager sweep execution (Ed 2026-10-12): the sweep runs the agents' EXISTING
// capabilities on Today's AI-owned items, once per idempotency key, records every
// attempt on work_item_events, retries failures and escalates after three. It never
// posts accounting, releases payments, sends email or decides an ACC application.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { executeAgentWork } = require('../lib/manager/sweep');
const { applyExecution } = require('../lib/feed/build');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

// Minimal in-memory PostgREST stand-in for the tables the executor touches.
function fakeDb(seed = {}) {
  const T = { work_items: [], work_item_events: [], outbound_email_drafts: [], ap_intake_exceptions: [], email_messages: [], properties: [], communities: [], ...seed };
  let n = 0;
  const from = (table) => {
    const st = { table, filters: [], op: 'select', row: null, patch: null, single: false };
    const match = (r) => st.filters.every(([k, op, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'ilike' ? new RegExp('^' + String(v).replace(/%/g, '.*') + '$', 'i').test(String(r[k] || '')) : true));
    const exec = () => {
      const rows = (T[table] = T[table] || []);
      if (st.op === 'insert') {
        const r = { id: `id${++n}`, created_at: new Date().toISOString(), ...st.row };
        if (table === 'work_items' && rows.some((x) => x.source_ref === r.source_ref && ['new', 'in_progress', 'waiting'].includes(x.status))) return { data: null, error: { code: '23505', message: 'dup' } };
        rows.push(r); return { data: st.single ? r : [r], error: null };
      }
      if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit, error: null }; }
      const hit = rows.filter(match); return { data: st.single ? hit[0] || null : hit, error: null };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { st.filters.push([k, 'eq', v]); return q; }, in(k, v) { st.filters.push([k, 'in', v]); return q; }, ilike(k, v) { st.filters.push([k, 'ilike', v]); return q; },
      insert(row) { st.op = 'insert'; st.row = row; return q; }, update(p) { st.op = 'update'; st.patch = p; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return q;
  };
  return { from, T };
}
const owner = (key, name) => ({ key, name, role: '' });
const card = (key, kind, executor, extra = {}) => ({ key, kind, title: key, why: 'w', owner: owner('emma', 'Emma'), next_action: 'n', executor, ...extra });
const feedOf = (cards) => async () => ({ sections: { ai_working: cards, decisions: [], waiting: [], completed: [] } });

(async () => {
  console.log('Manager sweep execution');

  await t('each executable item runs once; a second sweep re-runs nothing (no duplicate draft, review or team run)', async () => {
    const db = fakeDb({ ap_intake_exceptions: [{ id: 'x1', vendor_name: 'Golden Eagle', invoice_number: '25003', total_cents: 10000, email_message_id: 'm1', status: 'pending' }], email_messages: [{ id: 'm1', sender_email: 'cdeleon@bedrocktx.com', sender_name: 'Celina Deleon', subject: 'Fw: Payment confirmation' }] });
    let team = 0, review = 0, drafts = 0;
    const deps = {
      buildFeed: feedOf([
        card('objective:o1', 'objective', { name: 'legal_team', key: 'legal_team:inv1:t1', ref: 'inv1' }),
        card('acc_decision:a1', 'acc_decision', { name: 'acc_reassess', key: 'acc_reassess:a1:d1', ref: 'a1' }),
        card('ap_exception:x1', 'ap_exception', { name: 'request_invoice', key: 'request_invoice:x1', ref: 'x1' }),
        card('ap_invoice:i1', 'ap_invoice', null, { gap: 'new-payee verification is not automated' }),
      ]),
      runLegalTeam: async () => { team++; return { ok: true }; },
      reassessCase: async () => { review++; return { status: 'reviewed', recommendation: 'approve', documents: 3 }; },
      queueDraft: async (d) => { drafts++; db.T.outbound_email_drafts.push({ id: 'd1', source_email_ref: d.sourceEmailRef, draft_kind: d.draftKind, status: 'draft', to: d.toEmail, body: d.bodyText }); return { status: 'queued', id: 'd1' }; },
    };
    const r1 = await executeAgentWork({ supabase: db, env: {}, deps });
    assert.strictEqual(r1.executed, 3); assert.strictEqual(r1.not_automated, 1);
    assert.deepStrictEqual([team, review, drafts], [1, 1, 1]);
    assert.strictEqual(db.T.outbound_email_drafts[0].to, 'cdeleon@bedrocktx.com'); assert.match(db.T.outbound_email_drafts[0].body, /not an invoice/);
    assert.strictEqual(db.T.work_items.length, 3, 'one work item per executable item'); assert.ok(db.T.work_items.every((w) => w.source_type === 'agent' && w.workspace === 'operations'));
    const r2 = await executeAgentWork({ supabase: db, env: {}, deps });
    assert.strictEqual(r2.executed, 0); assert.strictEqual(r2.already_done, 3);
    assert.deepStrictEqual([team, review, drafts], [1, 1, 1], 'nothing ran twice');
  });

  await t('an existing request draft (even one already sent) is never re-queued', async () => {
    const db = fakeDb({ outbound_email_drafts: [{ id: 'old', source_email_ref: 'ap_exception:x2', draft_kind: 'request_invoice', status: 'sent' }] });
    let drafts = 0;
    const r = await executeAgentWork({ supabase: db, env: {}, deps: { buildFeed: feedOf([card('ap_exception:x2', 'ap_exception', { name: 'request_invoice', key: 'request_invoice:x2', ref: 'x2' })]), queueDraft: async () => { drafts++; return { status: 'queued' }; } } });
    assert.strictEqual(drafts, 0); assert.strictEqual(r.executed, 1); assert.strictEqual(r.results[0].outcome, 'draft_queued');
  });

  await t('a failure retries on the next sweep; after three failures it stops and escalates', async () => {
    const db = fakeDb();
    let calls = 0;
    const deps = { buildFeed: feedOf([card('objective:o9', 'objective', { name: 'legal_team', key: 'legal_team:inv9:t', ref: 'inv9' })]), runLegalTeam: async () => { calls++; throw new Error('upstream timeout'); } };
    for (let i = 0; i < 4; i++) await executeAgentWork({ supabase: db, env: {}, deps });
    assert.strictEqual(calls, 3, 'three attempts, then no more');
    assert.strictEqual(db.T.work_item_events.filter((e) => e.event === 'agent_touch' && e.detail.ok === false).length, 3);
    const r = await executeAgentWork({ supabase: db, env: {}, deps }); assert.strictEqual(r.escalated, 1);
  });

  await t('a bill for a former client is recorded out of scope and never loaded', async () => {
    const db = fakeDb({ ap_intake_exceptions: [{ id: 'w1', status: 'pending', vendor_name: 'Winstead PC', extracted: { community_hint: 'RC - Perkins - 9627 Tree Sparrow' } }], properties: [{ community_id: 'ew', street_address: '9627 Tree Sparrow Lane' }] });
    const own = require('../lib/accounting/ownership');
    const orig = own.accountingStatusFor; own.accountingStatusFor = async () => ({ enabled: false, reason: 'leaving Bedrock', community: { name: 'Eaglewood' } });
    let promoted = 0;
    try {
      const r = await executeAgentWork({ supabase: db, env: {}, deps: { buildFeed: feedOf([card('ap_exception:w1', 'ap_exception', { name: 'resolve_community', key: 'resolve_community:w1', ref: 'w1' })]), promoteException: async () => { promoted++; return { ok: true }; } } });
      assert.strictEqual(r.results[0].outcome, 'out_of_scope'); assert.strictEqual(promoted, 0);
      assert.strictEqual(db.T.work_items[0].status, 'done');
    } finally { own.accountingStatusFor = orig; }
  });

  await t('Today shows what actually happened: executed, drafted awaiting send, queued (sweep off), not automated, escalated', async () => {
    const db = fakeDb({ work_items: [{ id: 'w', source_type: 'agent', source_ref: 'k1', status: 'waiting' }, { id: 'v', source_type: 'agent', source_ref: 'k4', status: 'in_progress' }],
      work_item_events: [{ work_item_id: 'w', event: 'agent_touch', detail: { key: 'request_invoice:x', ok: true, outcome: 'draft_queued' }, created_at: '2026-10-13T12:00:00Z' },
        ...[1, 2, 3].map((i) => ({ work_item_id: 'v', event: 'agent_touch', detail: { key: 'legal_team:z', ok: false, error: 'boom' }, created_at: `2026-10-13T0${i}:00:00Z` }))] });
    const out = { schedule: { scheduled: false }, sections: { decisions: [], waiting: [], completed: [], ai_working: [
      card('k1', 'ap_exception', { name: 'request_invoice', key: 'request_invoice:x', ref: 'x' }),
      card('k2', 'acc_decision', { name: 'acc_reassess', key: 'acc_reassess:a:d', ref: 'a' }),
      card('k3', 'ap_invoice', null, { gap: 'new-payee verification is not automated' }),
      card('k4', 'objective', { name: 'legal_team', key: 'legal_team:z', ref: 'z' }),
    ] } };
    const run = async (_n, p) => (await p).data;
    await applyExecution(db, out, Date.now(), run);
    const by = Object.fromEntries(out.sections.ai_working.map((c) => [c.key, c]));
    assert.strictEqual(by.k1.status, 'awaiting_send'); assert.match(by.k1.status_text, /waits in the outbox/);
    assert.strictEqual(by.k2.status, 'queued'); assert.match(by.k2.status_text, /not scheduled in production, so nothing is executing/);
    assert.strictEqual(by.k3.status, 'not_automated'); assert.match(by.k3.status_text, /A person completes it/);
    assert.ok(!by.k4 && out.sections.decisions.some((d) => d.key === 'k4' && d.decision_type === 'repeated_failure'), 'three failures move it to your decisions');
  });

  await t('controls: the executors cannot post, pay, send or decide', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'manager', 'sweep.js'), 'utf8');
    const exec = src.slice(src.indexOf('const EXECUTORS = {'), src.indexOf('async function executeAgentWork'));
    for (const forbidden of ['postJournalEntry', 'posting', 'check_run', 'recordPayment', 'graph_send', 'sendDraft', 'approveTreatment', 'finaliz', 'mark-paid', 'approveAndPost']) assert.ok(!exec.includes(forbidden), `executor references ${forbidden}`);
    assert.ok(/queueDraft/.test(exec) && /status: 'draft'|draftKind: 'request_invoice'/.test(exec), 'email is only ever drafted');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
