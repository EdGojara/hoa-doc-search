#!/usr/bin/env node
// Scheduled-agent guardrails (Ed 2026-10-15 scheduler safety audit). Before the accounting
// jobs are enabled on Render, prove what a SCHEDULED run can and cannot do:
//   manager_sweep          executes nothing unless MANAGER_EXECUTE=on, then only the executors
//                          named in MANAGER_EXECUTORS (default: request_invoice, a draft a person sends)
//   kat_monthly_accounting prepares runs only; the held-attorney accrual backstop lists, never
//                          posts, unless KAT_AUTO_ACCRUE_LEGAL=on; a run posts only on in-app approval
//   ap_intake_stragglers   read-only
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { executeAgentWork, scheduledExecutors } = require('../lib/manager/sweep');
const { assertInAppApproval } = require('../lib/accounting/monthly_runs');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

// Minimal in-memory PostgREST stand-in for the tables the executor touches.
function fakeDb(seed = {}) {
  const T = { work_items: [], work_item_events: [], outbound_email_drafts: [], ap_intake_exceptions: [], email_messages: [], ...seed };
  let n = 0;
  const from = (table) => {
    const st = { table, filters: [], op: 'select', row: null, patch: null, single: false };
    const match = (r) => st.filters.every(([k, op, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : true));
    const exec = () => {
      const rows = (T[table] = T[table] || []);
      if (st.op === 'insert') { const r = { id: `id${++n}`, created_at: new Date().toISOString(), ...st.row }; rows.push(r); return { data: st.single ? r : [r], error: null }; }
      if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.patch)); return { data: hit, error: null }; }
      const hit = rows.filter(match); return { data: st.single ? hit[0] || null : hit, error: null };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { st.filters.push([k, 'eq', v]); return q; }, in(k, v) { st.filters.push([k, 'in', v]); return q; },
      insert(row) { st.op = 'insert'; st.row = row; return q; }, update(p) { st.op = 'update'; st.patch = p; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    };
    return q;
  };
  return { from, T };
}
const card = (key, executor) => ({ key, kind: 'x', title: key, why: 'w', owner: { key: 'emma', name: 'Emma' }, next_action: 'n', executor });
const feedOf = (cards) => async () => ({ sections: { ai_working: cards, decisions: [], waiting: [], completed: [] } });
const cards = () => [
  card('objective:o1', { name: 'legal_team', key: 'legal_team:k1', ref: 'inv1' }),
  card('acc_decision:a1', { name: 'acc_reassess', key: 'acc_reassess:k1', ref: 'a1' }),
  card('ap_exception:x1', { name: 'resolve_community', key: 'resolve_community:k1', ref: 'x1' }),
  card('ap_exception:x2', { name: 'request_invoice', key: 'request_invoice:k2', ref: 'x2' }),
];

(async () => {
  console.log('Scheduled-agent guardrails');

  await t('manager_sweep: agent execution is opt-in (MANAGER_EXECUTE=on), never on by default', async () => {
    const s = src('lib/manager/sweep.js');
    assert.ok(/String\(env\.MANAGER_EXECUTE \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'on'/.test(s), 'execution gate must require MANAGER_EXECUTE=on');
    assert.ok(/executeAgentWork\(\{ supabase, now, env, scheduled: true \}\)/.test(s), 'the scheduled sweep marks its execution as scheduled');
  });

  await t('scheduled execution defaults to drafts only: no legal team, ACC review or bill loading', async () => {
    assert.deepStrictEqual([...scheduledExecutors({})], ['request_invoice']);
    const calls = { team: 0, review: 0, promote: 0, drafts: 0 };
    const db = fakeDb({ outbound_email_drafts: [{ id: 'd0', source_email_ref: 'ap_exception:x2', draft_kind: 'request_invoice', status: 'draft' }] });
    const deps = { buildFeed: feedOf(cards()), runLegalTeam: async () => { calls.team++; return {}; }, reassessCase: async () => { calls.review++; return { status: 'reviewed' }; },
      promoteException: async () => { calls.promote++; return { ok: true }; }, queueDraft: async () => { calls.drafts++; return { status: 'queued' }; } };
    const r = await executeAgentWork({ supabase: db, env: {}, deps, scheduled: true });
    assert.deepStrictEqual([calls.team, calls.review, calls.promote], [0, 0, 0], 'no model calls and no bill loaded');
    assert.strictEqual(r.not_permitted, 3); assert.strictEqual(r.executed, 1);
    assert.strictEqual(db.T.work_items.length, 1, 'non-permitted items get no work item from the scheduled run');
  });

  await t('MANAGER_EXECUTORS names more executors explicitly; unknown names are ignored', async () => {
    assert.deepStrictEqual([...scheduledExecutors({ MANAGER_EXECUTORS: 'request_invoice, acc_reassess, wire_money' })].sort(), ['acc_reassess', 'request_invoice']);
  });

  await t('an on-demand (non-scheduled) call keeps its existing behaviour', async () => {
    let team = 0;
    const db = fakeDb({});
    const r = await executeAgentWork({ supabase: db, env: {}, deps: { buildFeed: feedOf([cards()[0]]), runLegalTeam: async () => { team++; return {}; } } });
    assert.strictEqual(team, 1); assert.strictEqual(r.executed, 1);
  });

  await t('kat_monthly_accounting: the attorney accrual backstop lists unless KAT_AUTO_ACCRUE_LEGAL=on', async () => {
    const m = src('lib/accounting/monthly_runs.js'); const i = src('lib/ap/intake.js');
    assert.ok(/const postLegal = String\(env\.KAT_AUTO_ACCRUE_LEGAL \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'on';/.test(m));
    assert.ok(/accrueHeldLegalInvoices\(\{ today, logger, post: postLegal \}\)/.test(m));
    const body = i.slice(i.indexOf('async function accrueHeldLegalInvoices'), i.indexOf('async function postAccrualForInvoice'));
    assert.ok(body.indexOf('if (!post)') > 0 && body.indexOf('if (!post)') < body.indexOf('postAccrualForInvoice('), 'the list-only branch comes before any posting');
  });

  await t('kat_monthly_accounting: the daily tick prepares, never approves or posts a run', async () => {
    const m = src('lib/accounting/monthly_runs.js');
    const tick = m.slice(m.indexOf('async function dailyTick'), m.indexOf('module.exports'));
    for (const bad of ['approveAndPost(', 'postBankRec(', 'postRecognition(', 'postProposals(', 'postApproved(', 'postJournalEntry(', 'storeReconciliation(']) assert.ok(!tick.includes(bad), `dailyTick/bankTick must not call ${bad}`);
    assert.throws(() => assertInAppApproval({ channel: 'scheduler', user_id: 'kat' }), /approval_required/);
    assert.throws(() => assertInAppApproval(null), /approval_required/);
  });

  await t('ap_intake_stragglers is read-only', async () => {
    const s = src('lib/ap/stragglers.js');
    assert.ok(!/\.(insert|update|upsert|delete)\(/.test(s), 'no writes'); assert.ok(!/queueDraft|sendAs|messages\.create/.test(s), 'no sends or model calls');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
