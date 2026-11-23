// Interest follows effective dates (Ed 2026-11-23): principal only; payments, credits, reversals and
// assessment corrections count from their own date however late they are entered; posted months are
// recalculated and the correction listed; no association inherits another's policy.
'use strict';
const assert = require('assert');
const I = require('../lib/ar/monthly_interest');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n    ' + e.message); } };
const tenures = [{ id: 't', property_id: 'p', kind: 'owner', start_date: '2020-01-01', end_date: null }];
const properties = [{ id: 'p', street_address: '1 Sample' }];
const settings = { rate_bps: 1000, grace_days: 30, due_offset_days: 0, calc_cutoff: 'prior_month_end' };
let n = 0;
const row = (d, cat, cents, x = {}) => ({ id: 'r' + (++n), tenure_id: 't', property_id: 'p', transaction_date: d, txn_type: 'charge', charge_category: cat, amount_cents: cents, ...x });
const bf = (cat, c) => row('2026-07-31', cat, c, { txn_type: 'balance_brought_forward' });
const open = [bf('assessment', 120000), bf('interest', 5000), bf('late_fee', 4000), bf('certified_letter', 2500)];
const pay = (d, c) => row(d, 'payment', -c, { txn_type: 'payment' });
const base = { tenures, properties, cutoverDate: '2026-08-01', settings };
const run = (rows, x = {}) => I.computeInterest({ ...base, rows, runDate: '2026-09-01', asOfDate: '2026-08-31', ...x }).items[0] || { interest_cents: 0, flags: [] };
const has = (i, c) => i.flags.some((f) => f.code === c);

t('principal only: prior interest, late fees, letters and legal fees never earn interest', () => {
  assert.strictEqual(run(open).interest_cents, 1000);
  assert.strictEqual(run([...open, bf('attorney_fee_other', 500000), row('2026-08-01', 'interest', 1000), row('2026-08-05', 'fine', 9900)]).interest_cents, 1000);
});
t('payments, returned payments and assessment credits count from their own date', () => {
  assert.strictEqual(run([...open, pay('2026-08-15', 30000)]).interest_cents, 750);
  assert.strictEqual(run([...open, pay('2026-09-01', 30000)]).interest_cents, 1000);
  assert.strictEqual(run([...open, pay('2026-08-15', 30000), row('2026-08-20', 'payment_reversal', 30000)]).interest_cents, 1000);
  assert.strictEqual(run([...open, row('2026-08-20', 'assessment', -30000, { txn_type: 'adjustment' })]).interest_cents, 750);
  assert.strictEqual(run([...open, row('2026-08-20', 'assessment', -30000, { txn_type: 'adjustment' }), pay('2026-08-25', 30000)]).interest_cents, 500);
  assert.strictEqual(run([...open, row('2026-08-20', 'assessment', -200000, { txn_type: 'adjustment' })]).interest_cents, 0);
});
t('a credit that does not say what it corrects, or an opening credit, holds the owner for review', () => {
  assert.ok(run([...open, row('2026-08-20', 'adjustment', -30000, { txn_type: 'adjustment' })]).exception);
  const i = run([...open, row('2026-07-31', 'other', -30000, { txn_type: 'credit' })]); assert.ok(has(i, 'unapplied_credit') && i.exception);
  assert.ok(!run(open).exception);
});
t('at legal, on a recorded payment plan, in bankruptcy: held for review', () => {
  assert.ok(has(run(open, { enforcement: [{ property_id: 'p', state: 'at_legal' }] }), 'attorney'));
  assert.ok(has(run(open, { plans: [{ property_id: 'p', status: 'active' }] }), 'payment_plan'));
  assert.ok(!has(run(open, { plans: [{ property_id: 'p', status: 'completed' }] }), 'payment_plan'));
  assert.ok(has(run(open, { enforcement: [{ property_id: 'p', state: 'in_bankruptcy' }] }), 'bankruptcy'));
});
t('a month already charged is never charged again, even when the interest row has no clear owner', () => {
  assert.strictEqual(run([...open, row('2026-09-01', 'interest', 1000)]).skip, true);
  assert.strictEqual(run([...open, row('2026-09-01', 'interest', 1000, { tenure_id: null })]).skip, true);
  const two = [...tenures, { id: 't2', property_id: 'p', kind: 'owner', start_date: '2026-09-01', end_date: null }];
  const i = run([...open, row('2026-09-01', 'interest', 1000, { tenure_id: null })], { tenures: two }); assert.ok(has(i, 'interest_owner_unclear') && i.exception);
});
t('posted months: nothing to correct when the ledger still supports them', () => {
  assert.deepStrictEqual(I.reviewPostedInterest({ ...base, rows: [...open, row('2026-09-01', 'interest', 1000), row('2026-10-01', 'interest', 1000)] }), []);
});
t('posted months: a backdated payment lists a correction for every month it affects, and only those', () => {
  const r = I.reviewPostedInterest({ ...base, rows: [...open, row('2026-08-01', 'interest', 1000), row('2026-09-01', 'interest', 1000), row('2026-10-01', 'interest', 1000), pay('2026-08-15', 60000)] });
  assert.deepStrictEqual(r.map((x) => [x.month, x.posted_cents, x.recalculated_cents, x.correction_cents]), [['2026-09', 1000, 500, -500], ['2026-10', 1000, 500, -500]]);
});
t('posted months: a correction already made nets out; a reversed payment lists an undercharge', () => {
  assert.deepStrictEqual(I.reviewPostedInterest({ ...base, rows: [...open, row('2026-09-01', 'interest', 1000), pay('2026-08-15', 60000), row('2026-09-30', 'interest', -500, { txn_type: 'adjustment', corrects_month: '2026-09' })] }), []);
  const r = I.reviewPostedInterest({ ...base, rows: [...open, row('2026-09-01', 'interest', 500), pay('2026-08-15', 60000), row('2026-08-20', 'payment_reversal', 60000)] });
  assert.deepStrictEqual(r.map((x) => x.correction_cents), [500]);
});
t('an approval is refused when amounts changed since the run was prepared', () => {
  const a = I.computeInterest({ ...base, rows: open, runDate: '2026-09-01', asOfDate: '2026-08-31' }).items; const b = I.computeInterest({ ...base, rows: [...open, pay('2026-08-15', 30000)], runDate: '2026-09-01', asOfDate: '2026-08-31' }).items;
  assert.deepStrictEqual(I.changedSince(a, a), []); assert.deepStrictEqual(I.changedSince(a, b).map((x) => [x.prepared_cents, x.now_cents]), [[1000, 750]]); assert.strictEqual(I.changedSince(a, []).length, 1);
});
t('no default policy: a missing rate or grace period refuses', () => {
  for (const s of [null, {}, { rate_bps: 1000 }, { grace_days: 30 }, { rate_bps: 0, grace_days: 30 }, { rate_bps: 'x', grace_days: 30 }]) assert.throws(() => I.requirePolicy(s), /not configured/);
  assert.ok(I.requirePolicy({ rate_bps: 1000, grace_days: 0 }));
});
t('a Kat credit keeps the assessment or interest it corrects; a line is stamped only within the owner period', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'accounting', 'homeowner_charge.js'), 'utf8');
  assert.ok(/\['assessment', 'interest'\]\.includes\(opts\.chargeCategory\)/.test(src)); assert.ok(/ident\.tenure_start\)\.slice\(0, 10\) <= txnDate/.test(src));
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
