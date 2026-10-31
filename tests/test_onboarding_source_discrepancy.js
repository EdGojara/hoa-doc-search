// ============================================================================
// tests/test_onboarding_source_discrepancy.js  (Ed 2026-10-31, migration 552)
// ----------------------------------------------------------------------------
// A legacy trial balance that is itself out of balance (Vantaca year-end roll),
// and fund splits read from the source. Synthetic data only. Proves:
//   - a source_discrepancy policy is validated (account, exact cents, basis, label,
//     evidence) and keyed by account;
//   - an approved discrepancy resolves exactly the TB-balance controls and that
//     account's balance-sheet comparison, keeping the source amounts in detail; a
//     wrong amount or account resolves nothing;
//   - the snapshot opens the account at the corrected figure so the opening
//     balances, records the source ending beside it, and refuses a discrepancy
//     that does not bring the source TB to exactly zero (no plug);
//   - fund_allocation policies are validated and reach the snapshot as fund
//     allocations; both kinds are in the snapshot digest scope.
// ============================================================================
const assert = require('assert');
const OBJ = require('../lib/onboarding/conversion_objects');
const { buildSnapshot } = require('../lib/onboarding/snapshot');
const { makeRow } = require('../lib/onboarding/canonical');

let n = 0; const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const SHA = 'b'.repeat(64);
const prov = (i) => ({ artifact_sha256: SHA, locator: { line: i }, raw: `line ${i}` });
const acct = (code, name, end, i) => makeRow('gl_account_balance', { account_code: code, account_name: name, as_of: '2026-07-31', beginning_cents: end, debit_cents: 0, credit_cents: 0, ending_cents: end }, prov(i));
// Out of balance by +700 (debits exceed credits); the balance sheet shows 3050 at -1,700.00.
const parsed = { gl_trial_balance: { rows: [acct('1000', 'Operating Cash', 170000, 1), acct('3050', 'Fund Balance', -100000, 2)] } };
const glEnd = (a) => { const r = parsed.gl_trial_balance.rows.find((x) => x.account_code === a); return r ? r.ending_cents : null; };
const approvedPolicy = (kind, value, extra = {}) => ({ id: `p-${kind}`, policy_kind: kind, policy_key: value.account, value, status: 'approved', fingerprint: 'f'.repeat(64),
  reason: 'documented in the conversion', evidence: { artifact_sha256: SHA, locator: 'balance sheet, 3050', description: 'source balance sheet' }, approved_by_user_id: 'u1', approved_by_label: 'Owner', approved_at: '2026-10-31T12:00:00Z', approval_channel: 'in_app', ...extra });
const sd = (amount = -70000, account = '3050') => ({ adjustments: [], policies: [approvedPolicy('source_discrepancy', { account, amount_cents: amount, basis: 'balance_sheet', label: 'Vantaca 2025 year-end roll' })] });
const failing = [
  { code: 'gl.beginning_trial_balance_balances', label: 'GL beginning trial balance nets to zero', status: 'FAIL', left_cents: 70000, right_cents: 0, difference_cents: 70000 },
  { code: 'gl.ending_trial_balance_balances', label: 'GL ending trial balance nets to zero', status: 'FAIL', left_cents: 70000, right_cents: 0, difference_cents: 70000 },
  { code: 'vantaca.bs_vs_gl.3050', label: 'Balance Sheet 3050 = GL 3050 ending', status: 'FAIL', left_cents: 170000, right_cents: 100000, difference_cents: 70000 },
];

console.log('Onboarding source discrepancy + fund allocation policies');
t('policy validation: account, exact cents, basis and label; evidence required; keyed by account', () => {
  const ok = { policy_kind: 'source_discrepancy', value: { account: '3050', amount_cents: -70000, basis: 'balance_sheet', label: 'Vantaca 2025 year-end roll' }, reason: 'documented discrepancy', evidence: { artifact_sha256: SHA, locator: 'x', description: 'y' } };
  assert.deepStrictEqual(OBJ.validatePolicy(ok, { artifactShas: new Set([SHA]) }), []);
  assert.ok(OBJ.validatePolicy({ ...ok, value: { ...ok.value, basis: 'plug' } }, { artifactShas: new Set([SHA]) }).length);
  assert.ok(OBJ.validatePolicy({ ...ok, value: { ...ok.value, amount_cents: 0 } }, { artifactShas: new Set([SHA]) }).length);
  assert.ok(OBJ.validatePolicy({ ...ok, evidence: null }, { artifactShas: new Set([SHA]) }).length);
  assert.strictEqual(OBJ.policyKey(ok), '3050');
});
t('an approved discrepancy resolves the three controls exactly, keeping the source amounts', () => {
  const out = OBJ.resolveSourceDiscrepancies(failing, sd(), { glEnd });
  assert.ok(out.every((c) => c.status === 'PASS'), JSON.stringify(out.map((c) => [c.code, c.status, c.detail && c.detail.resolution_refused])));
  assert.strictEqual(out[0].detail.source_left_cents, 70000);
  assert.strictEqual(out[2].detail.source_difference_cents, 70000);
});
t('a wrong amount or a different account resolves nothing', () => {
  assert.ok(OBJ.resolveSourceDiscrepancies(failing, sd(-60000), { glEnd }).every((c) => c.status === 'FAIL'));
  const other = OBJ.resolveSourceDiscrepancies(failing, sd(-70000, '1000'), { glEnd });
  assert.strictEqual(other[2].status, 'FAIL');
});
t('snapshot: the account opens at the corrected figure, the opening balances, the source ending is kept', () => {
  const snap = buildSnapshot(parsed, { batch_code: 'B', cutoff_date: '2026-07-31', source_discrepancies: OBJ.sourceDiscrepancies(sd()), artifact_shas: [SHA] });
  const c = snap.controls.find((x) => x.code === 'snapshot.gl_opening_balances_balance');
  assert.strictEqual(c.status, 'PASS');
  assert.strictEqual(snap.controls.find((x) => x.code === 'snapshot.source_discrepancies_documented').status, 'PASS');
  const l = snap.lines.find((x) => x.account_code === '3050');
  assert.strictEqual(l.amount_cents, -170000); assert.strictEqual(l.source_ending_cents, -100000); assert.strictEqual(l.source_discrepancy.amount_cents, -70000);
});
t('snapshot refuses a discrepancy that does not bring the source to zero (no plug), and an unapproved one', () => {
  const wrong = buildSnapshot(parsed, { batch_code: 'B', cutoff_date: '2026-07-31', source_discrepancies: OBJ.sourceDiscrepancies(sd(-50000)), artifact_shas: [SHA] });
  assert.strictEqual(wrong.controls.find((x) => x.code === 'snapshot.source_discrepancies_documented').status, 'FAIL');
  assert.strictEqual(wrong.controls.find((x) => x.code === 'snapshot.gl_opening_balances_balance').status, 'FAIL');
  const unapproved = buildSnapshot(parsed, { batch_code: 'B', cutoff_date: '2026-07-31', source_discrepancies: [{ account: '3050', amount_cents: -70000, evidence: { artifact_sha256: SHA, locator: 'x' } }], artifact_shas: [SHA] });
  assert.strictEqual(unapproved.controls.find((x) => x.code === 'snapshot.source_discrepancies_documented').status, 'FAIL');
});
t('fund allocation policy: validated, reaches the snapshot, both kinds are in the snapshot digest', () => {
  const fa = approvedPolicy('fund_allocation', { account: '3050', basis: 'source_fund_columns', parts: [{ fund_code: 'OPR', amount_cents: -120000 }, { fund_code: 'RES', amount_cents: -50000 }] });
  assert.deepStrictEqual(OBJ.validatePolicy({ policy_kind: 'fund_allocation', value: fa.value, reason: 'from the fund columns', evidence: fa.evidence }, { artifactShas: new Set([SHA]) }), []);
  assert.ok(OBJ.validatePolicy({ policy_kind: 'fund_allocation', value: { ...fa.value, basis: 'chosen' }, reason: 'from the fund columns', evidence: fa.evidence }, { artifactShas: new Set([SHA]) }).length);
  const objs = { adjustments: [], policies: [...sd().policies, fa] };
  const snap = buildSnapshot(parsed, { batch_code: 'B', cutoff_date: '2026-07-31', source_discrepancies: OBJ.sourceDiscrepancies(objs), fund_allocations: OBJ.fundAllocations(objs), artifact_shas: [SHA] });
  assert.strictEqual(snap.controls.find((x) => x.code === 'snapshot.fund_allocations_documented').status, 'PASS');
  assert.deepStrictEqual(snap.lines.find((x) => x.account_code === '3050').fund_allocation.parts.map((p) => p.fund_code), ['OPR', 'RES']);
  const none = OBJ.objectsDigest({ adjustments: [], policies: [] }, { scope: 'snapshot' });
  assert.notStrictEqual(OBJ.objectsDigest(objs, { scope: 'snapshot' }), none);
  assert.notStrictEqual(OBJ.objectsDigest(sd(), { scope: 'source_controls' }), none);
});
console.log(`\n${n} passed`);
