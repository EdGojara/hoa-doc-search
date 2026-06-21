// ============================================================================
// tests/test_vantaca_pay_payouts_parse.js
// ----------------------------------------------------------------------------
// Unit test for the Vantaca Pay Payout Contents parser. Synthetic rows only —
// no real homeowner data. Covers: signed amounts (Payment +, Fee/Refund −),
// account-ref + Card/eCheck extraction, payout-date grouping with net (the
// fee/refund netting that explains non-round bank payouts).
//
// Run: node tests/test_vantaca_pay_payouts_parse.js   (exit 1 on failure)
// ============================================================================

const { parseRows, groupByPayoutDate } = require('../lib/banking/extractors/vantaca_pay_payouts');

let failures = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; };

const rows = [
  ['Vantaca Pay Payout Contents'],
  [],
  [],
  ['Trxn Date', 'Payout Date', 'Description', 'Type', 'Amount'],
  ['Assoc: Test HOA - 4536'],
  ['1/1/2026', '1/6/2026', '10313976 Card', 'Payment', '$260.00'],
  ['1/8/2026', '1/22/2026', '10311595 eCheck', 'Payment', '$285.00'],
  ['1/22/2026', '1/22/2026', 'Dispute Fee', 'Fee', '-20.00'],
  ['1/22/2026', '1/22/2026', '10311526 duplicate', 'Refund', '-608.74'],
];

const r = parseRows(rows);
console.log('Vantaca Pay payout parser:');
check('association captured', /Test HOA/.test(r.association || ''));
check('four settlement items parsed', r.payments.length === 4);
check('payment amount positive ($260)', r.payments[0].amount_cents === 26000);
check('fee amount negative (−$20)', r.payments[2].amount_cents === -2000 && r.payments[2].type === 'Fee');
check('refund amount negative (−$608.74)', r.payments[3].amount_cents === -60874 && r.payments[3].type === 'Refund');
check('account ref extracted', r.payments[0].account_ref === '10313976');
check('Card kind detected', r.payments[0].kind === 'Card');
check('eCheck kind detected', r.payments[1].kind === 'eCheck');
check('payout date → ISO', r.payments[0].payout_date === '2026-01-06');

const groups = groupByPayoutDate(r.payments);
const g122 = groups.find((g) => g.payout_date === '2026-01-22');
// 285.00 − 20.00 − 608.74 = −343.74
check('payout-date group nets fees+refunds', g122 && g122.net_cents === -34374);
check('group carries its 3 line items', g122 && g122.items.length === 3);

if (failures) { console.log(`\nFAILED: ${failures} assertion(s)`); process.exit(1); }
console.log('\nAll Vantaca Pay payout parser assertions passed ✓');
