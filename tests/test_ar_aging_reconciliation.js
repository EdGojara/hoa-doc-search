// tests/test_ar_aging_reconciliation.js  (Ed 2026-10-08)
// The AR aging ties to GL 1300 explicitly, without changing the accounting: the
// aging shows owners' net positions; the GL keeps receivables in 1300 and owner
// credits in 2400. Fixture: Canyon Gate's real shape at 9/30/2026 in miniature,
// plus the exact $189.64 composition found in its books.
const { reconcileAgingToGl } = require('../lib/ar/aging_reconciliation');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const row = (pid, type, cents, date = '2026-07-31') => ({ property_id: pid, txn_type: type, amount_cents: cents, transaction_date: date });

// The Canyon Gate composition: seven lots with negative opening rows (-$694.39 total), two lots
// whose credits net against receivables ($559.66 vs -$737.14; $350.00 vs -$324.37), plus ordinary owers.
const rows = [
  row('owes1', 'balance_brought_forward', 100000), row('owes2', 'balance_brought_forward', 50000),
  row('neg1', 'balance_brought_forward', -14572), row('neg2', 'balance_brought_forward', -7500), row('neg3', 'balance_brought_forward', -26000),
  row('neg4', 'balance_brought_forward', -10000), row('neg5', 'balance_brought_forward', -7500), row('neg6', 'balance_brought_forward', -2500), row('neg7', 'balance_brought_forward', -1367),
  row('both1', 'balance_brought_forward', 55966), row('both1', 'credit', -73714),
  row('both2', 'balance_brought_forward', 35000), row('both2', 'credit', -32437),
  row('prepaid1', 'credit', -10000),
];
const receivable = 100000 + 50000 - 69439 + 55966 + 35000;   // GL 1300 basis
const credits = -73714 - 32437 - 10000;                       // GL 2400 basis (current owners)
const aging = 100000 + 50000 + 2563;                          // what the aging shows (net > 0 only)

console.log('reconciliation to GL 1300');
const r = reconcileAgingToGl({ rows, asOf: '2026-09-30', agingOpenCents: aging, glArCents: receivable, glPrepaidCents: -credits });
const line = (k) => r.lines.find((l) => l.key === k);
check('open charges aged = sum of owners’ positive net positions (and equals the aging total)', line('open_charges').cents === aging && r.aging_matches_ledger === true);
check('owner credit balances listed (negative opening rows and owners whose credits exceed charges)', line('owner_credit_balances').count === 9 && r.owners_in_credit.length === 9);
check('net position = open charges + owner credit balances', line('net_position').cents === line('open_charges').cents + line('owner_credit_balances').cents);
check('add back the credits recorded in 2400; the result is the GL 1300 basis', line('net_position').cents + line('credits_in_2400').cents === line('receivable_rows').cents && line('receivable_rows').cents === receivable);
check('ties to GL 1300 with zero difference, without any reclassification', r.tied === true && r.difference_cents === 0);
check('the presentation difference is the Canyon Gate composition: 559.66 + 324.37 - 694.39 = 189.64', receivable - aging === 18964, String(receivable - aging));
check('2400: current-owner credits equal the GL when the GL holds only current-owner credits', r.prepaid.subledger_cents === -credits && r.prepaid.difference_cents === 0);

console.log('differences are named, never hidden');
const off = reconcileAgingToGl({ rows, asOf: '2026-09-30', agingOpenCents: aging, glArCents: receivable + 715000 });
check('a GL that does not match shows NOT TIED with the exact difference', off.tied === false && off.difference_cents === -715000);
const bad = reconcileAgingToGl({ rows, asOf: '2026-09-30', agingOpenCents: aging + 1, glArCents: receivable });
check('an aging total that does not equal the ledger’s open charges is flagged', bad.aging_matches_ledger === false);
const noGl = reconcileAgingToGl({ rows, asOf: '2026-09-30', agingOpenCents: aging, glArCents: null });
check('no GL 1300 account: difference unknown, not called tied', noGl.difference_cents === null && noGl.tied === false);

console.log('as of a date');
const later = rows.concat([row('owes1', 'payment', -40000, '2026-10-05'), row('owes3', 'charge', 2500, '2026-10-02')]);
const at930 = reconcileAgingToGl({ rows: later, asOf: '2026-09-30', agingOpenCents: aging, glArCents: receivable });
check('rows after the as-of date are excluded (a 10/5 payment and a 10/2 charge do not change 9/30)', at930.tied && line('open_charges').cents === at930.lines.find((l) => l.key === 'open_charges').cents);
const today = reconcileAgingToGl({ rows: later, asOf: '2026-10-08', agingOpenCents: aging - 40000 + 2500, glArCents: receivable - 40000 + 2500 });
check('as of 10/8 they are included and it still ties', today.tied && today.aging_matches_ledger);

console.log('charges billed natively in trustEd (not in the migrated ledger)');
const nat = reconcileAgingToGl({ rows, asOf: '2026-09-30', agingOpenCents: aging + 3500, nativeOpenCents: 3500, glArCents: receivable + 3500 });
check('a native certified-letter fee is aged on top and added to the GL 1300 basis; still ties', nat.tied && nat.aging_matches_ledger && nat.lines.some((l) => l.key === 'native_charges' && l.cents === 3500));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
