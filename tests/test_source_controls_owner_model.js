// tests/test_source_controls_owner_model.js  (Issue #15, 2026-10-05)
// Source controls: the homeowner account model (synthetic data only).
// The homeowner transaction history holds CURRENT owners only, and Vantaca can show one
// current owner on BOTH reports: aged items on the AR aging (which may be negative) and an
// unapplied prepayment on the prepaid report; the ledger shows the net. Where an AR aging is
// supplied the controls use, per current owner:  ledger = AR aging - prepaid.
// AR-aging rows with no current-owner ledger account are previous owners: not expected in the
// subledger, but kept in the GL AR tie. Real differences still fail; without an AR aging the
// original controls run unchanged.
const assert = require('assert');
const { sourceControls } = require('../lib/onboarding/source_controls');

const ROLES = { ar_account: '1300', prepaid_account: '2400' };
const gl = (ar, prepaid) => ({ rows: [
  { domain: 'gl_account_balance', account_code: '1300', beginning_cents: 0, debit_cents: ar, credit_cents: 0, ending_cents: ar },
  { domain: 'gl_account_balance', account_code: '2400', beginning_cents: 0, debit_cents: 0, credit_cents: prepaid, ending_cents: -prepaid },
  { domain: 'gl_account_balance', account_code: '3000', beginning_cents: 0, debit_cents: prepaid, credit_cents: ar, ending_cents: prepaid - ar } ] });
const ledger = (accts) => ({ rows: Object.entries(accts).map(([k, v]) => ({ domain: 'homeowner_account', source_account_key: k, ending_cents: v, opening_cents: 0 })) });
const aging = (accts) => ({ rows: Object.entries(accts).map(([k, v]) => ({ domain: 'ar_aging_account', source_account_key: k, balance_cents: v, current_cents: v, over_30_cents: 0, over_60_cents: 0, over_90_cents: 0 })) });
const prepaid = (cur, prev = {}) => ({ rows: [...Object.entries(cur).map(([k, v]) => ({ domain: 'prepaid_credit', source_account_key: k, amount_cents: v, previous_owner: false })),
  ...Object.entries(prev).map(([k, v]) => ({ domain: 'prepaid_credit', source_account_key: k, amount_cents: v, previous_owner: true }))] });
const run = (parsed) => sourceControls(parsed, { roles: ROLES });
const st = (cs, code) => (cs.find((c) => c.code === code) || {}).status;
const get = (cs, code) => cs.find((c) => c.code === code);
const CODES = ['subledger.debit_balances_equal_gl_ar', 'ar_aging.total_equals_gl_ar', 'subledger.aging_matches_ledger_by_account', 'subledger.credit_balances_equal_gl_prepaid', 'prepaid_report.total_equals_gl_prepaid', 'prepaid_report.current_owner_credits_match_ledger'];
const allPass = (cs) => { for (const c of CODES) assert.strictEqual(st(cs, c), 'PASS', `${c}: ${JSON.stringify(get(cs, c))}`); };
const tests = []; const check = (n, fn) => tests.push([n, fn]);

// A world in the simple shape: debits on AR, credits on the prepaid report.
//   A owes 500.00; B owes 300.00; C prepaid 150.00; previous owner P has a 40.00 credit on the prepaid report.
const SIMPLE = () => ({ gl_trial_balance: gl(80000, 19000), homeowner_transactions: ledger({ A: 50000, B: 30000, C: -15000 }),
  ar_aging: aging({ A: 50000, B: 30000 }), prepaid_homeowners: prepaid({ C: 15000 }, { P: 4000 }) });

check('simple shape (debits on AR, credits on the prepaid report): every control PASSes', () => allPass(run(SIMPLE())));
check('simple shape: amounts are the same the original controls produced (debit side = ledger debits; credits = ledger credits + previous owners)', () => {
  const cs = run(SIMPLE());
  assert.strictEqual(get(cs, 'subledger.debit_balances_equal_gl_ar').left_cents, 80000);
  assert.strictEqual(get(cs, 'subledger.credit_balances_equal_gl_prepaid').left_cents, 19000);
});
check('an account on BOTH reports (aged balance + unapplied prepayment): ledger = AR - prepaid PASSes everywhere', () => {
  const p = SIMPLE(); // D: AR 559.66, prepaid 737.14, ledger -177.48
  p.homeowner_transactions.rows.push({ domain: 'homeowner_account', source_account_key: 'D', ending_cents: -17748, opening_cents: 0 });
  p.ar_aging.rows.push({ domain: 'ar_aging_account', source_account_key: 'D', balance_cents: 55966, current_cents: 55966, over_30_cents: 0, over_60_cents: 0, over_90_cents: 0 });
  p.prepaid_homeowners.rows.push({ domain: 'prepaid_credit', source_account_key: 'D', amount_cents: 73714, previous_owner: false });
  p.gl_trial_balance = gl(80000 + 55966, 19000 + 73714);
  allPass(run(p));
});
check('a credit that sits in AR aging as a negative balance (not on the prepaid report): PASSes; it is AR, not prepaid', () => {
  const p = SIMPLE(); // E: ledger -145.72, AR -145.72
  p.homeowner_transactions.rows.push({ domain: 'homeowner_account', source_account_key: 'E', ending_cents: -14572, opening_cents: 0 });
  p.ar_aging.rows.push({ domain: 'ar_aging_account', source_account_key: 'E', balance_cents: -14572, current_cents: -14572, over_30_cents: 0, over_60_cents: 0, over_90_cents: 0 });
  p.gl_trial_balance = gl(80000 - 14572, 19000);
  allPass(run(p));
});
check('a previous-owner AR-aging row (no current-owner ledger account) is not a per-account failure and is part of the GL AR tie', () => {
  const p = SIMPLE(); // Q: previous owner, AR -1,470.00
  p.ar_aging.rows.push({ domain: 'ar_aging_account', source_account_key: 'Q', balance_cents: -147000, current_cents: -147000, over_30_cents: 0, over_60_cents: 0, over_90_cents: 0 });
  p.gl_trial_balance = gl(80000 - 147000, 19000);
  const cs = run(p);
  allPass(cs);
  assert.match(get(cs, 'subledger.aging_matches_ledger_by_account').label, /1 previous-owner AR-aging rows/);
});

// ---- real differences still fail
check('a current owner whose ledger differs from AR - prepaid FAILs the per-account control with the exact difference', () => {
  const p = SIMPLE(); p.homeowner_transactions.rows[1].ending_cents = 30000 + 101080; // B's ledger carries 1,010.80 more than AR shows
  const c = get(run(p), 'subledger.aging_matches_ledger_by_account');
  assert.strictEqual(c.status, 'FAIL');
  assert.deepStrictEqual(c.failures, [{ account: 'B', ledger_cents: 131080, aging_cents: 30000, prepaid_cents: 0, difference_cents: 101080 }]);
});
check('a ledger balance with no AR-aging row FAILs (an account the aging omits)', () => {
  const p = SIMPLE(); p.homeowner_transactions.rows.push({ domain: 'homeowner_account', source_account_key: 'F', ending_cents: 5000, opening_cents: 0 });
  p.gl_trial_balance = gl(85000, 19000);
  assert.deepStrictEqual(get(run(p), 'subledger.aging_matches_ledger_by_account').failures.map((f) => [f.account, f.difference_cents]), [['F', 5000]]);
});
check('GL AR carrying an amount no account explains FAILs the GL AR tie by exactly that amount', () => {
  const p = SIMPLE(); p.gl_trial_balance = gl(80000 + 59365, 19000);
  const c = get(run(p), 'subledger.debit_balances_equal_gl_ar');
  assert.deepStrictEqual([c.status, c.difference_cents], ['FAIL', -59365]);
});
check('a prepaid-report credit that does not reconcile (ledger != AR - prepaid) FAILs the prepaid control and the GL prepaid tie', () => {
  const p = SIMPLE(); p.prepaid_homeowners.rows[0].amount_cents = 16000; p.gl_trial_balance = gl(80000, 20000);   // report says 160.00, ledger says 150.00
  const cs = run(p);
  assert.strictEqual(st(cs, 'prepaid_report.current_owner_credits_match_ledger'), 'FAIL');
  assert.strictEqual(st(cs, 'subledger.credit_balances_equal_gl_prepaid'), 'FAIL');
});
check('a ledger credit that is neither on the prepaid report nor in AR aging FAILs', () => {
  const p = SIMPLE(); p.homeowner_transactions.rows.push({ domain: 'homeowner_account', source_account_key: 'G', ending_cents: -2500, opening_cents: 0 });
  const f = get(run(p), 'prepaid_report.current_owner_credits_match_ledger').failures;
  assert.ok(f.some((x) => x.account === 'G' && /neither on the prepaid report nor in AR aging/.test(x.reason)), JSON.stringify(f));
});
check('a previous-owner prepaid row whose account is in the current-owner ledger still FAILs', () => {
  const p = SIMPLE(); p.prepaid_homeowners.rows.push({ domain: 'prepaid_credit', source_account_key: 'A', amount_cents: 100, previous_owner: true });
  assert.ok(get(run(p), 'prepaid_report.current_owner_credits_match_ledger').failures.some((x) => x.account === 'A' && /previous owner/.test(x.reason)));
});

// ---- without an AR aging / without a prepaid report: the original behaviour
check('without an AR aging the original controls run unchanged (debit balances = GL AR; ledger credits + previous owners = GL prepaid)', () => {
  const p = SIMPLE(); delete p.ar_aging;
  const cs = run(p);
  assert.deepStrictEqual([get(cs, 'subledger.debit_balances_equal_gl_ar').label, get(cs, 'subledger.debit_balances_equal_gl_ar').left_cents], ['Homeowner debit balances = GL AR (1300)', 80000]);
  assert.strictEqual(get(cs, 'subledger.credit_balances_equal_gl_prepaid').left_cents, 19000);
  assert.strictEqual(cs.find((c) => c.code === 'subledger.aging_matches_ledger_by_account'), undefined);
});
check('without a prepaid report, a previous owner\'s credit the GL carries still FAILs the GL prepaid tie (the Quail Ridge 737.53 shape)', () => {
  const p = SIMPLE(); delete p.prepaid_homeowners;   // GL prepaid 190.00 includes the previous owner's 40.00 no source covers
  const c = get(run(p), 'subledger.credit_balances_equal_gl_prepaid');
  assert.deepStrictEqual([c.status, c.left_cents, c.right_cents], ['FAIL', 15000, 19000]);
});

let pass = 0, fail = 0;
for (const [n, fn] of tests) {
  try { fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
