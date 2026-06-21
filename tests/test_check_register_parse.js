// ============================================================================
// tests/test_check_register_parse.js
// ----------------------------------------------------------------------------
// Unit test for the Check Register parser. Synthetic rows only — no real payee
// data. Covers: parenthesized (negative) amounts → positive magnitude, multiple
// lines bundled under one check number, account segmentation, Total-row
// exclusion, and the matcher-shape mapping.
//
// Run: node tests/test_check_register_parse.js   (exit 1 on failure)
// ============================================================================

const { parseRows, checksToMatcherShape } = require('../lib/banking/extractors/check_register');

let failures = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; };

const rows = [
  ['Test HOA'],
  ['Check Register Report'],
  [],
  ['Date', 'Description', 'Type', 'Check No', 'Amount'],
  ['QR Operating - 4536'],
  ['1/15/2026', 'Bedrock Association', 'Invoice Check', '21', '($550.00)'],
  ['1/15/2026', 'Bedrock Association', 'Invoice Check', '21', '($61.70)'],   // 2nd line, same check
  ['1/15/2026', 'Superior Lawncare', 'Invoice Check', '23', '($476.30)'],
  ['2/9/2026', 'Vendor X', 'Invoice Check', '26', '($1,189.74)'],            // comma-thousands
  ['', 'Total', '', '', '($2,277.74)'],
];

const r = parseRows(rows);
console.log('Check register parser:');
check('one account', r.accounts.length === 1);
const acct = r.accounts[0];
check('account last4 = 4536', acct.account_last4 === '4536');
check('three distinct checks (#21, #23, #26)', acct.checks.length === 3);
const c21 = acct.checks.find((c) => c.check_number === '21');
check('check #21 bundles 2 lines', c21 && c21.lines.length === 2);
check('check #21 total = $611.70 (positive magnitude)', c21 && c21.amount_cents === 61170);
check('comma-thousands amount parsed ($1,189.74)', acct.checks.find((c) => c.check_number === '26').amount_cents === 118974);
check('account total = $2,277.74', acct.total_cents === 227774);
check('Total row excluded (not a 4th check)', acct.checks.length === 3);
const shaped = checksToMatcherShape(acct.checks);
check('matcher shape has check_number + amount + issue_date', shaped[0].check_number === '21' && shaped[0].amount_cents === 61170 && shaped[0].issue_date === '2026-01-15');
check('no warnings', r.warnings.length === 0);

if (failures) { console.log(`\nFAILED: ${failures} assertion(s)`); process.exit(1); }
console.log('\nAll check-register parser assertions passed ✓');
