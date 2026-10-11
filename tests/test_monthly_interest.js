// Monthly late interest (lib/ar/monthly_interest.computeInterest): pure rule tests.
const { computeInterest } = require('../lib/ar/monthly_interest');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const props = [{ id: 'p1', street_address: '1 A St' }, { id: 'p2', street_address: '2 B St' }, { id: 'p3', street_address: '3 C St' }, { id: 'p4', street_address: '4 D St' }, { id: 'p5', street_address: '5 E St' }];
const ten = [
  { id: 't1', property_id: 'p1', kind: 'owner', start_date: '2020-01-01', end_date: null },
  { id: 't2', property_id: 'p2', kind: 'owner', start_date: '2020-01-01', end_date: null },
  { id: 't3old', property_id: 'p3', kind: 'owner', start_date: '2015-01-01', end_date: '2026-07-15' },
  { id: 't3', property_id: 'p3', kind: 'owner', start_date: '2026-07-16', end_date: null },
  { id: 't4', property_id: 'p4', kind: 'owner', start_date: '2020-01-01', end_date: null },
  { id: 't5', property_id: 'p5', kind: 'owner', start_date: '2020-01-01', end_date: null },
];
const bf = (tid, pid, cat, cents, desc = '') => ({ id: `${tid}-${cat}-${cents}`, tenure_id: tid, property_id: pid, transaction_date: '2026-07-31', txn_type: 'balance_brought_forward', charge_category: cat, amount_cents: cents, description: desc });
const rows = [
  bf('t1', 'p1', 'assessment', 142500), bf('t1', 'p1', 'interest', 5000), bf('t1', 'p1', 'late_fee', 2500),
  bf('t2', 'p2', 'assessment', 142500), bf('t2', 'p2', 'attorney_fee', 30000, 'Legal Fees - Collections'),
  bf('t3old', 'p3', 'assessment', 142500),                                   // former owner: never charged
  bf('t4', 'p4', 'assessment', 142500), bf('t4', 'p4', 'other', 2500, 'Payment Plan Fee'),
  bf('t5', 'p5', 'assessment', 142500),
  // post-cutover activity (no tenure on the row: resolved by property + date)
  { id: 'pay1', property_id: 'p1', transaction_date: '2026-08-15', txn_type: 'payment', charge_category: 'payment', amount_cents: -50000 },
  { id: 'pay5', property_id: 'p5', transaction_date: '2026-08-20', txn_type: 'payment', charge_category: 'payment', amount_cents: -142500 },
  { id: 'ret5', property_id: 'p5', transaction_date: '2026-08-25', txn_type: 'charge', charge_category: 'adjustment', amount_cents: 142500, description: 'Returned payment' },
  { id: 'old', property_id: null, transaction_date: '2026-07-31', txn_type: 'balance_brought_forward', charge_category: 'credit', amount_cents: -9900 },  // former-owner credit, no tenure
];
const S = { rate_bps: 1000, grace_days: 30, due_offset_days: 0 };

console.log('monthly interest');
const aug = computeInterest({ rows, tenures: ten, properties: props, runDate: '2026-08-01', cutoverDate: '2026-08-01', settings: S });
const it = (r, tid) => r.items.find((i) => i.tenure_id === tid);
check('10% / 12 on assessment principal only (never on prior interest or late fees): $1,425 -> $11.88', it(aug, 't1').interest_cents === 1188 && it(aug, 't1').eligible_principal_cents === 142500);
check('a former owner is never charged; the new owner of the lot has no principal of its own', !it(aug, 't3old') && !it(aug, 't3'));
check('attorney fees and a payment plan are exceptions (proposed, not charged by default)', it(aug, 't2').exception && it(aug, 't4').exception && !it(aug, 't1').exception);
check('a brought-forward balance with no owner is ignored, not an unmatched receipt', aug.unmatched.length === 0);
const sep = computeInterest({ rows, tenures: ten, properties: props, runDate: '2026-09-01', cutoverDate: '2026-08-01', settings: S });
check('receipts before the run date apply to delinquent assessments first: $1,425 - $500 = $925 -> $7.71', it(sep, 't1').eligible_principal_cents === 92500 && it(sep, 't1').interest_cents === 771);
check('a returned payment adds back (and is flagged)', it(sep, 't5').eligible_principal_cents === 142500 && it(sep, 't5').flags.some((f) => f.code === 'returned_payment'));
check('totals split clean vs exceptions', sep.totals.clean_owners + sep.totals.exception_owners === sep.totals.owners && sep.totals.interest_cents === sep.totals.clean_interest_cents + sep.totals.exception_interest_cents);
// idempotent: interest already recorded for the run date
const withInt = rows.concat([{ id: 'int1', tenure_id: 't1', property_id: 'p1', transaction_date: '2026-09-01', txn_type: 'charge', charge_category: 'interest', amount_cents: 771 }]);
const sep2 = computeInterest({ rows: withInt, tenures: ten, properties: props, runDate: '2026-09-01', cutoverDate: '2026-08-01', settings: S });
check('a tenure already charged for the run date is skipped (no second charge)', it(sep2, 't1').skip && it(sep2, 't1').interest_cents === 0 && sep2.totals.skipped_already_charged === 1);
// a new assessment is not eligible until it is more than grace_days past due
const bill = rows.concat([{ id: 'a27', tenure_id: 't1', property_id: 'p1', transaction_date: '2027-01-01', txn_type: 'charge', charge_category: 'assessment', amount_cents: 142500 }]);
const feb1 = computeInterest({ rows: bill, tenures: ten, properties: props, runDate: '2027-02-01', cutoverDate: '2026-08-01', settings: S });
const mar1 = computeInterest({ rows: bill, tenures: ten, properties: props, runDate: '2027-03-01', cutoverDate: '2026-08-01', settings: S });
const jan31 = computeInterest({ rows: bill, tenures: ten, properties: props, runDate: '2027-01-31', cutoverDate: '2026-08-01', settings: S });
check('a 1/1 assessment (due on the billing date) is not eligible within 30 days (1/31)', it(jan31, 't1').eligible_principal_cents === 92500);
check('it bears interest once unpaid more than 30 days after the due date (2/1, and still on 3/1)', it(feb1, 't1').eligible_principal_cents === 92500 + 142500 && it(mar1, 't1').eligible_principal_cents === 92500 + 142500);
const due15 = computeInterest({ rows: bill, tenures: ten, properties: props, runDate: '2027-02-14', cutoverDate: '2026-08-01', settings: { ...S, due_offset_days: 14 } });
check('a January 15 due date (offset 14): not yet eligible on 2/14', it(due15, 't1').eligible_principal_cents === 92500);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
