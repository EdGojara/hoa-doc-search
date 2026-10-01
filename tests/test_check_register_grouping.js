// tests/test_check_register_grouping.js — the Vantaca check register yields
// ONE row per check (Issue #12): invoice lines of the same check are combined
// so the bank-rec matcher can pair each bank debit with one register row.
const { groupChecksByNumber } = require('../lib/vantaca/extractors/check_register');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, x); } };
const row = (n, amt, o = {}) => ({ check_number: n, issue_date: '2026-06-12', amount_cents: amt, payee: 'Vendor', memo: '', status: 'outstanding', cleared_date: null, ...o });

let p = groupChecksByNumber({ total_amount_cents: 3238864, checks: [row('94', 65400), row('95', 38864), row('95', 240000), row('96', 584550, { issue_date: '2026-06-15' }), row('96', 620879 - 0, { issue_date: '2026-06-15' })] });
check('invoice lines of one check become one row with the summed amount', p.checks.length === 3 && p.checks.find((c) => c.check_number === '95').amount_cents === 278864 && p.checks.find((c) => c.check_number === '95').invoice_lines === 2);
check('single-line checks are unchanged', p.checks.find((c) => c.check_number === '94').amount_cents === 65400);
check('a combination is reported as a warning', p.warnings.some((w) => /Combined 5 invoice lines into 3 checks/.test(w)));
check('a sum that does not tie to the printed register total is warned, not hidden', p.warnings.some((w) => /does not|register total reads/.test(w)));

p = groupChecksByNumber({ total_amount_cents: 100, checks: [row('1', 40), row('1', 60)] });
check('when the combined sum ties to the register total there is no tie warning', !p.warnings.some((w) => /register total reads/.test(w)) && p.checks.length === 1 && p.checks[0].amount_cents === 100);

p = groupChecksByNumber({ checks: [row('7', 10, { issue_date: '2026-07-02' }), row('7', 20, { issue_date: '2026-07-01' })] });
check('the combined check keeps the earliest issue date', p.checks[0].issue_date === '2026-07-01');
p = groupChecksByNumber({ checks: [row('8', 10, { status: 'cleared' }), row('8', 20, { status: 'outstanding' })] });
check('a check is only "cleared" if every line is cleared', p.checks[0].status === 'outstanding');
p = groupChecksByNumber({ checks: [row('9', 10, { status: 'cleared' }), row('9', 20, { status: 'cleared' })] });
check('all lines cleared -> cleared', p.checks[0].status === 'cleared');
p = groupChecksByNumber({ checks: [row(null, 10), row(null, 20), row('5', 30)] });
check('rows without a check number are never merged', p.checks.length === 3);
p = groupChecksByNumber({ checks: [row('1', 5), row('2', 6)] });
check('already one row per check: unchanged and no warning', p.checks.length === 2 && p.warnings.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
