// tests/test_owner_run_authorization.js — owner-authorized, agent-executed accounting runs (mig 566).
// A package is verified before it is offered (prepared, balanced, not already posted, no look-alike
// posted entry, nothing blocking); one request covers several runs; execution posts each run only
// through the owner_authorization channel and closes the authorization only when every run posted.
// The in-app path is unchanged and HTTP can never pass the delegated channel.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../lib/accounting/owner_run_authorization');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const line = (a, dr, cr) => ({ account_number: a, debit_cents: dr || 0, credit_cents: cr || 0 });
const jeRun = (over = {}) => ({ id: 'r1', community_id: 'c1', process: 'journal_entry', period_month: '2026-08-01', status: 'prepared', exceptions: [],
  preview: { items: [{ id: 'e1', label: 'Reclass $1', amount_cents: 100, entries: [{ posting_date: '2026-08-01', source_reference: 'KATJE:c1:e1', lines: [line('3050', 100), line('3000', 0, 100)] }] }] }, ...over });
const none = { sourceRefs: new Set(), similar: () => [] };

check('a clean journal-entry run verifies; units carry its exact lines', () => {
  const v = O.verifyRun(jeRun(), ['e1'], none);
  assert.strictEqual(v.ok, true, v.problems.join());
  assert.strictEqual(v.units.length, 1); assert.strictEqual(v.units[0].entries[0].lines.length, 2);
});

check('refused: unbalanced, already in the GL, look-alike posted entry, blocking, not prepared, unknown item', () => {
  const unbal = jeRun({ preview: { items: [{ id: 'e1', label: 'x', entries: [{ posting_date: '2026-08-01', lines: [line('3050', 100), line('3000', 0, 90)] }] }] } });
  assert.match(O.verifyRun(unbal, ['e1'], none).problems.join(), /does not balance/);
  assert.match(O.verifyRun(jeRun(), ['e1'], { sourceRefs: new Set(['KATJE:c1:e1']), similar: () => [] }).problems.join(), /already in the GL/);
  assert.match(O.verifyRun(jeRun(), ['e1'], { sourceRefs: new Set(), similar: () => ['JE-2026-00393'] }).problems.join(), /possible duplicate/);
  assert.match(O.verifyRun(jeRun({ exceptions: [{ severity: 'blocking', text: 'nope' }] }), ['e1'], none).problems.join(), /blocking/);
  assert.match(O.verifyRun(jeRun({ exceptions: [{ code: 'period_closed', text: 'closed' }] }), ['e1'], none).problems.join(), /blocking/);
  assert.match(O.verifyRun(jeRun({ status: 'posted' }), ['e1'], none).problems.join(), /not prepared/);
  assert.match(O.verifyRun(jeRun(), ['zz'], none).problems.join(), /not in this run/);
});

check('duplicate signature includes direction: a reversal is not a copy', () => {
  const a = [line('5110', 500), line('2000', 0, 500)]; const rev = [line('5110', 0, 500), line('2000', 500)];
  assert.notStrictEqual(O.netSig(a), O.netSig(rev)); assert.strictEqual(O.netSig(a), O.netSig([line('2000', 0, 500), line('5110', 300), line('5110', 200)]));
});

check('bank reconciliation proposals, cutoff additions and account reviews are selected correctly', () => {
  const bank = { id: 'b', community_id: 'c1', process: 'bank_reconciliation', status: 'prepared', exceptions: [{ severity: 'open', text: 'old check' }],
    preview: { proposals: [{ id: 'p1', description: 'Interest', amount_cents: 56062, posting_date: '2026-09-30', source_reference: 'BR:p1', lines: [line('1110', 56062), line('4120', 0, 56062)] }] } };
  const v = O.verifyRun(bank, ['p1'], none);
  assert.ok(v.ok); assert.strictEqual(v.units[0].id, 'p1'); assert.match(v.notes.join(), /open item/);
  assert.deepStrictEqual(O.allIds(bank), ['p1']);
  const cut = { id: 'c', community_id: 'c1', process: 'cutoff_adjustment', status: 'prepared', exceptions: [], preview: { additions: [{ id: 'account:2100', text: 'Add GL 2100' }], items: [{ id: 'accrue:1', label: 'Lake Pro', entries: [{ posting_date: '2026-09-30', lines: [line('5140', 5), line('2100', 0, 5)] }] }] } };
  assert.deepStrictEqual(O.allIds(cut), ['account:2100', 'accrue:1']);
  assert.ok(O.verifyRun(cut, O.allIds(cut), none).ok);
  const rec = { id: 'a', community_id: 'c1', process: 'account_reconciliation', status: 'prepared', exceptions: [], preview: {} };
  assert.match(O.verifyRun(rec, [], none).notes.join(), /nothing posts/);
});

check('the request email lists every run and its exact lines, and authorizes nothing else', () => {
  const v = O.verifyRun(jeRun(), ['e1'], none);
  const m = O.renderPackage({ subject: 'Owner authorization ABCD1234: 1 accounting run (LOPF)', verified: [{ run: jeRun(), include: ['e1'], ...v }], communityNames: { c1: 'LOPF' }, expiresAt: '2026-11-20 22:00 UTC' });
  assert.match(m.text, /Reply "approved" to authorize exactly the runs and entries below/);
  assert.match(m.text, /3050  Dr \$1\.00/); assert.match(m.text, /3000  Cr \$1\.00/);
  assert.match(m.text, /If any run changes before then, it is not posted/);
});

check('execution: each run through the owner_authorization channel; closed only when every run posted', async () => {
  const calls = []; const rpcCalls = [];
  const status = { r1: 'posted', r2: 'failed' };
  const supabase = { from: () => ({ select: () => ({ eq: (_c, id) => ({ single: async () => ({ data: { status: status[id], result: { posted_entries: [1] } }, error: null }) }) }) }) };
  const auth = { id: 'a1', subject: 's', items: [{ run_id: 'r1', process: 'journal_entry' }, { run_id: 'r2', process: 'cutoff_adjustment' }] };
  const approveAndPost = async (_s, args) => { calls.push(args); if (args.run_id === 'r2') throw new Error('changed after the owner authorized it'); return {}; };
  const out = await O.executePackage({ supabase, rpc: async (n, a) => rpcCalls.push([n, a]), authorization: auth, approveAndPost });
  assert.deepStrictEqual(calls.map((c) => c.approval), [{ channel: 'owner_authorization', authorization_id: 'a1' }, { channel: 'owner_authorization', authorization_id: 'a1' }]);
  assert.strictEqual(out.posted, 1); assert.strictEqual(out.failed, 1);
  assert.strictEqual(rpcCalls.length, 0, 'not marked executed while a run failed');
  status.r2 = 'posted';
  const out2 = await O.executePackage({ supabase, rpc: async (n, a) => rpcCalls.push([n, a]), authorization: { ...auth, items: [auth.items[0]] }, approveAndPost });
  assert.strictEqual(out2.failed, 0); assert.strictEqual(rpcCalls[0][0], 'owner_authorization_mark_executed');
});

check('the completion note counts a journal-entry run’s posted entries (result.posted) and a bank run’s (result.posted_entries)', async () => {
  const res = { r1: { posted: [{ reference: 'JE-1' }] }, r2: { posted_entries: [1, 2] } };
  const supabase = { from: () => ({ select: () => ({ eq: (_c, id) => ({ single: async () => ({ data: { status: 'posted', result: res[id] }, error: null }) }) }) }) };
  const out = await O.executePackage({ supabase, rpc: async () => {}, authorization: { id: 'a1', subject: 's', items: [{ run_id: 'r1', process: 'journal_entry' }, { run_id: 'r2', process: 'bank_reconciliation' }] }, approveAndPost: async () => ({}) });
  assert.deepStrictEqual(out.results.map((r) => r.posted_entries), [1, 2]);
});

check('wiring: delegated approval only via the database check; in-app path unchanged; HTTP cannot pass the delegated channel; Tessa executes', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const mr = read('lib/accounting/monthly_runs.js');
  assert.ok(mr.includes("let approver = (delegated || granted) ? null : assertInAppApproval(approval);"));
  assert.ok(mr.includes("supabase.rpc('accounting_run_approve_delegated'"), 'the database decides');
  assert.ok(/channel: 'in_app', user_id: approval\.user_id/.test(mr), 'in-app approval event unchanged');
  const api = read('api/accounting_runs.js');
  assert.ok(/approval: \{ channel: 'in_app', user_id: u\.user && u\.user\.id, email: u\.email \}/.test(api) && !/owner_authorization/.test(api), 'the HTTP route builds an in-app approval only');
  const t = read('lib/ea/tessa_inbox.js');
  // Tessa executes an authorized run package through the shared dispatcher (lib/authorization, Ed 2026-11-25),
  // whose accounting-run adapter calls ORA.executePackage exactly as before.
  assert.ok(t.includes("AZ.executeAuthorized(ctx, auth, { channel: 'email' })") && t.includes("if (auth.scope === 'accounting_runs')") && t.includes('ORA.renderCompletion(auth, out.raw)'), 'Tessa executes an authorized package through the dispatcher and reports once');
  assert.ok(read('lib/authorization/actions.js').includes('ORA.executePackage({ supabase: ctx.supabase, rpc: ctx.rpc, authorization'), 'the accounting-run adapter posts through executePackage');
  const mig = read('migrations/566_owner_authorized_accounting_runs.sql');
  for (const s of ["scope IN ('conversion_objects', 'accounting_runs')", 'changed after the owner authorized it', "a.status <> 'authorized'", 'now() > a.expires_at', "'executed_by', p_agent_id"]) assert.ok(mig.includes(s), s);
});

check('execution grant (mig 567): owner-only issue/revoke; instruction recorded; verified first; never payments', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const mr = read('lib/accounting/monthly_runs.js');
  assert.ok(mr.includes("const granted = !!(approval && approval.channel === 'owner_grant');"));
  assert.ok(mr.indexOf('OR.verifyPackage(supabase, [{ run_id, include: inc }])') < mr.indexOf("supabase.rpc('accounting_run_execute_under_grant'"), 'verified before the database approves');
  assert.ok(mr.includes("an execution grant and the owner's exact instruction are required"));
  const api = read('api/accounting_runs.js');
  for (const r of ["router.post('/grants'", "router.post('/grants/:id/revoke'", "router.get('/grants'"]) { const i = api.indexOf(r); assert.ok(i > 0, r); assert.ok(api.slice(i, i + 200).includes('requireOwner'), r + ' is owner-only'); }
  const mig = read('migrations/567_owner_execution_grants.sql');
  assert.ok(mig.includes("processes <@ ARRAY['journal_entry', 'cutoff_adjustment', 'reclassification', 'bank_reconciliation', 'account_reconciliation']"), 'only accounting runs; never payments or vendor bank details');
  assert.ok(api.includes("if (active && active.length) return res.json({ grant: active[0], existing: true });"), 'one active grant per community');
  assert.ok(read('public/ed.html').includes('if(_issuingGrant) return;'), 'the Issue button ignores repeat clicks while issuing');
  assert.ok(mig.includes("expires_at <= issued_at + interval '24 hours'") && mig.includes("'instruction', p_instruction") && mig.includes('per-run ceiling'));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
