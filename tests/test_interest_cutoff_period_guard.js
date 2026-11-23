// Native interest (Ed 2026-11-17, Waterview): calculation cutoff separate from the posting date, once per
// month (any interest already recorded in the run's month blocks a second charge), bankruptcy flagged.
'use strict';
const assert = require('assert');
const { computeInterest } = require('../lib/ar/monthly_interest');
let pass = 0, fail = 0;
const check = (n, fn) => { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } };
const tenures = [{ id: 't1', property_id: 'p1', kind: 'owner', start_date: '2020-01-01', end_date: null }];
const properties = [{ id: 'p1', street_address: '1 Main', vantaca_account_id: 'A1' }];
const settings = { rate_bps: 1000, grace_days: 30, due_offset_days: 0 };
const base = [{ id: 'a', tenure_id: 't1', property_id: 'p1', transaction_date: '2026-01-01', txn_type: 'charge', charge_category: 'assessment', amount_cents: 61500 }];
const run = (rows, extra = {}) => computeInterest({ rows, tenures, properties, runDate: '2026-09-01', settings, ...extra });
const item = (out) => out.items.find((i) => i.tenure_id === 't1');

check('10%/yr on assessment principal past the 30-day grace: $615 -> $5.13', () => { const i = item(run(base, { asOfDate: '2026-08-31' })); assert.strictEqual(i.interest_cents, 513); assert.strictEqual(i.eligible_principal_cents, 61500); });
check('cutoff 8/31: a payment dated 9/1 does not reduce the 9/1 interest (posting date is not the cutoff)', () => {
  const rows = [...base, { id: 'p', tenure_id: 't1', property_id: 'p1', transaction_date: '2026-09-01', txn_type: 'payment', charge_category: 'payment', amount_cents: -61500 }];
  assert.strictEqual(item(run(rows, { asOfDate: '2026-08-31' })).interest_cents, 513);
  assert.strictEqual(item(run(rows)) && item(run(rows)).interest_cents, undefined === item(run(rows)) ? undefined : 0, 'without a separate cutoff the 9/1 payment counts');
});
check('a payment on or before the cutoff is applied to the delinquent assessment first', () => {
  const rows = [...base, { id: 'p', tenure_id: 't1', property_id: 'p1', transaction_date: '2026-08-20', txn_type: 'payment', charge_category: 'payment', amount_cents: -30000 }];
  const i = item(run(rows, { asOfDate: '2026-08-31' })); assert.strictEqual(i.eligible_principal_cents, 31500); assert.strictEqual(i.interest_cents, 263);
});
check('an assessment not yet 30 days past due at the cutoff is not charged', () => {
  const rows = [{ ...base[0], transaction_date: '2026-08-05' }];
  const out = run(rows, { asOfDate: '2026-08-31' }); assert.ok(!item(out) || item(out).interest_cents === 0);
});
check('once per month: interest already recorded anywhere in the run month (even after the cutoff) is recognized; nothing is charged twice', () => {
  for (const d of ['2026-09-01', '2026-09-17']) {
    const rows = [...base, { id: 'i', tenure_id: 't1', property_id: 'p1', transaction_date: d, txn_type: 'charge', charge_category: 'interest', amount_cents: 513 }];
    const i = item(run(rows, { asOfDate: '2026-08-31' })); assert.strictEqual(i.skip, true, d); assert.strictEqual(i.interest_cents, 0, d); assert.ok(i.flags.some((f) => f.code === 'already_charged'));
  }
  const prior = [...base, { id: 'i', tenure_id: 't1', property_id: 'p1', transaction_date: '2026-08-01', txn_type: 'charge', charge_category: 'interest', amount_cents: 513 }];
  assert.strictEqual(item(run(prior, { asOfDate: '2026-08-31' })).interest_cents, 513, 'last month\'s interest does not block this month, and is never interest on interest');
});
check('bankruptcy is an exception for review (collections status or a ledger entry naming it)', () => {
  const a = item(run(base, { asOfDate: '2026-08-31', collections: [{ property_id: 'p1', collection_status: 'bankruptcy' }] }));
  assert.ok(a.exception && a.flags.some((f) => f.code === 'bankruptcy'));
  const b = item(run([...base, { id: 'b', tenure_id: 't1', property_id: 'p1', transaction_date: '2026-05-26', txn_type: 'adjustment', charge_category: 'adjustment', amount_cents: 0, description: 'Bankruptcy Discharge 05/26/2026' }], { asOfDate: '2026-08-31' }));
  assert.ok(b.exception && b.flags.some((f) => f.code === 'bankruptcy'));
});
check('the rule records the calculation cutoff separately from the run date', () => { const out = run(base, { asOfDate: '2026-08-31' }); assert.strictEqual(out.run_date, '2026-09-01'); assert.strictEqual(out.as_of_date, '2026-08-31'); assert.strictEqual(out.rule.calculation_cutoff, '2026-08-31'); });

check('interest gate: a prior-month rec counts only if reconciled, or in_progress with a $0.00 difference (never relabeled)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'accounting', 'monthly_runs.js'), 'utf8');
  assert.ok(/x\.status === 'in_progress' && Number\(x\.difference_cents\) === 0/.test(src));
  assert.ok(/code: 'bank_rec_open_items_carried', severity: 'info'/.test(src));
  assert.ok(/code: 'bank_not_reconciled', severity: 'blocking'/.test(src), 'an unbalanced or missing reconciliation still blocks');
  assert.ok(!/update\(\{ status: 'reconciled'/.test(src), 'the run never marks a reconciliation reconciled');
});
console.log(`\ninterest cutoff + period guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
