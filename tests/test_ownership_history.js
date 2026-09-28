// tests/test_ownership_history.js — per-tenure (per-owner) balances and the
// canonical AR source policy (Issue #1, 2026-09-28). Offline, pure functions.
// Proves: one population feeds tenure balances AND the property total (no
// double count across AR surfaces); prior owners close / remain / are Unknown;
// closeout is recognized only from recorded links, never from dates; anything
// that can't be tied to an owner is Unassigned and blocks a clean badge.
const assert = require('assert');
const oh = require('../lib/ar/ownership_history');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

const P = { id: 'lot1', community_id: 'c1', street_address: '1 Main St', unit: null };
const B = [{ id: 'b', status: 'committed', uploaded_by: 'vantaca_import_pipeline', period_label: 'June' },
  { id: 'conv', status: 'committed', uploaded_by: 'conversion:CONV-X', period_label: 'Opening' },
  { id: 'payoff', status: 'committed', uploaded_by: 'home_sales:closing_payoff', period_label: 'Closing payoff' },
  { id: 'old', status: 'reverted', uploaded_by: 'vantaca_import_pipeline', period_label: 'May' }];
let n = 0;
const ht = (tenure, date, cents, extra = {}) => ({ id: 'h' + (++n), source_batch_id: 'b', property_id: 'lot1', tenure_id: tenure, transaction_date: date, amount_cents: cents, txn_type: cents < 0 ? 'payment' : 'charge', description: 'x', created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}`, ...extra });
const T = (id, start, end, extra = {}) => ({ id, community_id: 'c1', property_id: 'lot1', kind: 'owner', start_date: start, end_date: end, origin: 'backfill_historical', ...extra });
const owners = [{ tenure_id: 'tA', name: 'Seller One', is_primary: true }, { tenure_id: 'tB', name: 'Buyer Two', is_primary: true }, { tenure_id: 'tC', name: 'Early Owner', is_primary: true }];

function history({ tenures, htRows = [], arCharges = [], arPayments = [], proposals = [], sales = [], view = null }) {
  const population = oh.canonicalPopulation({ htRows, batches: B, arCharges, arPayments });
  return oh.buildPropertyHistory({ property: P, tenures, owners, proposals, sales, population, currentOwnerView: view });
}
const payoffRow = (tenure, date, cents, link = {}) => ht(tenure, date, cents, { source_batch_id: 'payoff', raw_source: 'closing_payoff', raw_home_sale_id: 'sale1', raw_proposal_id: 'prop1', raw_check_number: '105699', ...link });
const PROPOSAL = [{ id: 'prop1', status: 'approved', seller_tenure_id: 'tA', buyer_tenure_id: 'tB', home_sale_id: 'sale1' }];
const SALE = [{ id: 'sale1', property_id: 'lot1', status: 'closed', closing_date: '2026-08-27', ownership_proposal_id: 'prop1' }];

t('property with one current owner only', () => {
  const h = history({ tenures: [T('tB', '2026-01-01', null, { origin: 'backfill_current' })], htRows: [ht('tB', '2026-02-01', 5000), ht('tB', '2026-03-01', -2000)], view: { balance_cents: 3000 } });
  assert.strictEqual(h.prior_owners.length, 0);
  assert.strictEqual(h.current_owner.status.code, 'current');
  assert.strictEqual(h.current_owner.balance_cents, 3000);
  assert.deepStrictEqual(h.current_owner.ledger.map((r) => r.running_balance_cents), [5000, 3000]);
  assert.ok(h.reconciliation.clean && h.reconciliation.current_balance_check.ties);
});

t('property with multiple prior owners, each with its own balance', () => {
  const h = history({ tenures: [T('tC', '2015-01-01', '2019-03-11'), T('tA', '2019-03-12', '2026-08-26'), T('tB', '2026-08-27', null)],
    htRows: [ht('tC', '2019-01-01', 700), ht('tA', '2026-07-01', 1000), ht('tA', '2026-07-15', -1000), ht('tB', '2026-09-01', 2500)] });
  assert.deepStrictEqual(h.prior_owners.map((t2) => t2.tenure_id), ['tA', 'tC']); // newest first
  assert.strictEqual(h.prior_owners[0].final_balance_cents, 0);
  assert.strictEqual(h.prior_owners[1].final_balance_cents, 700);
  assert.strictEqual(h.current_owner.balance_cents, 2500);
  assert.strictEqual(h.reconciliation.property_total_cents, 3200);
  assert.strictEqual(h.reconciliation.sum_of_tenures_cents + h.reconciliation.unassigned_cents, h.reconciliation.property_total_cents);
});

t('prior owner closes exactly at zero', () => {
  const h = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-08-01', 6500), ht('tA', '2026-08-20', -6500)] });
  const s = h.prior_owners[0];
  assert.strictEqual(s.status.code, 'closed_clean'); assert.strictEqual(s.status.icon, '✓');
  assert.strictEqual(s.balance_at_end_cents, 0); assert.strictEqual(s.final_balance_cents, 0);
});

t('prior owner remains with a debit balance', () => {
  const s = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-08-01', 11923)] }).prior_owners[0];
  assert.strictEqual(s.status.code, 'debit_remains'); assert.strictEqual(s.balance_label, '$119.23 due');
});

t('prior owner remains with a credit balance', () => {
  const s = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-08-01', -4200)] }).prior_owners[0];
  assert.strictEqual(s.status.code, 'credit_remains'); assert.strictEqual(s.balance_label, '($42.00) credit');
});

t('seller payoff zeros the tenure (LOPF shape): balance at end, closeout, final', () => {
  const h = history({ tenures: [T('tA', '2026-05-19', '2026-08-26'), T('tB', '2026-08-27', null, { origin: 'transfer' })],
    htRows: [ht('tA', '2026-07-31', 11923, { source_batch_id: 'conv', txn_type: 'balance_brought_forward' }), payoffRow('tA', '2026-08-27', -11923)],
    proposals: PROPOSAL, sales: SALE });
  const s = h.prior_owners[0];
  assert.strictEqual(s.balance_at_end_cents, 11923);
  assert.strictEqual(s.closeout.length, 1); assert.strictEqual(s.closeout_cents, -11923);
  assert.match(s.closeout[0].note, /after ownership end as part of closing/);
  assert.strictEqual(s.unexpected_post_end.length, 0);
  assert.strictEqual(s.final_balance_cents, 0); assert.strictEqual(s.status.code, 'closed_clean');
  assert.ok(h.reconciliation.clean);
});

t('closeout is NOT inferred from date proximity: an unlinked payment the day after sale is post-end review', () => {
  const s = history({ tenures: [T('tA', '2026-05-19', '2026-08-26'), T('tB', '2026-08-27', null)],
    htRows: [ht('tA', '2026-08-01', 11923), ht('tA', '2026-08-27', -11923)], proposals: PROPOSAL, sales: SALE }).prior_owners[0];
  assert.strictEqual(s.closeout.length, 0);
  assert.strictEqual(s.status.code, 'post_end_review');
  assert.strictEqual(s.final_balance_cents, 0); // zero, but not "closed cleanly"
});

t('a closing-payoff row whose proposal names a different seller tenure is not authorized closeout', () => {
  const s = history({ tenures: [T('tA', '2026-05-19', '2026-08-26'), T('tB', '2026-08-27', null)],
    htRows: [ht('tA', '2026-08-01', 11923), payoffRow('tA', '2026-08-27', -11923)],
    proposals: [{ ...PROPOSAL[0], seller_tenure_id: 'tOther' }], sales: SALE }).prior_owners[0];
  assert.strictEqual(s.status.code, 'post_end_review');
  assert.ok(s.review_flags[0].flags.some((f) => /could not be verified/.test(f)));
});

t('charge posted after sale date is flagged on the seller tenure', () => {
  const s = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-09-01', 2500)] }).prior_owners[0];
  assert.strictEqual(s.balance_at_end_cents, 0);
  assert.deepStrictEqual(s.unexpected_post_end.map((r) => r.amount_cents), [2500]);
  assert.strictEqual(s.status.code, 'post_end_review');
});

t('payment posted after sale date is flagged on the seller tenure', () => {
  const s = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-08-01', 3000), ht('tA', '2026-09-03', -3000)] }).prior_owners[0];
  assert.strictEqual(s.balance_at_end_cents, 3000);
  assert.strictEqual(s.unexpected_post_end_cents, -3000);
  assert.strictEqual(s.status.code, 'post_end_review');
});

t('conversion / opening balance is labeled and ordered first on its date', () => {
  const h = history({ tenures: [T('tB', '2026-01-01', null, { origin: 'backfill_current' })],
    htRows: [ht('tB', '2026-07-31', 500), ht('tB', '2026-07-31', 6500, { source_batch_id: 'conv', txn_type: 'balance_brought_forward' })] });
  const first = h.current_owner.ledger[0];
  assert.ok(first.opening && first.flags.includes('opening / conversion balance'));
  assert.ok(h.current_owner.has_opening_balance);
  assert.strictEqual(h.current_owner.review_flags.length, 0); // opening balance alone is not a review item
});

t('transaction that cannot safely be assigned is Unassigned and blocks a clean badge', () => {
  const h = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tB', '2026-09-01', 1000), ht(null, '2026-08-27', 777)] });
  assert.strictEqual(h.unassigned.length, 1); assert.strictEqual(h.unassigned_cents, 777);
  assert.strictEqual(h.current_owner.balance_cents, 1000); // never allocated by date
  assert.strictEqual(h.reconciliation.property_total_cents, 1777);
  assert.strictEqual(h.reconciliation.clean, false);
});

t('current and prior owner transactions are never mixed', () => {
  const h = history({ tenures: [T('tA', '2020-01-01', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-08-01', 9900), ht('tB', '2026-09-01', 100)] });
  assert.ok(h.current_owner.ledger.every((r) => r.tenure_id === 'tB'));
  assert.ok(h.prior_owners[0].ledger.every((r) => r.tenure_id === 'tA'));
  assert.strictEqual(h.current_owner.balance_cents, 100);
});

t('ended tenure with no ledger data is Unknown, never $0 / closed', () => {
  const h = history({ tenures: [T('tC', '2013-06-04', '2019-03-11'), T('tB', '2019-03-12', null)], htRows: [ht('tB', '2026-01-01', 100)] });
  const s = h.prior_owners[0];
  assert.strictEqual(s.status.code, 'unknown'); assert.strictEqual(s.final_balance_cents, null); assert.strictEqual(s.balance_label, 'Unknown');
});

t('SOURCE POLICY: the same economic event in two AR surfaces is counted once', () => {
  // Imported Vantaca charge on the homeowner ledger AND its migrated open-item mirror in ar_charges.
  const htRows = [ht('tB', '2026-01-01', 26000)];
  const arCharges = [{ id: 'm1', property_id: 'lot1', tenure_id: 'tB', charge_date: '2026-01-01', original_amount_cents: 26000, status: 'open', source_module: 'vantaca_migration' }];
  const h = history({ tenures: [T('tB', '2026-01-01', null)], htRows, arCharges, view: { balance_cents: 26000 } });
  assert.strictEqual(h.current_owner.balance_cents, 26000);
  assert.strictEqual(h.reconciliation.property_total_cents, 26000);
  assert.strictEqual(h.excluded.mirror_rows, 1);
});

t('SOURCE POLICY: a native posting that duplicates a ledger row is held out and flagged, not added', () => {
  const htRows = [ht('tB', '2026-08-27', 3500)];
  const arCharges = [{ id: 'n1', property_id: 'lot1', tenure_id: 'tB', charge_date: '2026-08-28', original_amount_cents: 3500, status: 'open', source_module: 'certified_letter_fee' }];
  const h = history({ tenures: [T('tB', '2026-01-01', null)], htRows, arCharges, view: { balance_cents: 3500 } });
  assert.strictEqual(h.current_owner.balance_cents, 3500);
  assert.strictEqual(h.possible_duplicates.length, 1);
  assert.strictEqual(h.reconciliation.clean, false);
});

t('SOURCE POLICY: a native-only posting (certified fee) is additive and explained against the current-balance view', () => {
  const htRows = [ht('tB', '2026-06-01', 10000)];
  const arCharges = [{ id: 'n1', property_id: 'lot1', tenure_id: 'tB', charge_date: '2026-09-15', original_amount_cents: 3500, status: 'open', source_module: 'certified_letter_fee' },
    { id: 'v1', property_id: 'lot1', tenure_id: 'tB', charge_date: '2026-09-16', original_amount_cents: 999, status: 'voided', source_module: 'manual' }];
  const h = history({ tenures: [T('tB', '2026-01-01', null)], htRows, arCharges, view: { balance_cents: 10000 } });
  assert.strictEqual(h.current_owner.balance_cents, 13500);
  const c = h.reconciliation.current_balance_check;
  assert.strictEqual(c.native_trusted_postings_cents, 3500); assert.ok(c.ties); assert.ok(c.note);
});

t('SOURCE POLICY: rows in reverted batches are not live', () => {
  const h = history({ tenures: [T('tB', '2026-01-01', null)], htRows: [ht('tB', '2026-06-01', 10000), ht(null, '2026-05-01', 5000, { source_batch_id: 'old' })] });
  assert.strictEqual(h.reconciliation.property_total_cents, 10000);
  assert.strictEqual(h.unassigned.length, 0); assert.strictEqual(h.excluded.non_live_rows, 1);
});

t('exception report: Unknown excluded by default and never counted as cleared; legacy labeled separately', () => {
  const h = history({ tenures: [T('tC', '2013-01-01', '2019-01-01'), T('tA', '2019-01-02', '2026-08-26'), T('tB', '2026-08-27', null)], htRows: [ht('tA', '2026-08-01', 500)] });
  const legacy = [oh.buildTenure({ id: 'L1', community_id: 'c1', property_id: null, kind: 'legacy', vantaca_account_id: 'V9', origin: 'backfill_legacy' }, [{ key: 'ht:z', date: '2026-01-01', amount_cents: -1200, flags: [], opening: false }])];
  const r = oh.exceptionRows([h], legacy, () => 'Community', {});
  assert.deepStrictEqual(r.rows.map((x) => x.kind + ':' + x.status.code), ['owner:debit_remains', 'legacy:legacy_unlinked']);
  assert.strictEqual(r.summary.unknown, 1); assert.strictEqual(r.summary.closed_clean, 0);
  assert.strictEqual(oh.exceptionRows([h], legacy, () => 'Community', { include_unknown: true }).rows.length, 3);
  assert.strictEqual(oh.exceptionRows([h], legacy, () => 'Community', { side: 'credit' }).rows.length, 1);
  assert.strictEqual(oh.exceptionRows([h], legacy, () => 'Community', { include_legacy: false }).rows.length, 1);
  assert.strictEqual(oh.exceptionRows([h], legacy, () => 'Community', { ended_from: '2026-09-01' }).rows.length, 0);
});

t('read-only: the module performs no writes', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/ar/ownership_history'), 'utf8');
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(src), 'ownership_history must not write');
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall ownership-history checks passed');
  process.exitCode = failed ? 1 : 0;
})();
