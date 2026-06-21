// ============================================================================
// tests/test_deposit_register_parse.js
// ----------------------------------------------------------------------------
// Unit test for the Vantaca Deposit Register parser (lib/banking/extractors/
// deposit_register.js). Uses synthetic in-memory rows that mirror the real
// file's quirks — NO real homeowner data committed:
//   • column shift (data sits in odd columns, headers in even — .xls null-pad)
//   • account segmentation ("QR Operating - 4536" / "QR CAP RSV - 9471")
//   • amounts with no leading zero ("$.38") — the bug that dropped the reserve
//   • "$$" subtotal/total rows that must NOT be parsed as deposit lines
//
// Run: node tests/test_deposit_register_parse.js   (exit 1 on failure)
// ============================================================================

const { parseRows } = require('../lib/banking/extractors/deposit_register');

let failures = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; };

// Mirrors the real layout: data in shifted (odd) columns, $$ subtotals, $.38.
const rows = [
  ['', 'Quail Ridge Homeowners'],
  ['', 'Deposit Register For 1'],
  [],
  ['', '', 'Deposit Date', '', 'Description', '', 'Check', '', 'Amount'],
  ['', 'QR Operating - 4536'],
  ['', '', '', '1/1/2026', '', 'Express pay - Account', '', '2923', '', '$260.00'],
  ['', '', '', '1/2/2026', '', 'Acct: 10311688 Check #', '', '', '', '$285.00'],
  ['', '', '', '1/7/2026', '', 'Acct: 10311685 Check #', '', '', '', '$1,335.00'],
  ['', '', '', '', '', '', '', '', '', '$$1,880.00'], // subtotal — must be ignored
  ['', 'QR CAP RSV - 9471'],
  ['', '', '', '1/30/2026', '', 'January Interest', '', '', '', '$.38'], // no leading zero
  ['', '', '', '', '', '', '', '', '', '$$0.38'],
  ['', '', '', '', '', 'Total:', '', '', '', '$$1,880.38'],
];

const r = parseRows(rows);
console.log('Deposit register parser:');
check('two accounts parsed', r.accounts.length === 2);
const op = r.accounts.find((a) => /operating/i.test(a.account_label));
const rsv = r.accounts.find((a) => /RSV|reserve/i.test(a.account_label));
check('operating last4 = 4536', op && op.account_last4 === '4536');
check('operating has 3 deposits', op && op.deposits.length === 3);
check('operating subtotal = $1,880.00', op && op.subtotal_cents === 188000);
check('reserve account captured (the $.38 fix)', !!rsv && rsv.deposits.length === 1);
check('reserve amount = $0.38', rsv && rsv.deposits[0].amount_cents === 38);
check('grand total = $1,880.38', r.total_cents === 188038);
check('first deposit date → ISO', op && op.deposits[0].date === '2026-01-01');
check('check number captured', op && op.deposits[0].check_number === '2923');
check('missing check number is null', op && op.deposits[1].check_number === null);
check('comma-thousands amount parsed ($1,335.00)', op && op.deposits[2].amount_cents === 133500);
check('subtotal/total rows not parsed as deposits', op.deposits.length === 3 && (!rsv || rsv.deposits.length === 1));
check('no warnings on clean input', r.warnings.length === 0);

if (failures) { console.log(`\nFAILED: ${failures} assertion(s)`); process.exit(1); }
console.log('\nAll deposit-register parser assertions passed ✓');
