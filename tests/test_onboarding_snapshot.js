// ============================================================================
// tests/test_onboarding_snapshot.js  (Issue #15 Milestone 3) — Conversion Snapshot
// ----------------------------------------------------------------------------
// Synthetic Vantaca fixture only (no client data). Proves the snapshot:
//   - proposes GL opening balances equal to the source ending TB, balanced;
//   - carries homeowner AR (with aging charge detail) and credit detail that
//     support the GL controls exactly when the source supports them;
//   - when detail is missing or short, blocks ONLY that component, keeps the
//     validated GL control balance, and reports the unsupported remainder as
//     its own line that names nobody (no plug, no inferred owner);
//   - AP is BLOCKED (control kept) without an AP source;
//   - every line carries batch / cutoff identity and source provenance;
//   - dated sources must be as of the cutoff;
//   - is deterministic (same input -> same sha256; any change -> new sha256);
//   - the snapshot module cannot touch a database.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../lib/onboarding/engine');
const S = require('../lib/onboarding/stages');
const { makeArtifact } = require('../lib/onboarding/artifacts');
const { buildSnapshot } = require('../lib/onboarding/snapshot');

const FX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const TYPES = ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions'];
const parse = (types = TYPES) => E.normalize('vantaca', types.map((t) => { const buffer = fs.readFileSync(path.join(FX, `${t}.txt`)); return { artifact: makeArtifact(buffer, { batch_code: 'CONV-EX-20260331', community_id: 'c', source_system: 'vantaca', artifact_type: t, filename: `${t}.txt`, cutoff_date: '2026-03-31' }), buffer }; })).parsed;
const ID = { batch_code: 'CONV-EX-20260331', cutoff_date: '2026-03-31' };
const ROLES = { ar_account: '1300', prepaid_account: '2400' };
const ctl = (s, code) => s.controls.find((c) => c.code === code);
const comp = (s, name) => s.components.find((c) => c.component === name);
const kind = (s, k) => s.lines.filter((l) => l.kind === k);
const total = (rows) => rows.reduce((t, l) => t + l.amount_cents, 0);
const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('balanced source: GL lines = source ending TB, debits = credits; AR and credits fully supported; AR detail = aging by account', () => {
  const s = buildSnapshot(parse(), { ...ID, roles: ROLES });
  const gl = kind(s, 'gl_opening_balance');
  assert.strictEqual(gl.length, 9);
  assert.strictEqual(total(gl), 0);
  assert.strictEqual(gl.find((l) => l.account_code === '1000').amount_cents, 143500);
  for (const k of ['snapshot.gl_lines_equal_source_ending_tb', 'snapshot.gl_opening_balances_balance', 'snapshot.sources_as_of_cutoff', 'snapshot.ar_detail_supports_gl', 'snapshot.prepaid_detail_supports_gl', 'snapshot.ar_detail_matches_aging_by_account', 'snapshot.every_line_has_provenance']) assert.strictEqual(ctl(s, k).status, 'PASS', k);
  assert.deepStrictEqual([comp(s, 'ar_detail').status, comp(s, 'ar_detail').supported_cents, comp(s, 'ar_detail').unsupported_cents], ['PASS', 51000, 0]);
  assert.deepStrictEqual([comp(s, 'prepaid_detail').status, comp(s, 'prepaid_detail').supported_cents, comp(s, 'prepaid_detail').unsupported_cents], ['PASS', -8500, 0]);
  assert.deepStrictEqual(kind(s, 'ar_detail').map((l) => [l.source_account_key, l.amount_cents]), [['90000001', 21000], ['90000002', 30000]]);
  assert.strictEqual(kind(s, 'ar_aging_item').length, 3);
  assert.strictEqual(kind(s, 'unsupported_detail').length, 0);
});
check('AP: without an AP account or source the component is BLOCKED (never silently skipped); with an account but no AP aging the control balance is kept and reported unsupported', () => {
  const s = buildSnapshot(parse(), { ...ID, roles: ROLES });
  assert.strictEqual(comp(s, 'ap_detail').status, 'BLOCKED'); assert.strictEqual(ctl(s, 'snapshot.ap_detail_supports_gl').status, 'BLOCKED');
  const s2 = buildSnapshot(parse(), { ...ID, roles: { ...ROLES, ap_account: '2400' } });   // any account with a balance, to exercise the path
  const ap = comp(s2, 'ap_detail');
  assert.deepStrictEqual([ap.status, ap.control_cents, ap.supported_cents, ap.unsupported_cents], ['BLOCKED', -8500, 0, -8500]);
  assert.ok(kind(s2, 'unsupported_detail').some((l) => l.component === 'ap_detail' && l.amount_cents === -8500));
});
check('missing subsidiary detail: no homeowner ledger -> AR and prepaid BLOCKED with the whole control unsupported; GL still proposed exactly as the source', () => {
  const s = buildSnapshot(parse(['gl_trial_balance', 'balance_sheet', 'ar_aging']), { ...ID, roles: ROLES });
  assert.strictEqual(ctl(s, 'snapshot.gl_lines_equal_source_ending_tb').status, 'PASS');
  assert.strictEqual(kind(s, 'gl_opening_balance').find((l) => l.account_code === '1300').amount_cents, 51000);
  assert.deepStrictEqual([comp(s, 'ar_detail').status, comp(s, 'ar_detail').unsupported_cents], ['BLOCKED', 51000]);
  assert.deepStrictEqual([comp(s, 'prepaid_detail').status, comp(s, 'prepaid_detail').unsupported_cents], ['BLOCKED', -8500]);
  assert.strictEqual(kind(s, 'ar_detail').length + kind(s, 'prepaid_detail').length, 0, 'no owner detail invented');
});
check('short prepaid detail (the Quail Ridge shape): supported part kept per account, remainder is ONE unsupported line naming nobody; no plug, no assignment', () => {
  const parsed = parse();
  // remove the credit account from the subledger: the GL 2400 balance is now only partly (here: not at all) supported
  const p2 = { ...parsed, homeowner_transactions: { ...parsed.homeowner_transactions, rows: parsed.homeowner_transactions.rows.filter((r) => r.source_account_key !== '90000003') } };
  const s = buildSnapshot(p2, { ...ID, roles: ROLES });
  const c = comp(s, 'prepaid_detail');
  assert.deepStrictEqual([c.status, c.control_cents, c.supported_cents, c.unsupported_cents], ['BLOCKED', -8500, 0, -8500]);
  const u = kind(s, 'unsupported_detail');
  assert.strictEqual(u.length, 1); assert.strictEqual(u[0].amount_cents, -8500); assert.strictEqual(u[0].source_account_key, undefined, 'never assigned to an owner');
  assert.strictEqual(kind(s, 'gl_opening_balance').find((l) => l.account_code === '2400').amount_cents, -8500, 'validated control balance kept');
  assert.notStrictEqual(total(kind(s, 'prepaid_detail')), -8500, 'detail is NOT forced to the control');
  const k = ctl(s, 'snapshot.prepaid_detail_supports_gl');
  assert.strictEqual(k.status, 'BLOCKED'); assert.strictEqual(k.difference_cents, -8500); assert.ok(/prepaid_credit_report/.test(k.needs.join()));
  assert.strictEqual(ctl(s, 'snapshot.ar_detail_supports_gl').status, 'PASS', 'only the affected component is blocked');
});
check('every line has batch / cutoff identity and source provenance (artifact sha + locator)', () => {
  const s = buildSnapshot(parse(), { ...ID, roles: ROLES });
  assert.ok(s.lines.length > 10);
  for (const l of s.lines) { assert.strictEqual(l.batch_code, ID.batch_code); assert.strictEqual(l.cutoff_date, ID.cutoff_date); assert.ok(l.provenance.length && l.provenance.every((p) => /^[0-9a-f]{64}$/.test(p.artifact_sha256) && p.locator.line > 0)); }
  assert.deepStrictEqual(s.lines.map((l) => l.line_no), s.lines.map((_, i) => i + 1));
});
check('cutoff identity: a source dated differently from the batch cutoff fails the snapshot', () => {
  const s = buildSnapshot(parse(), { batch_code: ID.batch_code, cutoff_date: '2026-07-31', roles: ROLES });
  assert.strictEqual(ctl(s, 'snapshot.sources_as_of_cutoff').status, 'FAIL');
  assert.strictEqual(ctl(s, 'snapshot.sources_as_of_cutoff').failures.length, 4);
});
check('deterministic: same input -> same sha256; one cent different -> different sha256', () => {
  const a = buildSnapshot(parse(), { ...ID, roles: ROLES }); const b = buildSnapshot(parse(), { ...ID, roles: ROLES });
  assert.strictEqual(a.sha256, b.sha256);
  const parsed = parse();
  const rows = parsed.homeowner_transactions.rows.map((r) => (r.domain === 'homeowner_account' && r.source_account_key === '90000001' ? { ...r, ending_cents: r.ending_cents + 1 } : r));
  assert.notStrictEqual(buildSnapshot({ ...parsed, homeowner_transactions: { ...parsed.homeowner_transactions, rows } }, { ...ID, roles: ROLES }).sha256, a.sha256);
});
check('in-memory runner: an agent assigned to snapshot can build it in the snapshot stage only; it never advances the batch', () => {
  let st = S.newBatchState({ batch_code: ID.batch_code, community_id: 'c', source_system: 'vantaca' });
  for (const to of ['normalize', 'source_controls', 'snapshot']) { st = S.completeStage(st, { kind: 'human', id: 'ed' }, { status: 'PASS' }); st = S.advance(st, { kind: 'human', id: 'ed' }, to); }
  assert.throws(() => E.runSnapshot(st, { kind: 'agent', id: 'c', assigned_stage: 'normalize' }, parse(), { cutoff_date: ID.cutoff_date, roles: ROLES }), /AGENT_OUTSIDE_ASSIGNED_STAGE|cannot act/);
  const r = E.runSnapshot(st, { kind: 'agent', id: 'c', assigned_stage: 'snapshot' }, parse(), { cutoff_date: ID.cutoff_date, roles: ROLES });
  assert.strictEqual(r.state.stage, 'snapshot'); assert.strictEqual(r.result.status, 'BLOCKED'); assert.deepStrictEqual(r.result.open_controls, ['snapshot.ap_detail_supports_gl']);
});
check('the snapshot module holds no database client and makes no writes', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'snapshot.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/supabase|createClient|\.from\(|\.rpc\(|\.insert\(|\.upsert\(|\.delete\(|require\(['"][^'"]*(db|journal|ar_engine|ap_engine)/.test(s));
});

let pass = 0, fail = 0;
console.log('Onboarding conversion snapshot (Issue #15 Milestone 3)');
for (const [n, fn] of tests) { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
