#!/usr/bin/env node
// tests/test_close_policy.js  (Ed 2026-10-12: permanent accrual close policy)
// "No accounting month may be closed until Kat has completed a month-end cutoff review
// and I have approved the close." The existing close carries it:
//   - the cutoff controls (CUT-01 expenses in the period incurred, CUT-02 delinquent
//     interest, CUT-03 prepaids, IF-01 interfund) as pure functions of gathered facts;
//   - Kat's review = a Kat-recorded run carrying every cutoff control;
//   - only the owner closes, only on Kat's review (service + migration 517);
//   - Kat's close-readiness report: exceptions, proposed adjustments, evidence;
//   - nothing closes a period automatically.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluateClose, ENGINE_VERSION } = require('../lib/close/controls');
const P = require('../lib/close/policy');
const { buildReadiness, renderReadinessHtml } = require('../lib/close/readiness');
const S = require('../lib/close/service');

let passed = 0; let failed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const by = (res, code) => res.results.find((r) => r.code === code) || {};
const CID = '00000000-0000-0000-0000-0000000000c3';
const facts = { period_start: '2026-08-01', period_end: '2026-08-31', counted_lines: 10, fingerprint: 'f', through_debits_cents: 1, through_credits_cents: 1, period_debits_cents: 1, period_credits_cents: 1,
  broken_entries: [], draft_entries: [], invalid_dates: [], backdated_into_closed: [], unbalanced_funds: [], voided_without_reversal: [] };
const bill = (o) => ({ id: 'b1', vendor: 'CenterPoint', invoice_number: '881', invoice_date: '2026-09-04', service_period_start: '2026-08-01', service_period_end: '2026-08-31', total_cents: 41250, status: 'paid', posting_date: '2026-09-04', journal_reference: 'JE-2026-00470', ...o });
const interestRun = (status, o = {}) => ({ id: '5d0b8e2c-0000-4000-8000-000000000001', process: 'interest', status, run_date: '2026-08-01', subject_id: null, held_reason: null,
  totals: { owners: 70, interest_cents: 148816, clean_owners: 64, clean_interest_cents: 64048, exception_owners: 6, exception_interest_cents: 84768 }, exceptions: [], proposals: [], recognition_items: [], journal_reference: null, ...o });
const input = (cut = {}, inter = undefined) => ({
  community: { id: CID }, facts, bank: {}, ar: { reconciliation: { tied: true, difference_cents: 0 } }, ap: { open_rows: [], gl_ap_cents: 0, held: [] }, recognition: {}, conversion: {},
  sources: { requirements: [], homeowner: { applies: true, batches: [], mode: 'import' }, ap_exceptions: [], recurring_gaps: [], other_evidence: [] },
  cutoff: { late_bills: [], prepaid_bills: [], interest: { enabled: true, settings: {}, runs: [interestRun('posted', { journal_reference: 'INT-CG-2026-08' })] }, open_runs: [], ...cut },
  interfund: inter === undefined ? { applies: true, pairs: [{ fund_code: 'RES', fund_name: 'Reserve', fund_owes_operating_cents: 2059364, operating_owed_cents: 2059364 }], unresolved: [] } : inter,
});

(async () => {
  console.log('Accrual close policy');

  await t('the engine carries the cutoff review: every cutoff control is evaluated', () => {
    assert.strictEqual(ENGINE_VERSION, 'close-b.1');
    const r = evaluateClose(input());
    for (const c of P.CUTOFF_CONTROLS) assert.ok(r.results.some((x) => x.code === c), c);
    for (const c of P.CUTOFF_CONTROLS) assert.strictEqual(by(r, c).status, 'PASS', `${c} ${by(r, c).explanation}`);
  });

  await t('CUT-01: a bill for August service booked in September is a late-arriving bill with a proposal to recognize it in August (WARNING, nothing posted)', () => {
    const c = by(evaluateClose(input({ late_bills: [bill()] })), 'CUT-01');
    assert.strictEqual(c.status, 'WARNING');
    assert.match(c.explanation, /CenterPoint #881 \$412\.50 \(service 2026-08-01 to 2026-08-31\) booked 2026-09-04/);
    assert.strictEqual(c.evidence.proposals.length, 1);
    assert.strictEqual(c.evidence.proposals[0].posting_date, '2026-08-31');
    assert.match(c.evidence.proposals[0].text, /accrue it dated 2026-08-31/);
    assert.match(c.action, /posts nothing/);
  });

  await t('CUT-01: an August bill not booked at all BLOCKs (AP and expense understated)', () => {
    const c = by(evaluateClose(input({ late_bills: [bill({ posting_date: null, journal_reference: null, status: 'pending_approval' })] })), 'CUT-01');
    assert.strictEqual(c.status, 'BLOCK');
    assert.match(c.evidence.proposals[0].text, /book it dated in August 2026, not the month it arrived/);
  });

  await t('CUT-02: the month\'s interest run must be posted; a prepared run BLOCKs and names its amounts', () => {
    const c = by(evaluateClose(input({ interest: { enabled: true, settings: {}, runs: [interestRun('prepared')] } })), 'CUT-02');
    assert.strictEqual(c.status, 'BLOCK');
    assert.match(c.explanation, /prepared: \$640\.48 for 64 owners ready, \$847\.68 for 6 held exception owners/);
    assert.strictEqual(by(evaluateClose(input({ interest: { enabled: true, settings: {}, runs: [] } })), 'CUT-02').status, 'BLOCK', 'no run at all');
    assert.strictEqual(by(evaluateClose(input({ interest: { enabled: true, settings: {}, runs: [interestRun('held', { held_reason: 'legal review' })] } })), 'CUT-02').status, 'BLOCK', 'held');
    assert.strictEqual(by(evaluateClose(input()), 'CUT-02').status, 'PASS', 'posted');
    const off = by(evaluateClose(input({ interest: { enabled: false, settings: {}, runs: [] } })), 'CUT-02');
    assert.strictEqual(off.status, 'WARNING', 'no interest process but a homeowner ledger: confirm none is due');
  });

  await t('CUT-03: a bill booked in August for service after August is a prepaid candidate (WARNING)', () => {
    const c = by(evaluateClose(input({ prepaid_bills: [bill({ id: 'b2', vendor: 'Insurer', service_period_start: '2026-09-01', service_period_end: '2027-08-31', posting_date: '2026-08-20', total_cents: 3175400 })] })), 'CUT-03');
    assert.strictEqual(c.status, 'WARNING');
    assert.match(c.explanation, /prepaid asset with a recognition schedule/);
  });

  await t('IF-01: Due To / Due From mirror (Canyon Gate 9/30 shape) PASS; a one-sided entry BLOCKs; incomplete accounts WARN', () => {
    const ok = by(evaluateClose(input()), 'IF-01');
    assert.strictEqual(ok.status, 'PASS'); assert.match(ok.explanation, /Reserve owes Operating \$20,593\.64 \(each side agrees\)/);
    const bad = by(evaluateClose(input({}, { applies: true, pairs: [{ fund_code: 'RES', fund_name: 'Reserve', fund_owes_operating_cents: 2059364, operating_owed_cents: 2000000 }], unresolved: [] })), 'IF-01');
    assert.strictEqual(bad.status, 'BLOCK'); assert.match(bad.action, /Do not post to make it tie/);
    assert.strictEqual(by(evaluateClose(input({}, { applies: true, pairs: [], unresolved: ['AAS'] })), 'IF-01').status, 'WARNING');
  });

  await t('DATA-03: a schedule on an account never vouches for an unrelated balance in it (Canyon Gate 1410 shape)', () => {
    const run = (b) => by(evaluateClose({ ...input(), recognition: { schedules: [], balance_accounts: [b] } }), 'DATA-03');
    const mixed = run({ account_number: '1410', account_name: 'Prepaid Expenses', gl_balance_cents: 62112 + 217925, has_schedule: true, scheduled_remaining_cents: 217925 });
    assert.strictEqual(mixed.status, 'BLOCK');
    assert.strictEqual(mixed.amount_cents, 62112);
    assert.match(mixed.explanation, /schedules cover \$2,179\.25; unexplained \$621\.12/);
    assert.strictEqual(run({ account_number: '1410', account_name: 'Prepaid Expenses', gl_balance_cents: 217925, has_schedule: true, scheduled_remaining_cents: 217925 }).status, 'PASS', 'fully covered');
    assert.strictEqual(run({ account_number: '1430', account_name: 'Prepaid Vendor Deposits', gl_balance_cents: 427588, has_schedule: false, scheduled_remaining_cents: 0 }).status, 'BLOCK', 'no schedule');
  });

  await t('Kat\'s cutoff review = recorded by Kat AND every cutoff control evaluated', () => {
    const all = P.CUTOFF_CONTROLS.map((code) => ({ code }));
    assert.strictEqual(P.isKatCutoffReview({ run_by: 'Kat (AI accountant) cutoff review, requested by staff@x' }, all), true);
    assert.strictEqual(P.isKatCutoffReview({ run_by: 'Kat (AI accountant), refreshed from Mission Control' }, all), true);
    assert.strictEqual(P.isKatCutoffReview({ run_by: 'staff@bedrocktx.com' }, all), false, 'a person');
    assert.strictEqual(P.isKatCutoffReview({ run_by: 'Katherine Smith' }, all), false, 'not Kat');
    assert.strictEqual(P.isKatCutoffReview({ run_by: 'Kat (AI accountant)' }, all.slice(1)), false, 'old engine');
    assert.match(P.reviewerName('staff@x'), /^Kat \(AI accountant\) cutoff review, requested by staff@x$/);
  });

  await t('only the owner closes, only on Kat\'s review (refused before the database is asked)', async () => {
    let rpcCalled = 0;
    const db = (runRow) => ({ from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: runRow, error: null }) }), rpc: async () => { rpcCalled++; return { data: { status: 'closed' }, error: null }; } });
    const katRun = { id: 'r', run_by: 'Kat (AI accountant) cutoff review', results: P.CUTOFF_CONTROLS.map((code) => ({ code })) };
    await assert.rejects(S.closePeriod(db(katRun), CID, 'p', { run_id: 'r' }, { name: 'admin@x', role: 'admin' }), /only the owner/);
    await assert.rejects(S.closePeriod(db({ ...katRun, run_by: 'egojara@bedrocktx.com' }), CID, 'p', { run_id: 'r' }, { name: 'ed', role: 'owner' }), /cutoff review first/);
    await assert.rejects(S.closePeriod(db(null), CID, 'p', { run_id: 'r' }, { name: 'ed', role: 'owner' }), /cutoff review first/);
    assert.strictEqual(rpcCalled, 0);
    assert.deepStrictEqual(await S.closePeriod(db(katRun), CID, 'p', { run_id: 'r' }, { name: 'ed', role: 'owner' }), { status: 'closed' });
    assert.strictEqual(rpcCalled, 1, 'the owner on Kat\'s review reaches close_period (which re-checks, migration 517)');
  });

  await t('readiness report: exceptions, proposed adjustments (incl. the prepared interest run) and evidence; never "ready" with open items', () => {
    const ev = evaluateClose(input({ late_bills: [bill()], interest: { enabled: true, settings: {}, runs: [interestRun('prepared')] } }));
    const st = { period: { id: 'p8', period_start: '2026-08-01', period_end: '2026-08-31', status: 'open' },
      run: { id: 'run1', run_at: '2026-10-13T15:00:00Z', run_by: 'Kat (AI accountant) cutoff review', engine_version: 'close-b.1', summary: ev.summary },
      results: ev.results.map((r) => ({ ...r, override: null, accepted: r.status === 'WARNING' ? false : null })), events: [] };
    const r = buildReadiness({ community: { id: CID, name: 'Canyon Gate' }, st, openRuns: [interestRun('prepared')] });
    assert.strictEqual(r.verdict, 'not_ready');
    assert.ok(r.review.is_kat_cutoff_review);
    assert.ok(r.exceptions.some((e) => e.code === 'CUT-02' && e.status === 'BLOCK'));
    assert.ok(r.exceptions.some((e) => e.code === 'CUT-01' && e.status === 'WARNING'));
    assert.ok(r.proposed_adjustments.some((a) => a.source === 'CUT-01' && a.posting_date === '2026-08-31'));
    assert.ok(r.proposed_adjustments.some((a) => a.kind === 'interest_run' && /64 owners \$640\.48 ready to post/.test(a.text)));
    assert.ok(r.blockers.some((b) => /BLOCK/.test(b)) && r.blockers.some((b) => /awaiting a decision/.test(b)));
    const html = renderReadinessHtml(r);
    assert.ok(/close readiness/.test(html) && /none posted/.test(html) && /Accrual close policy/.test(html));
    assert.ok(!/—/.test(html), 'no em dashes in the report');
    const none = buildReadiness({ community: { id: CID, name: 'X' }, st: { ...st, run: null, results: [] }, openRuns: [] });
    assert.ok(none.verdict === 'not_ready' && /has not run the cutoff review/.test(none.blockers[0]));
  });

  await t('wired: owner-only close route, Kat review naming, readiness route, UI, and nothing closes a period automatically', () => {
    const api = read('api/close.js');
    assert.ok(/periods\/:pid\/close'[\s\S]{0,200}requireOwner\(req, res\)/.test(api), 'close route requires the owner');
    assert.ok(/periods\/:pid\/readiness'/.test(api));
    assert.ok(/isKatName\(actor\.name\) \? actor\.name : reviewerName\(actor\.name\)/.test(read('lib/close/service.js')));
    const ui = read('public/close.js');
    assert.ok(/const canClose = !isClosed && isOwner && d\.can_close/.test(ui) && /Readiness report/.test(ui));
    // close_period is called from exactly one place: the owner-gated service.
    const callers = [];
    const walk = (d) => { for (const f of fs.readdirSync(path.join(__dirname, '..', d))) { const p = path.join(d, f); const st = fs.statSync(path.join(__dirname, '..', p)); if (st.isDirectory()) { if (!/node_modules|\.git|tests/.test(f)) walk(p); } else if (/\.js$/.test(f) && /'close_period'/.test(read(p))) callers.push(p.replace(/\\/g, '/')); } };
    for (const d of ['lib', 'api', 'scripts']) walk(d);
    assert.deepStrictEqual(callers, ['lib/close/service.js']);
    assert.ok(!/closePeriod|close_period/.test(read('lib/mission_control/operations.js')) && !/closePeriod|close_period/.test(read('lib/accounting/monthly_runs.js')), 'Kat prepares and reviews; she never closes');
    const m = read('migrations/517_close_policy_owner_kat_review.sql');
    assert.ok(/IS DISTINCT FROM 'owner'/.test(m) && /'kat'/.test(m) && /IF-01/.test(m));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
