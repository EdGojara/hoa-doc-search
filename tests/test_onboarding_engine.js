// ============================================================================
// tests/test_onboarding_engine.js  (Issue #15) — Trusted Onboarding Engine, milestone 1
// ----------------------------------------------------------------------------
// Proves, with a fully synthetic Vantaca-layout fixture (no client data; the
// repo is public):
//   - money / artifacts / canonical rows / controls behave strictly (no plugs);
//   - the Vantaca adapter reads every line and reproduces the report's own
//     printed totals, and the provider-agnostic controls tie GL, Balance
//     Sheet, AR aging and the homeowner subledger;
//   - REGRESSION: a normalized GL CSV that dropped rows (the Quail Ridge
//     package defect: ".38" interest and wrapped payment lines) cannot pass;
//     deleting any single GL line from the report text cannot pass either;
//   - the state machine: an agent works one assigned stage only, can never
//     advance a stage or execute, stages can't be skipped, a non-passing stage
//     needs a human waiver, EXECUTE needs a human approval bound to the exact
//     preflight hash;
//   - the write gate refuses every mutation outside EXECUTE, and no onboarding
//     module contains a database write or a database client at all.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseCents, isAmount } = require('../lib/onboarding/money');
const { makeArtifact, verifyArtifact } = require('../lib/onboarding/artifacts');
const { makeRow, DOMAINS } = require('../lib/onboarding/canonical');
const C = require('../lib/onboarding/controls');
const S = require('../lib/onboarding/stages');
const W = require('../lib/onboarding/write_gate');
const E = require('../lib/onboarding/engine');
const adapters = require('../lib/onboarding/adapters');
const PF = require('../lib/onboarding/preflight');

const FX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const fx = (f) => fs.readFileSync(path.join(FX, f));
const tests = []; const check = (n, fn) => tests.push([n, fn]);
const HUMAN = { kind: 'human', id: 'ed' };
const agent = (stage) => ({ kind: 'agent', id: 'claude', assigned_stage: stage });
const COMM = '00000000-0000-4000-8000-0000000000e1';
const TYPES = ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions'];

// Run stages 0-2 over the synthetic fixture. extra: additional { file, type } inputs.
function runFixture({ extra = [], mutate = {} } = {}) {
  let state = S.newBatchState({ batch_code: 'CONV-EX-20260331', community_id: COMM, source_system: 'vantaca' });
  const inputs = [...TYPES.map((t) => ({ file: `${t}.txt`, type: t })), ...extra].map(({ file, type }) => {
    let buf = fx(file); if (mutate[type]) buf = Buffer.from(mutate[type](buf.toString('utf8')));
    return { buffer: buf, meta: { artifact_type: type, filename: file, cutoff_date: '2026-03-31' } };
  });
  const i0 = E.runIntake(state, agent('intake'), inputs);
  state = S.advance(i0.state, HUMAN, 'normalize');
  const n1 = E.runNormalize(state, agent('normalize'), i0.artifacts.map((a, k) => ({ artifact: a, buffer: inputs[k].buffer })));
  return { i0, n1 };
}
const ctl = (list, code) => list.find((c) => c.code === code);

// ---------------------------------------------------------------- primitives
check('money: exact cents; ".38", "(1,234.56)", "$-.35" and "-" read exactly; anything else throws (never a silent zero)', () => {
  assert.strictEqual(parseCents('.38'), 38); assert.strictEqual(parseCents('(1,234.56)'), -123456); assert.strictEqual(parseCents('-.35'), -35);
  assert.strictEqual(parseCents('$41,706.66'), 4170666); assert.strictEqual(parseCents('($9,761.72)'), -976172); assert.strictEqual(parseCents('-'), 0);
  for (const bad of ['', '12', '1.2', 'abc', '1,23.45', '12.345']) assert.throws(() => parseCents(bad), /unreadable amount/, bad);
  assert.ok(isAmount('.38') && !isAmount('Owner'));
});
check('artifacts: hashed and frozen at intake; different bytes later are refused', () => {
  const a = makeArtifact(Buffer.from('original'), { batch_code: 'B', community_id: COMM, source_system: 'Vantaca', artifact_type: 'gl_trial_balance', filename: 'x.txt', cutoff_date: '2026-03-31' });
  assert.ok(Object.isFrozen(a) && a.source_system === 'vantaca' && a.sha256.length === 64);
  assert.throws(() => { 'use strict'; a.sha256 = 'x'; });
  assert.ok(verifyArtifact(a, Buffer.from('original')));
  assert.throws(() => verifyArtifact(a, Buffer.from('tampered')), /artifact_hash_mismatch/);
  assert.throws(() => makeArtifact(Buffer.from('x'), { batch_code: 'B', community_id: COMM, source_system: 'v', artifact_type: 't', filename: 'f' }), /cutoff/);
});
check('canonical rows: provenance (artifact sha, locator, raw) is mandatory; amounts must be integer cents; dates ISO', () => {
  const prov = { artifact_sha256: 'a'.repeat(64), locator: { line: 3 }, raw: 'raw line' };
  const r = makeRow('gl_transaction', { account_code: '1000', date: '2026-01-15', debit_cents: 30000, credit_cents: 0 }, prov);
  assert.ok(Object.isFrozen(r) && r.provenance.locator.line === 3);
  assert.throws(() => makeRow('gl_transaction', { account_code: '1000', date: '2026-01-15' }, { artifact_sha256: 'a' }), /provenance/);
  assert.throws(() => makeRow('gl_transaction', { account_code: '1000', date: '2026-01-15', debit_cents: 300.5 }, prov), /integer cents/);
  assert.throws(() => makeRow('gl_transaction', { account_code: '1000', date: '1/15/2026' }, prov), /YYYY-MM-DD/);
  for (const d of ['properties', 'property', 'owner', 'ownership_period', 'homeowner_txn', 'gl_account_balance', 'ar_aging_account', 'ap_open_item', 'bank_balance', 'prepaid_credit', 'vendor', 'assessment_schedule']) if (d !== 'properties') assert.ok(DOMAINS[d], d);
});
check('controls: PASS / FAIL / BLOCKED; no plug possible: a tolerance must be declared with a reason and is recorded', () => {
  assert.strictEqual(C.equals('x', { label: 'x', left: 100, right: 100 }).status, 'PASS');
  const f = C.equals('x', { label: 'x', left: 100, right: 99 }); assert.strictEqual(f.status, 'FAIL'); assert.strictEqual(f.difference_cents, 1);
  assert.strictEqual(C.equals('x', { label: 'x', left: null, right: 99 }).status, 'BLOCKED');
  assert.throws(() => C.equals('x', { label: 'x', left: 100, right: 99, tolerance_cents: 1 }), /declared reason/);
  const t = C.equals('x', { label: 'x', left: 100, right: 99, tolerance_cents: 1, tolerance_reason: 'source rounds to the dollar' });
  assert.strictEqual(t.status, 'PASS'); assert.strictEqual(t.tolerance_reason, 'source rounds to the dollar');
  assert.deepStrictEqual(C.summarize([f, t]).counts, { PASS: 1, FAIL: 1, BLOCKED: 0 });
  assert.ok(!('plug' in C) && !Object.keys(C).some((k) => /plug|balanc|force/i.test(k)));
});
check('adapter interface: Vantaca registered; an adapter missing parse/controls is refused; adapters take no DB client', () => {
  assert.ok(adapters.providers().includes('vantaca'));
  assert.throws(() => adapters.register({ provider: 'x', version: '1', artifact_types: ['a'] }), /missing parse/);
  assert.throws(() => adapters.get('cinc'), /no adapter/);
  const v = adapters.get('VANTACA'); assert.ok(v.parse.length <= 4);
});

// ---------------------------------------------------------------- Vantaca adapter on the synthetic fixture
check('Vantaca adapter: every line read; GL, aging, ledger and Balance Sheet each reproduce their own printed totals', () => {
  const { n1 } = runFixture();
  const bad = n1.extraction.filter((c) => c.status !== 'PASS'); assert.deepStrictEqual(bad.map((c) => c.code), []);
  const tx = n1.parsed.gl_trial_balance.rows.filter((r) => r.domain === 'gl_transaction');
  assert.strictEqual(tx.length, 20, 'GL lines incl. .38/.35 interest, wrapped and page-split lines');
  const wrapped = tx.find((r) => r.ledger_id === '4002' && r.account_code === '1000');
  assert.ok(/example\.owner\.two@example\.test/.test(wrapped.description), 'wrapped description joined');
  const addr = tx.find((r) => r.description.startsWith('101 Example Lane: Late Fees') && r.account_code === '1300');
  assert.strictEqual(addr.ledger_id, null, 'a street number is not a ledger id');
  assert.strictEqual(tx.find((r) => r.account_code === '1100' && r.ledger_id === '6001').debit_cents, 38);
  assert.ok(tx.every((r) => r.provenance.artifact_sha256 && r.provenance.locator.line > 0 && r.provenance.raw));
  assert.strictEqual(n1.result.status, 'PASS');
});
check('source controls: GL debits = credits, A = L + E, every BS line = GL (3000 by the Vantaca display rule), AR / aging / ledger tie, credits = prepaid', () => {
  const { n1 } = runFixture();
  let state = S.advance(n1.state, HUMAN, 'source_controls');
  const s2 = E.runSourceControls(state, agent('source_controls'), n1.parsed, { roles: { ar_account: '1300', prepaid_account: '2400' },
    expected: { ar: { label: 'AR = 510.00', cents: 51000, derive: (p, { glEnd }) => glEnd('1300') }, debits: { label: 'GL debits = 1,385.73', cents: 138573, derive: (p, { bal }) => bal.reduce((s, r) => s + r.debit_cents, 0) } } });
  assert.deepStrictEqual(s2.controls.filter((c) => c.status !== 'PASS').map((c) => c.code), []);
  const eq = ctl(s2.controls, 'vantaca.bs_vs_gl.3000'); assert.strictEqual(eq.detail.gl_carried_cents, 340000); assert.strictEqual(eq.detail.current_period_result_cents, 46073);
  assert.strictEqual(ctl(s2.controls, 'subledger.debit_balances_equal_gl_ar').left_cents, 51000);
  assert.strictEqual(ctl(s2.controls, 'subledger.credit_balances_equal_gl_prepaid').left_cents, 8500);
  assert.strictEqual(s2.result.status, 'PASS');
  state = S.advance(s2.state, HUMAN, 'snapshot');
  assert.strictEqual(state.stage, 'snapshot');
});
check('REGRESSION (Quail Ridge package defect): a normalized GL CSV that dropped the ".38" interest and wrapped payment rows cannot pass', () => {
  const { n1 } = runFixture({ extra: [{ file: 'gl_transactions_defective.csv', type: 'gl_transactions_csv' }] });
  const c = ctl(n1.extraction, 'gl_transactions_csv.ties_to_printed_account_totals');
  assert.strictEqual(c.status, 'FAIL');
  assert.deepStrictEqual(c.failures.map((f) => f.account).sort(), ['1000', '1100', '1300', '4100']);
  const f1100 = c.failures.find((f) => f.account === '1100'); assert.strictEqual(f1100.parsed_debit_cents, 0); assert.strictEqual(f1100.printed_debit_cents, 73);
  assert.strictEqual(n1.result.status, 'FAIL');
  let code = null; try { S.advance(n1.state, HUMAN, 'source_controls'); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'CURRENT_STAGE_NOT_PASSING', 'an extraction defect blocks the batch');
});
check('REGRESSION: deleting ANY single transaction line from the GL report text fails extraction controls', () => {
  const text = fx('gl_trial_balance.txt').toString('utf8');
  const L = text.split('\n'); const dataLines = L.map((l, i) => (/^\s+\d{2}\/\d{2}\/\d{4}\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(dataLines.length, 20);
  for (const drop of dataLines) {
    const { n1 } = runFixture({ mutate: { gl_trial_balance: () => L.filter((_, i) => i !== drop).join('\n') } });
    assert.strictEqual(ctl(n1.extraction, 'gl.transactions_tie_to_printed_account_totals').status, 'FAIL', `dropping line ${drop + 1} passed`);
  }
});
check('REGRESSION: a garbled data line is a recorded defect (never silently skipped); a garbled amount throws', () => {
  const { n1 } = runFixture({ mutate: { gl_trial_balance: (t) => t.replace('  02/27/2026         6002       February Interest                                                      .35', '  02/27/2026         6002       February Interest                                                      ?.35') } });
  assert.strictEqual(ctl(n1.extraction, 'gl_trial_balance.no_unreadable_lines').status, 'FAIL');
  assert.strictEqual(n1.result.status, 'FAIL');
});
check('source controls: a subledger that does not tie to GL AR FAILS with the difference; a missing artifact is BLOCKED', () => {
  const { n1 } = runFixture({ mutate: { homeowner_transactions: (t) => t.replace('$10.00       $0.00              $210.00', '$10.00       $0.00              $215.00') } });
  assert.strictEqual(ctl(n1.extraction, 'ledger.day_end_balances_follow').status, 'FAIL');
  const parsed = { ...n1.parsed }; delete parsed.ar_aging;
  const r = require('../lib/onboarding/source_controls').sourceControls(parsed, { roles: { ar_account: '1300', prepaid_account: '2400' } });
  assert.strictEqual(ctl(r, 'subledger.debit_balances_equal_gl_ar').difference_cents, 500);
  assert.strictEqual(ctl(r, 'ar_aging.total_equals_gl_ar').status, 'BLOCKED');
  assert.strictEqual(ctl(require('../lib/onboarding/source_controls').sourceControls(parsed, {}), 'subledger.ar').status, 'BLOCKED');
});

// ---------------------------------------------------------------- state machine + gates
check('stages: an agent works only its assigned stage, only while the batch is in it; it can never advance or execute', () => {
  const st = S.newBatchState({ batch_code: 'B', community_id: COMM, source_system: 'vantaca' });
  assert.throws(() => S.assertPermitted(st, agent('normalize'), 'register_artifact'), /AGENT_OUTSIDE_ASSIGNED_STAGE|cannot act/);
  assert.throws(() => S.assertPermitted(st, { kind: 'agent', id: 'c' }, 'register_artifact'), /AGENT_NEEDS_ASSIGNED_STAGE/);
  assert.throws(() => S.assertPermitted(st, agent('intake'), 'run_adapter'), /not permitted in stage intake/);
  const done = S.completeStage(st, agent('intake'), { status: 'PASS' });
  assert.strictEqual(done.stage, 'intake', 'completing a stage never moves the batch');
  assert.throws(() => S.advance(done, agent('intake'), 'normalize'), (e) => e.code === 'ADVANCE_REQUIRES_HUMAN');
  assert.deepStrictEqual(S.permittedActions(done, agent('normalize')), []);
  const ex = { ...done, stage: 'execute' };
  assert.throws(() => S.assertPermitted(ex, agent('execute'), 'execute_batch'), (e) => e.code === 'AGENT_CANNOT_EXECUTE');
});
check('stages: no skipping; the current stage must be complete; a non-passing stage needs a human waiver per control (with a reason)', () => {
  let st = S.newBatchState({ batch_code: 'B', community_id: COMM, source_system: 'vantaca' });
  assert.throws(() => S.advance(st, HUMAN, 'normalize'), (e) => e.code === 'CURRENT_STAGE_NOT_COMPLETE');
  st = S.completeStage(st, HUMAN, { status: 'PASS' });
  assert.throws(() => S.advance(st, HUMAN, 'source_controls'), (e) => e.code === 'STAGE_SKIP_REFUSED');
  st = S.advance(st, HUMAN, 'normalize');
  st = S.completeStage(st, HUMAN, { status: 'FAIL', open_controls: ['gl.x'] });
  assert.throws(() => S.advance(st, HUMAN, 'source_controls'), (e) => e.code === 'CURRENT_STAGE_NOT_PASSING');
  assert.throws(() => S.waiveControl(st, agent('normalize'), 'gl.x', 'agent wants to move on'), (e) => e.code === 'WAIVER_REQUIRES_HUMAN');
  assert.throws(() => S.waiveControl(st, HUMAN, 'gl.x', 'ok'), (e) => e.code === 'WAIVER_REASON_REQUIRED');
  st = S.waiveControl(st, HUMAN, 'gl.x', 'source report known to omit zero lines; reviewed');
  assert.strictEqual(S.advance(st, HUMAN, 'source_controls').stage, 'source_controls');
});
check('EXECUTE requires a human approval bound to the exact preflight hash, with every control passing or waived', () => {
  let st = S.newBatchState({ batch_code: 'B', community_id: COMM, source_system: 'vantaca' });
  for (const to of ['normalize', 'source_controls', 'snapshot', 'activity_bridge', 'preflight']) { st = S.completeStage(st, HUMAN, { status: 'PASS' }); st = S.advance(st, HUMAN, to); }
  const art = [{ filename: 'gl.txt', artifact_type: 'gl_trial_balance', sha256: 'b'.repeat(64), bytes: 10 }];
  const failing = PF.buildPreflight({ batch: { batch_code: 'B', community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: '2026-03-31' }, artifacts: art, controls: [C.equals('gl.x', { label: 'x', left: 1, right: 2 })] });
  assert.throws(() => S.approvePreflight(st, agent('preflight'), failing), (e) => e.code === 'APPROVAL_REQUIRES_HUMAN');
  assert.throws(() => S.approvePreflight(st, HUMAN, failing), (e) => e.code === 'CONTROLS_NOT_PASSING');
  const good = PF.buildPreflight({ batch: { batch_code: 'B', community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: '2026-03-31' }, artifacts: art, controls: [C.equals('gl.x', { label: 'x', left: 2, right: 2 })] });
  st = S.completeStage(st, HUMAN, { status: 'PASS', preflight_sha256: good.sha256 });
  assert.throws(() => S.advance(st, HUMAN, 'execute'), (e) => e.code === 'EXECUTE_REQUIRES_APPROVAL');
  const other = S.approvePreflight(st, HUMAN, { ...good, sha256: 'c'.repeat(64) });
  assert.throws(() => S.advance(other, HUMAN, 'execute'), (e) => e.code === 'APPROVAL_DOES_NOT_MATCH_PREFLIGHT');
  st = S.approvePreflight(st, HUMAN, good);
  const ex = S.advance(st, HUMAN, 'execute');
  assert.strictEqual(ex.stage, 'execute'); assert.strictEqual(ex.write_lock, false);
  assert.ok(ex.events.some((e) => e.type === 'preflight_approved' && e.preflight_sha256 === good.sha256));
});
check('write gate: the read-only client refuses insert/update/upsert/delete, rpc and storage writes before any request; reads pass through', () => {
  let calls = 0;
  const fakeBuilder = { select: () => { calls++; return 'read'; }, insert: () => { calls++; }, update: () => { calls++; }, upsert: () => { calls++; }, delete: () => { calls++; } };
  const fake = { from: () => fakeBuilder, rpc: () => { calls++; }, storage: { from: () => ({ download: () => 'bytes', upload: () => { calls++; }, remove: () => { calls++; } }) } };
  const ro = W.readOnlyClient(fake);
  assert.strictEqual(ro.from('journal_entries').select('*'), 'read'); calls = 0;
  for (const m of ['insert', 'update', 'upsert', 'delete']) assert.throws(() => ro.from('journal_entries')[m]({}), (e) => e.code === 'WRITE_BLOCKED', m);
  assert.throws(() => ro.rpc('post_journal_entry', {}), (e) => e.code === 'WRITE_BLOCKED');
  assert.throws(() => ro.storage.from('documents').upload('x', Buffer.from('')), (e) => e.code === 'WRITE_BLOCKED');
  assert.throws(() => ro.storage.from('documents').remove(['x']), (e) => e.code === 'WRITE_BLOCKED');
  assert.strictEqual(ro.storage.from('documents').download('x'), 'bytes');
  assert.strictEqual(calls, 0, 'no mutation reached the client');
  const st = S.newBatchState({ batch_code: 'B', community_id: COMM, source_system: 'vantaca' });
  assert.throws(() => W.writeClientFor(st, fake, { preflight_sha256: 'x' }), (e) => e.code === 'WRITE_LOCKED');
  assert.throws(() => W.writeClientFor({ ...st, stage: 'execute', write_lock: false, approval: { preflight_sha256: 'a' } }, fake, { preflight_sha256: 'b' }), (e) => e.code === 'APPROVAL_DOES_NOT_MATCH_PREFLIGHT');
});
check('static: no onboarding module writes to the database, holds a client, or calls apply/post helpers (only the gate module names the mutators)', () => {
  const root = path.join(__dirname, '..', 'lib', 'onboarding');
  const files = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } })(root);
  assert.ok(files.length >= 12, String(files.length));
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/@supabase\/supabase-js|createClient\(|require\(['"][^'"]*(supabase|db\/|journal|ar_engine|ap_engine)[^'"]*['"]\)/.test(s), `${path.basename(f)} imports a DB client or posting module`);
    if (path.basename(f) === 'write_gate.js') continue;
    // .update( on a hash (crypto) is not a DB write; a DB update takes a row object
    assert.ok(!/\.(insert|upsert|delete|rpc)\s*\(|\.update\s*\(\s*\{/.test(s), `${path.basename(f)} calls a database mutator`);
  }
});
check('preflight: canonical JSON hash; any edit breaks verification; all required sections; markdown renders', () => {
  const { n1 } = runFixture();
  const r = PF.buildPreflight({ batch: { batch_code: 'CONV-EX-20260331', community_id: COMM, source_system: 'vantaca', stage: 'preflight' }, source_cutoff: { cutoff_date: '2026-03-31', period_start: '2026-01-01', period_end: '2026-03-31' },
    artifacts: [{ filename: 'gl_trial_balance.txt', artifact_type: 'gl_trial_balance', sha256: 'd'.repeat(64), bytes: 1 }], normalization: n1.normalization, controls: n1.extraction,
    proposed_writes: [], rollback: 'nothing written', idempotency: { batch_code: 'CONV-EX-20260331', row_key: '<batch>:<artifact sha256>:<line>' } });
  assert.strictEqual(r.format, 'trusted.onboarding.preflight/v1');
  for (const k of PF.SECTIONS) assert.ok(k in r, k);
  assert.ok(PF.verifyPreflight(r));
  assert.ok(!PF.verifyPreflight({ ...r, proposed_writes: [{ table: 'journal_entries', action: 'insert', count: 1 }] }), 'tampered report must not verify');
  const md = PF.renderMarkdown(r); assert.ok(/# Preflight: CONV-EX-20260331/.test(md) && /Controls: PASS/.test(md) && /this report authorizes no writes/.test(md));
});

let pass = 0, fail = 0;
console.log('Trusted Onboarding Engine — milestone 1 (Issue #15)');
for (const [n, fn] of tests) { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
