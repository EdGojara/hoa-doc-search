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
check('no homeowner ledger: AR still opens from the AR aging (the source of authority); prepaid with neither a prepaid report nor a ledger is BLOCKED with the control unsupported; the ledger cross-check is BLOCKED, not skipped', () => {
  const s = buildSnapshot(parse(['gl_trial_balance', 'balance_sheet', 'ar_aging']), { ...ID, roles: ROLES });
  assert.strictEqual(ctl(s, 'snapshot.gl_lines_equal_source_ending_tb').status, 'PASS');
  assert.strictEqual(kind(s, 'gl_opening_balance').find((l) => l.account_code === '1300').amount_cents, 51000);
  assert.deepStrictEqual([comp(s, 'ar_detail').status, comp(s, 'ar_detail').source, comp(s, 'ar_detail').unsupported_cents], ['PASS', 'ar_aging', 0]);
  assert.deepStrictEqual([comp(s, 'prepaid_detail').status, comp(s, 'prepaid_detail').unsupported_cents], ['BLOCKED', -8500]);
  assert.strictEqual(kind(s, 'prepaid_detail').length, 0, 'no owner credit invented');
  assert.strictEqual(ctl(s, 'snapshot.ledger_cross_check').status, 'BLOCKED');
  assert.strictEqual(comp(s, 'ledger_cross_check').status, 'BLOCKED');
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
// ---- SOURCE AUTHORITY (Ed 2026-10-07): homeowner AR opens from the AR AGING, prepaid from
// the PREPAID report; the homeowner ledger is a cross-check only. Canyon Gate shape, synthetic:
//   - GL 1300 carries a legacy previous-owner receivable (reclassed to 1310) and a $24.75
//     duplicate (corrected Dr 1000 / Cr 1300) on top of what the aging supports;
//   - the aging prints a PREVIOUS-OWNER credit row (former owner, kept in 1300 by the source);
//   - the prepaid report carries the current owner's credit AND a former owner's credit (2400);
//   - one owner's ledger carries a duplicate conversion opening the aging and GL do not.
const { makeRow } = require('../lib/onboarding/canonical');
const SRC = (n) => ({ artifact_sha256: 'f'.repeat(64), locator: `synthetic:${n}`, raw: `synthetic ${n}` });
const FORMER_AR = -14700;           // aging "***" previous-owner credit, kept in 1300 by the source
const FORMER_PP = 50000;            // prepaid report "***" former-owner credit, kept in 2400
const LEDGER_DUP = 101080;          // duplicate opening in ONE owner's ledger only
const canyonShape = ({ ledgerDuplicate = true } = {}) => {
  const p = withLegacyAndDuplicate();               // 1300 +legacy +24.75, 1000 -24.75
  const tb = p.gl_trial_balance.rows.map((r) => {
    if (r.domain !== 'gl_account_balance') return r;
    if (r.account_code === '1300') return { ...r, ending_cents: r.ending_cents + FORMER_AR };      // former-owner credit sits in AR
    // withLegacy parked the legacy amount's offset in 2400; here it sits in cash so 2400 is purely homeowner credits
    if (r.account_code === '2400') return { ...r, ending_cents: r.ending_cents + LEGACY - FORMER_PP };   // former-owner credit sits in prepaid
    if (r.account_code === '1000') return { ...r, ending_cents: r.ending_cents - LEGACY - FORMER_AR + FORMER_PP };   // keep the TB balanced
    return r;
  });
  const agingAsOf = p.ar_aging.rows.find((r) => r.domain === 'ar_aging_account').as_of;
  const aging = [...p.ar_aging.rows, makeRow('ar_aging_account', { source_account_key: '90009001', as_of: agingAsOf, balance_cents: FORMER_AR, previous_owner: true }, SRC('aging 90009001'))];
  const prepaid = [
    makeRow('prepaid_credit', { source_account_key: '90000003', as_of: agingAsOf, amount_cents: 8500 }, SRC('prepaid 90000003')),
    makeRow('prepaid_credit', { source_account_key: '90009002', as_of: agingAsOf, amount_cents: FORMER_PP, previous_owner: true }, SRC('prepaid 90009002')),
  ];
  const ho = p.homeowner_transactions.rows.map((r) => (ledgerDuplicate && r.domain === 'homeowner_account' && r.source_account_key === '90000002' ? { ...r, ending_cents: r.ending_cents + LEDGER_DUP } : r));
  return { ...p, gl_trial_balance: { ...p.gl_trial_balance, rows: tb }, ar_aging: { ...p.ar_aging, rows: aging },
    prepaid_homeowners: { as_of: agingAsOf, rows: prepaid }, homeowner_transactions: { ...p.homeowner_transactions, rows: ho } };
};
const APPROVED = { ...ID, roles: ROLES, opening_reclasses: [RECLASS], opening_corrections: [CORRECTION], artifact_shas: [EVIDENCE_SHA, BANK_SHA] };
check('AR opens from the AR aging (previous-owner row included, keyed to its own account) and ties to 1300 after the approved 1310 reclass and the $24.75 correction', () => {
  const s = buildSnapshot(canyonShape(), APPROVED);
  const ar = comp(s, 'ar_detail');
  assert.deepStrictEqual([ar.status, ar.source, ar.control_cents, ar.supported_cents, ar.unsupported_cents], ['PASS', 'ar_aging', 51000 + FORMER_AR, 51000 + FORMER_AR, 0], JSON.stringify([ar.status, ar.source, ar.control_cents, ar.supported_cents, ar.unsupported_cents]));
  assert.strictEqual(kind(s, 'gl_opening_balance').find((l) => l.account_code === '1300').amount_cents, 51000 + FORMER_AR);
  const former = kind(s, 'ar_detail').find((l) => l.source_account_key === '90009001');
  assert.deepStrictEqual([former.amount_cents, former.former_owner], [FORMER_AR, true], 'previous-owner credit kept, on its own account, never written off');
  assert.strictEqual(ctl(s, 'snapshot.ar_detail_supports_gl').status, 'PASS');
});
check('prepaid opens from the prepaid report (current and former owners) and ties to 2400 exactly', () => {
  const s = buildSnapshot(canyonShape(), APPROVED);
  const pp = comp(s, 'prepaid_detail');
  assert.deepStrictEqual([pp.status, pp.source, pp.control_cents, pp.supported_cents, pp.former_owner_accounts], ['PASS', 'prepaid_report', -8500 - FORMER_PP, -8500 - FORMER_PP, 1], JSON.stringify([pp.status, pp.source, pp.control_cents, pp.supported_cents, pp.former_owner_accounts]));
  assert.deepStrictEqual(kind(s, 'prepaid_detail').map((l) => [l.source_account_key, l.amount_cents, !!l.former_owner]), [['90000003', -8500, false], ['90009002', -FORMER_PP, true]]);
});
check('a ledger difference is an EXCEPTION, never a change to the opening: same opening with or without the ledger duplicate; the cross-check FAILS naming the account', () => {
  const clean = buildSnapshot(canyonShape({ ledgerDuplicate: false }), APPROVED);
  const dup = buildSnapshot(canyonShape(), APPROVED);
  const opening = (s) => s.lines.filter((l) => ['gl_opening_balance', 'ar_detail', 'prepaid_detail'].includes(l.kind)).map((l) => [l.kind, l.account_code, l.source_account_key, l.amount_cents]);
  assert.deepStrictEqual(opening(dup), opening(clean), 'the ledger never changes the opening position');
  assert.strictEqual(ctl(clean, 'snapshot.ledger_cross_check').status, 'PASS');
  const x = ctl(dup, 'snapshot.ledger_cross_check');
  assert.strictEqual(x.status, 'FAIL');
  assert.deepStrictEqual(x.failures.map((f) => [f.account, f.difference_cents]), [['90000002', LEDGER_DUP]]);
  assert.notStrictEqual(dup.sha256, clean.sha256, 'the exception is part of what the reviewer approves');
});
check('an approved, evidenced disposition ("aging governs") resolves the exception; without evidence or approval it does not', () => {
  const disp = { account: '90000002', disposition: 'aging_governs', reason: 'Duplicate / transposed conversion opening row in the ledger only; aging and GL carry the true balance',
    evidence: { description: 'Prior-manager aging 10/31/2025', artifact_sha256: EVIDENCE_SHA, locator: 'account 90000002 total' }, approved_by: 'Ed Gojara', approved_at: '2026-10-07' };
  const ok = buildSnapshot(canyonShape(), { ...APPROVED, ledger_dispositions: [disp] });
  const c = ctl(ok, 'snapshot.ledger_cross_check');
  assert.strictEqual(c.status, 'PASS');
  assert.deepStrictEqual(c.resolved.map((r) => [r.account, r.difference_cents, r.approved_by]), [['90000002', LEDGER_DUP, 'Ed Gojara']]);
  assert.strictEqual(comp(ok, 'ar_detail').supported_cents, 51000 + FORMER_AR, 'still the aging balance');
  for (const bad of [{ ...disp, approved_by: '' }, { ...disp, evidence: { ...disp.evidence, artifact_sha256: 'd'.repeat(64) } }, { ...disp, disposition: 'ledger_governs' }]) {
    assert.strictEqual(ctl(buildSnapshot(canyonShape(), { ...APPROVED, ledger_dispositions: [bad] }), 'snapshot.ledger_cross_check').status, 'FAIL', JSON.stringify(bad).slice(0, 60));
  }
});
// ---- FORMER-OWNER ROUTING (Ed 2026-10-07): previous-owner rows in the aging leave AR in the
// opening, by the aging's own amounts: debits to the prior-owner receivable (1310, which also
// holds the legacy reclass), credits to a named refund liability (2410). AR = current owners.
const FORMER_DEBIT = 8687;
const canyonShapeWithFormerDebit = () => {
  const p = canyonShape();
  const asOf = p.ar_aging.rows.find((r) => r.domain === 'ar_aging_account').as_of;
  const aging = [...p.ar_aging.rows, makeRow('ar_aging_account', { source_account_key: '90009003', as_of: asOf, balance_cents: FORMER_DEBIT, previous_owner: true }, SRC('aging 90009003'))];
  const tb = p.gl_trial_balance.rows.map((r) => (r.domain !== 'gl_account_balance' ? r : r.account_code === '1300' ? { ...r, ending_cents: r.ending_cents + FORMER_DEBIT } : r.account_code === '1000' ? { ...r, ending_cents: r.ending_cents - FORMER_DEBIT } : r));
  return { ...p, ar_aging: { ...p.ar_aging, rows: aging }, gl_trial_balance: { ...p.gl_trial_balance, rows: tb } };
};
const ROUTING = { receivable_account: '1310', receivable_account_name: 'Legacy Receivable - Previous Owners', refund_account: '2410', refund_account_name: 'Former Owner Refunds Payable',
  reason: 'Previous owners in the AR aging are not current homeowners: debits are prior-owner receivables, credits are refunds payable', approved_by: 'Ed Gojara', approved_at: '2026-10-07' };
check('former-owner routing: 1300 = current owners only; 1310 = legacy + former-owner debits; 2410 = former-owner credits (one line each, own accounts); opening balanced; AR ties', () => {
  const s = buildSnapshot(canyonShapeWithFormerDebit(), { ...APPROVED, former_owner_routing: ROUTING });
  const g = (c) => kind(s, 'gl_opening_balance').find((l) => l.account_code === c);
  assert.strictEqual(g('1300').amount_cents, 51000, 'current owners only');
  assert.deepStrictEqual([g('1310').amount_cents, g('1310').account_name], [LEGACY + FORMER_DEBIT, 'Legacy Receivable - Previous Owners']);
  assert.deepStrictEqual([g('2410').amount_cents, g('2410').account_name], [FORMER_AR, 'Former Owner Refunds Payable']);
  assert.deepStrictEqual(g('2410').former_owner_routing.accounts, ['90009001']);
  assert.strictEqual(total(kind(s, 'gl_opening_balance')), 0);
  assert.deepStrictEqual(kind(s, 'former_owner_receivable').map((l) => [l.source_account_key, l.account_code, l.amount_cents]), [['90009003', '1310', FORMER_DEBIT]]);
  assert.deepStrictEqual(kind(s, 'former_owner_refund').map((l) => [l.source_account_key, l.account_code, l.amount_cents]), [['90009001', '2410', FORMER_AR]]);
  assert.ok(!kind(s, 'ar_detail').some((l) => l.former_owner), 'no former owner left in current-owner AR');
  for (const k of ['snapshot.former_owner_routing', 'snapshot.ar_detail_supports_gl', 'snapshot.ar_detail_matches_aging_by_account', 'snapshot.gl_opening_balances_balance', 'snapshot.every_line_has_provenance']) assert.strictEqual(ctl(s, k).status, 'PASS', k);
});
check('former-owner routing without a named approval (or into the AR account itself) FAILS and moves nothing; without routing, former owners stay in AR as before', () => {
  for (const bad of [{ ...ROUTING, approved_by: '' }, { ...ROUTING, refund_account: '1300' }, { ...ROUTING, refund_account: '2499', refund_account_name: undefined }]) {
    const s = buildSnapshot(canyonShapeWithFormerDebit(), { ...APPROVED, former_owner_routing: bad });
    assert.strictEqual(ctl(s, 'snapshot.former_owner_routing').status, 'FAIL');
    assert.ok(!kind(s, 'gl_opening_balance').some((l) => l.account_code === '2410' || l.account_code === '2499'));
  }
  const plain = buildSnapshot(canyonShapeWithFormerDebit(), APPROVED);
  assert.strictEqual(kind(plain, 'gl_opening_balance').find((l) => l.account_code === '1300').amount_cents, 51000 + FORMER_AR + FORMER_DEBIT);
  assert.strictEqual(comp(plain, 'ar_detail').status, 'PASS');
});
check('opening reclasses are owner-only in the service, and the stage route passes them through', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'onboarding', 'service.js'), 'utf8');
  assert.match(svc, /if \(\(openingReclasses\.length \|\| openingCorrections\.length \|\| ledgerDispositions\.length \|\| formerOwnerRouting\) && !\(actor && actor\.role === 'owner'\)\) throw new ServiceError\(403, 'OWNER_ONLY'/);
  assert.match(svc, /ledger_dispositions: ledgerDispositions, former_owner_routing: formerOwnerRouting,/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'api', 'onboarding.js'), 'utf8'), /opening_reclasses: b\.opening_reclasses, opening_corrections: b\.opening_corrections, ledger_dispositions: b\.ledger_dispositions, former_owner_routing: b\.former_owner_routing/);
  assert.match(svc, /artifact_shas: \[\.\.\.view\.artifacts\.map\(\(a\) => a\.sha256\), \.\.\.\(await listEvidence\(view\.batch\.id\)\)\.map\(\(e\) => e\.sha256\)\]/, 'evidence-only documents (495) are citable');
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
