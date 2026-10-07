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
check('AP: when the source chart has no AP account the component is NOT_APPLICABLE with a reason (never silently skipped); with an AP account but no AP aging the control balance is kept and reported unsupported', () => {
  const s = buildSnapshot(parse(), { ...ID, roles: ROLES });
  assert.strictEqual(comp(s, 'ap_detail').status, 'NOT_APPLICABLE'); assert.ok(/no Accounts Payable account/.test(comp(s, 'ap_detail').reason)); assert.strictEqual(ctl(s, 'snapshot.ap_detail_supports_gl'), undefined);
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
  assert.strictEqual(r.state.stage, 'snapshot'); assert.strictEqual(r.result.status, 'PASS'); assert.deepStrictEqual(r.result.open_controls, []);
});
// ---- Opening reclassifications (Ed 2026-10-07): Canyon Gate's $1,629.70 "14010 Previous
// Owners Rec. PM" (prior-management balance sheet 10/31/2025) sits inside source 1300 with no
// homeowner behind it. Approved treatment: 1300 opens at the source balance less the legacy
// amount; 1310 Legacy Receivable - Previous Owners opens at it. Preserved, never written off.
// Synthetic: the fixture's 1300 gets +1,000.00 that no homeowner detail supports (offset in 2400
// so the TB still balances), and the reclass moves exactly that.
const LEGACY = 100000;
const EVIDENCE_SHA = 'e'.repeat(64);
const withLegacy = () => {
  const p = parse();
  const rows = p.gl_trial_balance.rows.map((r) => (r.domain === 'gl_account_balance' && r.account_code === '1300' ? { ...r, ending_cents: r.ending_cents + LEGACY }
    : r.domain === 'gl_account_balance' && r.account_code === '2400' ? { ...r, ending_cents: r.ending_cents - LEGACY } : r));
  return { ...p, gl_trial_balance: { ...p.gl_trial_balance, rows } };
};
const RECLASS = { from_account: '1300', to_account: '1310', to_account_name: 'Legacy Receivable - Previous Owners', amount_cents: LEGACY,
  reason: 'Prior-management previous-owner receivable carried in 1300 with no homeowner behind it; preserved, not written off',
  evidence: { description: 'Coded balance sheet 10/31/2025 (prior management)', artifact_sha256: EVIDENCE_SHA, locator: '14010 Previous Owners Rec. PM' },
  approved_by: 'Ed Gojara', approved_at: '2026-10-07' };
check('opening reclass: 1300 opens at source less the legacy amount, 1310 opens at it, total unchanged, and the homeowner detail now supports 1300 exactly', () => {
  const before = buildSnapshot(withLegacy(), { ...ID, roles: ROLES });
  assert.strictEqual(comp(before, 'ar_detail').status, 'BLOCKED', 'without the reclass the legacy amount is unsupported AR');
  assert.strictEqual(comp(before, 'ar_detail').unsupported_cents, LEGACY);
  const s = buildSnapshot(withLegacy(), { ...ID, roles: ROLES, opening_reclasses: [RECLASS], artifact_shas: [EVIDENCE_SHA] });
  const gl = kind(s, 'gl_opening_balance');
  const l1300 = gl.find((l) => l.account_code === '1300'); const l1310 = gl.find((l) => l.account_code === '1310');
  assert.deepStrictEqual([l1300.amount_cents, l1300.source_ending_cents, l1300.reclassified_cents], [51000, 51000 + LEGACY, -LEGACY]);
  assert.deepStrictEqual([l1310.amount_cents, l1310.account_name, l1310.reclass[0].from_account, l1310.reclass[0].approved_by], [LEGACY, 'Legacy Receivable - Previous Owners', '1300', 'Ed Gojara']);
  assert.ok(l1310.provenance.some((p) => p.artifact_sha256 === EVIDENCE_SHA && p.locator === '14010 Previous Owners Rec. PM'), '1310 cites the evidence document');
  assert.strictEqual(total(gl), 0, 'debits still equal credits');
  for (const k of ['snapshot.gl_lines_equal_source_ending_tb', 'snapshot.opening_reclasses_documented', 'snapshot.gl_opening_balances_balance', 'snapshot.ar_detail_supports_gl', 'snapshot.every_line_has_provenance']) assert.strictEqual(ctl(s, k).status, 'PASS', k);
  assert.deepStrictEqual([comp(s, 'ar_detail').status, comp(s, 'ar_detail').unsupported_cents], ['PASS', 0]);
  assert.notStrictEqual(s.sha256, before.sha256, 'the reclass changes what the reviewer approves');
});
check('opening reclass is a sourced decision, never a plug: no evidence artifact, no approval, too large, or flipping the sign -> FAIL and NOTHING moves', () => {
  const bad = [
    [{ ...RECLASS }, []],                                                         // evidence not an artifact of the batch
    [{ ...RECLASS, approved_by: null }, [EVIDENCE_SHA]],
    [{ ...RECLASS, amount_cents: 51000 + LEGACY + 1 }, [EVIDENCE_SHA]],
    [{ ...RECLASS, amount_cents: -LEGACY }, [EVIDENCE_SHA]],
    [{ ...RECLASS, to_account: '1300' }, [EVIDENCE_SHA]],
    [{ ...RECLASS, evidence: { ...RECLASS.evidence, locator: '' } }, [EVIDENCE_SHA]],
  ];
  for (const [r, shas] of bad) {
    const s = buildSnapshot(withLegacy(), { ...ID, roles: ROLES, opening_reclasses: [r], artifact_shas: shas });
    assert.strictEqual(ctl(s, 'snapshot.opening_reclasses_documented').status, 'FAIL', JSON.stringify(r).slice(0, 80));
    assert.strictEqual(kind(s, 'gl_opening_balance').find((l) => l.account_code === '1300').amount_cents, 51000 + LEGACY, 'a defective reclass moves nothing');
    assert.ok(!kind(s, 'gl_opening_balance').some((l) => l.account_code === '1310'));
  }
});
// ---- Opening corrections of proven source errors (Ed 2026-10-07): Canyon Gate's $24.75.
// The bank debited a check shortfall once; Vantaca booked it twice, so the source 1300
// carries an extra 24.75 and cash 1000 is 24.75 short. Approved in the opening:
// Dr 1000 24.75 / Cr 1300 24.75. Synthetic: on top of the legacy fixture, 1300 +24.75
// and 1000 -24.75 (TB still balances).
const DUP = 2475;
const withLegacyAndDuplicate = () => {
  const p = withLegacy();
  const rows = p.gl_trial_balance.rows.map((r) => (r.domain === 'gl_account_balance' && r.account_code === '1300' ? { ...r, ending_cents: r.ending_cents + DUP }
    : r.domain === 'gl_account_balance' && r.account_code === '1000' ? { ...r, ending_cents: r.ending_cents - DUP } : r));
  return { ...p, gl_trial_balance: { ...p.gl_trial_balance, rows } };
};
const BANK_SHA = 'b'.repeat(64);
const CORRECTION = { lines: [{ account: '1000', amount_cents: DUP }, { account: '1300', amount_cents: -DUP }],
  reason: 'Check shortfall debited once by the bank (3/9/2026) but booked twice in Vantaca (3/9 AP post item and 7/7 owner adjustment); owner paid once',
  evidence: { description: 'Columbia Bank statement March 2026, account 3170', artifact_sha256: BANK_SHA, locator: '03-09 Deposit Adj Debit 3/6 Ck 12134 La $1425.00 Sb $1400.25 $24.75' },
  approved_by: 'Ed Gojara', approved_at: '2026-10-07' };
check('opening correction: Dr 1000 / Cr 1300 24.75 with the 1310 reclass -> 1300 = homeowner detail exactly, cash restored, opening balanced, each line cites its decision', () => {
  const base = { ...ID, roles: ROLES, opening_reclasses: [RECLASS], artifact_shas: [EVIDENCE_SHA, BANK_SHA] };
  const before = buildSnapshot(withLegacyAndDuplicate(), base);
  assert.strictEqual(comp(before, 'ar_detail').unsupported_cents, DUP, 'without the correction the duplicate is unsupported AR');
  const s = buildSnapshot(withLegacyAndDuplicate(), { ...base, opening_corrections: [CORRECTION] });
  const gl = kind(s, 'gl_opening_balance');
  const g = (c) => gl.find((l) => l.account_code === c);
  assert.deepStrictEqual([g('1300').amount_cents, g('1300').source_ending_cents, g('1300').reclassified_cents], [51000, 51000 + LEGACY + DUP, -(LEGACY + DUP)]);
  assert.deepStrictEqual([g('1000').amount_cents, g('1000').source_ending_cents], [143500, 143500 - DUP]);
  assert.strictEqual(g('1310').amount_cents, LEGACY);
  assert.strictEqual(g('1000').corrections[0].evidence.locator, CORRECTION.evidence.locator);
  assert.strictEqual(g('1300').corrections[0].amount_cents, -DUP);
  assert.strictEqual(total(gl), 0);
  for (const k of ['snapshot.opening_corrections_documented', 'snapshot.opening_reclasses_documented', 'snapshot.gl_lines_equal_source_ending_tb', 'snapshot.gl_opening_balances_balance', 'snapshot.ar_detail_supports_gl']) assert.strictEqual(ctl(s, k).status, 'PASS', k);
});
check('a correction is sourced and balanced or it moves NOTHING (and blocks the reclass too): unbalanced, no evidence artifact, no approval, unknown account, or a sign flip -> FAIL', () => {
  const bad = [
    { ...CORRECTION, lines: [{ account: '1000', amount_cents: DUP }, { account: '1300', amount_cents: -DUP + 1 }] },
    { ...CORRECTION, evidence: { ...CORRECTION.evidence, artifact_sha256: 'c'.repeat(64) } },
    { ...CORRECTION, approved_by: '' },
    { ...CORRECTION, lines: [{ account: '1999', amount_cents: DUP }, { account: '1300', amount_cents: -DUP }] },
    { ...CORRECTION, lines: [{ account: '1000', amount_cents: 999999 }, { account: '1300', amount_cents: -999999 }] },   // would flip 1300 negative
  ];
  for (const c of bad) {
    const s = buildSnapshot(withLegacyAndDuplicate(), { ...ID, roles: ROLES, opening_reclasses: [RECLASS], opening_corrections: [c], artifact_shas: [EVIDENCE_SHA, BANK_SHA] });
    assert.strictEqual(ctl(s, 'snapshot.opening_corrections_documented').status, 'FAIL', JSON.stringify(c.lines));
    const g = (code) => kind(s, 'gl_opening_balance').find((l) => l.account_code === code);
    assert.strictEqual(g('1300').amount_cents, 51000 + LEGACY + DUP, 'nothing moves');
    assert.strictEqual(g('1000').amount_cents, 143500 - DUP);
    assert.ok(!g('1310'), 'the reclass does not apply alone either');
  }
});
check('opening reclasses are owner-only in the service, and the stage route passes them through', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'service.js'), 'utf8');
  assert.match(svc, /if \(\(openingReclasses\.length \|\| openingCorrections\.length\) && !\(actor && actor\.role === 'owner'\)\) throw new ServiceError\(403, 'OWNER_ONLY'/);
  assert.match(svc, /opening_reclasses: openingReclasses, opening_corrections: openingCorrections,/);
  assert.match(svc, /artifact_shas: \[\.\.\.view\.artifacts\.map\(\(a\) => a\.sha256\), \.\.\.\(await listEvidence\(view\.batch\.id\)\)\.map\(\(e\) => e\.sha256\)\]/, 'evidence-only documents (495) are citable');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'api', 'onboarding.js'), 'utf8'), /opening_reclasses: b\.opening_reclasses, opening_corrections: b\.opening_corrections/);
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
