#!/usr/bin/env node
// ============================================================================
// tests/test_legal_review_suggest.js  (Issue #9 step 2, draft-only review)
// ----------------------------------------------------------------------------
// Locks lib/legal/review_suggest.js on synthetic data shaped like the real
// attorney invoices (names/addresses per line; no identity per line; corporate
// advice; collection notices; bankruptcy text):
//   - address + name (or account) corroborated → high, recoverable;
//   - address alone → medium, recoverable only if nothing else is wrong;
//   - name alone never matches; a name that contradicts the owner on file →
//     low, needs review;
//   - address vs account on different properties → conflict, needs review;
//   - service date in a former owner's period → "former", never charged to the
//     current owner; no service date + recent ownership change → "unresolved";
//   - bankruptcy (on file or in the text) → hard stop, needs review;
//   - charge category from the work type; unclear → review;
//   - association/corporate work with no property → association expense;
//   - fees + expenses lines for one property group into one matter;
//   - reconciliation to the cent, and every blocking reason listed.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://x';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const S = require('../lib/legal/review_suggest');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}

const P1 = 'p1', P2 = 'p2', P3 = 'p3';
const ctx = {
  properties: [
    { id: P1, street_address: '4101 Sample Meadow Dr', normalized_address: '4101 sample meadow drive', trusted_account_number: '1000000011', vantaca_account_id: 'XX0000001' },
    { id: P2, street_address: '4202 Example Hollow Ct', normalized_address: '4202 example hollow court', trusted_account_number: '1000000022' },
    { id: P3, street_address: '9903 Fixture Bend Ct', normalized_address: '9903 fixture bend court' },
  ],
  tenures: [
    { id: 't1', property_id: P1, kind: 'owner', start_date: '2018-03-01', end_date: null },
    { id: 't2old', property_id: P2, kind: 'owner', start_date: '2015-01-01', end_date: '2026-06-14' },
    { id: 't2', property_id: P2, kind: 'owner', start_date: '2026-06-15', end_date: null },
    { id: 't3', property_id: P3, kind: 'owner', start_date: '2010-01-01', end_date: null },
  ],
  owners: [
    { property_id: P1, tenure_id: 't1', name: 'Marigold Testerly' },
    { property_id: P2, tenure_id: 't2old', name: 'Quill O. Pemberton' },
    { property_id: P2, tenure_id: 't2', name: 'New Buyer' },
    { property_id: P3, tenure_id: 't3', name: 'Juniper Farrow' },
  ],
  bankruptcyPropertyIds: [],
  legalStates: { [P1]: 'at_legal' },
};
const inv = (lines, over) => Object.assign({ total_cents: lines.reduce((s, l) => s + l.amount_cents, 0), invoice_date: '2026-08-31', service_period_start: null, service_period_end: null }, over || {});
const L = (id, description, amount_cents) => ({ id, description, amount_cents });
const one = (r) => r.items[0].allocations[0];

console.log('test_legal_review_suggest');

t('extract: "Surname, Given - address - Fees" gives name + address', () => {
  const e = S.extractEvidence('Testerly, Marigold - 4101 Sample Meadow Dr. - Fees');
  assert.strictEqual(e.name, 'Testerly, Marigold');
  assert.deepStrictEqual(e.addresses.map((a) => a.normalized), ['4101 sample meadow drive']);
});

t('classify: work types and bankruptcy', () => {
  assert.strictEqual(S.classifyText('Lien Enforcement Notice').category, 'attorney_fee');
  assert.strictEqual(S.classifyText('Preparation of 10 Day - Force Removal of Tree letter').category, 'attorney_fee_other');
  assert.strictEqual(S.classifyText('Review proposed management agreement and provide opinion to Board').association, true);
  assert.strictEqual(S.classifyText('Received Order of Discharge. Chapter 13 Discharge entered').bankruptcy, true);
});

t('address + matching name → high, recoverable, current, category from context', () => {
  const lines = [L('a', 'Testerly, Marigold - 4101 Sample Meadow Dr. - Fees - lien demand', 32400)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.property_id, P1);
  assert.strictEqual(a.confidence, 'high');
  assert.strictEqual(a.tenure_match, 'current');
  assert.strictEqual(a.tenure_id, 't1');
  assert.strictEqual(a.charge_category, 'attorney_fee');
  assert.strictEqual(a.classification, 'homeowner_recoverable');
  assert.ok(a.evidence.some((e) => e.kind === 'legal_status' && /at legal/.test(e.value)));
});

t('fees + expenses lines for one property group into ONE matter, summed', () => {
  const lines = [L('a', 'Testerly, Marigold - 4101 Sample Meadow Dr. - Fees - collection', 32400), L('b', 'Testerly, Marigold - 4101 Sample Meadow Dr. - Expenses', 900)];
  const r = S.suggestReview(inv(lines), lines, ctx);
  assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual(r.items[0].source_line_ids, ['a', 'b']);
  assert.strictEqual(r.items[0].amount_cents, 33300);
  assert.strictEqual(r.reconciliation.reconciled, true);
});

t('unclear work type → property matched but needs review (no category)', () => {
  const lines = [L('a', 'Testerly, Marigold - 4101 Sample Meadow Dr. - Fees', 32400)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.property_id, P1);
  assert.strictEqual(a.classification, 'needs_review');
  assert.ok(a.review_reasons.some((x) => /work type/.test(x)));
});

t('printed name contradicts the owner on file → low confidence, needs review', () => {
  const lines = [L('a', 'Smith, John - 4101 Sample Meadow Dr. - Fees - collection', 5000)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.property_id, P1);
  assert.strictEqual(a.confidence, 'low');
  assert.strictEqual(a.classification, 'needs_review');
});

t('name alone never matches a property', () => {
  const lines = [L('a', 'Testerly, Marigold - collection correspondence', 5000)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.property_id, null);
  assert.strictEqual(a.classification, 'needs_review');
});

t('address and account point at different properties → conflict, no property, needs review', () => {
  const lines = [L('a', 'Collection demand - 4101 Sample Meadow Dr - acct 1000000022', 5000)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.property_id, null);
  assert.ok(a.evidence.some((e) => e.kind === 'conflict'));
  assert.strictEqual(a.classification, 'needs_review');
});

t('address + account agree → high even without a name', () => {
  const lines = [L('a', 'Lien Enforcement Notice 4101 Sample Meadow Dr acct 1000000011', 17000)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.confidence, 'high');
  assert.strictEqual(a.classification, 'homeowner_recoverable');
});

t('service date in a former owner period → "former", never recoverable to the current owner', () => {
  const lines = [L('a', 'Pemberton, Quill O. - 4202 Example Hollow Ct. - Fees - collection', 194400)];
  const a = one(S.suggestReview(inv(lines, { service_period_end: '2026-05-31' }), lines, ctx));
  assert.strictEqual(a.property_id, P2);
  assert.strictEqual(a.tenure_match, 'former');
  assert.strictEqual(a.tenure_id, 't2old');
  assert.strictEqual(a.classification, 'needs_review');
  assert.ok(a.review_reasons.some((x) => /former owner/.test(x)));
});

t('no service date + ownership changed within 180 days of the invoice → "unresolved", needs review', () => {
  const lines = [L('a', '4202 Example Hollow Ct. - Fees - collection', 5000)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.tenure_match, 'unresolved');
  assert.strictEqual(a.tenure_id, null);
  assert.strictEqual(a.classification, 'needs_review');
});

t('bankruptcy in the text → hard stop even with a strong match', () => {
  const lines = [L('a', 'Testerly, Marigold - 4101 Sample Meadow Dr. - reviewed Chapter 13 trustee claim - collection', 6750)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.bankruptcy_stop, true);
  assert.strictEqual(a.classification, 'needs_review');
});

t('bankruptcy on file for the property → hard stop', () => {
  const c2 = Object.assign({}, ctx, { bankruptcyPropertyIds: [P3] });
  const lines = [L('a', 'Farrow, Juniper - 9903 Fixture Bend Ct. - 10 day force removal of tree letter', 13200)];
  const a = one(S.suggestReview(inv(lines), lines, c2));
  assert.strictEqual(a.property_id, P3);
  assert.strictEqual(a.bankruptcy_stop, true);
  assert.strictEqual(a.classification, 'needs_review');
});

t('corporate/association work with no property → association legal expense', () => {
  const lines = [L('a', 'Review proposed management agreement and provide recommendations/opinion to Board regarding same.', 166500)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.classification, 'association_legal_expense');
  assert.strictEqual(a.property_id, null);
  assert.strictEqual(a.charge_category, null);
});

t('a line naming no property (RMWBH style) → needs review pointing at the PDF', () => {
  const lines = [L('a', 'Prepared draft of Release of Abstract of Judgment.', 11500)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.classification, 'needs_review');
  assert.ok(a.review_reasons.some((x) => /check the invoice PDF/.test(x)));
});

t('reconcile: exact to the cent, lists every blocking reason', () => {
  const items = [
    { amount_cents: 1000, allocations: [{ amount_cents: 600, classification: 'homeowner_recoverable', tenure_match: 'current', charge_category: 'attorney_fee' }, { amount_cents: 400, classification: 'association_legal_expense', tenure_match: 'not_applicable' }] },
    { amount_cents: 500, allocations: [{ amount_cents: 500, classification: 'needs_review', tenure_match: 'not_applicable' }] },
  ];
  const r = S.reconcile(1500, items);
  assert.strictEqual(r.reconciled, true);
  assert.strictEqual(r.ready_for_approval, false);
  assert.ok(r.blocking.some((x) => /needs review/.test(x)));
  const off = S.reconcile(1501, items);
  assert.strictEqual(off.reconciled, false);
  assert.strictEqual(off.difference_cents, 1);
  const split = S.reconcile(1000, [{ amount_cents: 1000, allocations: [{ amount_cents: 999, classification: 'association_legal_expense', tenure_match: 'not_applicable' }] }]);
  assert.strictEqual(split.items_balanced, false);
  assert.ok(split.blocking.some((x) => /allocations total 999 of 1000/.test(x)));
});

t('reconcile: recoverable outside the current period or without a category blocks approval', () => {
  const r = S.reconcile(100, [{ amount_cents: 100, allocations: [{ amount_cents: 100, classification: 'homeowner_recoverable', tenure_match: 'former', charge_category: null }] }]);
  assert.ok(r.blocking.some((x) => /outside the current owner/.test(x)));
  assert.ok(r.blocking.some((x) => /no charge category/.test(x)));
});

t('backfilled tenure start (records began) is NOT an ownership change', () => {
  // Every property's current tenure was backfilled with the roster import date.
  const c2 = Object.assign({}, ctx, { tenures: [{ id: 'tb', property_id: P1, kind: 'owner', start_date: '2026-05-26', end_date: null, origin: 'backfill_current' }] });
  const ix = S.buildIndex(c2);
  const noSvc = S.resolveTenure(ix, P1, null, '2026-08-31');
  assert.strictEqual(noSvc.match, 'current');
  assert.strictEqual(noSvc.tenure_id, 'tb');
  // a service date before the placeholder start still falls in that (open-started) period
  assert.strictEqual(S.resolveTenure(ix, P1, '2026-04-30', '2026-08-31').match, 'current');
});

t('a real transfer, or a backfilled start right after a recorded prior period, IS a change', () => {
  const transfer = S.buildIndex(Object.assign({}, ctx, { tenures: [
    { id: 'old', property_id: P1, kind: 'owner', start_date: null, end_date: '2026-07-01', origin: 'backfill_historical' },
    { id: 'new', property_id: P1, kind: 'owner', start_date: '2026-07-02', end_date: null, origin: 'transfer' }] }));
  assert.strictEqual(S.resolveTenure(transfer, P1, null, '2026-08-31').match, 'unresolved');
  assert.strictEqual(S.resolveTenure(transfer, P1, '2026-06-15', '2026-08-31').match, 'former');
  assert.strictEqual(S.resolveTenure(transfer, P1, '2026-07-15', '2026-08-31').tenure_id, 'new');
  const backfillAfterPrior = S.buildIndex(Object.assign({}, ctx, { tenures: [
    { id: 'old', property_id: P1, kind: 'owner', start_date: null, end_date: '2026-06-30', origin: 'backfill_historical' },
    { id: 'cur', property_id: P1, kind: 'owner', start_date: '2026-07-01', end_date: null, origin: 'backfill_current' }] }));
  assert.strictEqual(S.resolveTenure(backfillAfterPrior, P1, null, '2026-08-31').match, 'unresolved');
});

t('names: messy on-file formats still match; surname-only is partial; a different person is a mismatch', () => {
  assert.strictEqual(S.nameVerdict('Quimbly, Rayburn E., Jr. & Folsom, Ursa D.', ['Rayburn, Jr. Quimbly']), 'match');   // suffix moved
  assert.strictEqual(S.nameVerdict('Naylor, Mack & Esterly, Gia', ['M. Naylor/Esterly']), 'match');                        // initial + slash
  assert.strictEqual(S.nameVerdict('Moss, Nate & Arbor, Dana El.', ['Dana El Arbor Nate Moss']), 'match');                 // one contact, both spouses
  assert.strictEqual(S.nameVerdict('Lowry, Fenn Jr. & Yara', ['Jr. , Fenn Lowry']), 'match');                              // shared surname
  assert.strictEqual(S.nameVerdict('Lowry, Rod', ['Fenn Lowry']), 'partial');
  assert.strictEqual(S.nameVerdict('Smith, John', ['Marigold Testerly']), 'mismatch');
  assert.strictEqual(S.nameVerdict('Smith, John', []), null);
});

t('a surname-only (partial) name neither corroborates nor lowers confidence', () => {
  const lines = [L('a', 'Testerly, Rex - 4101 Sample Meadow Dr. - Fees - collection', 5000)];
  const a = one(S.suggestReview(inv(lines), lines, ctx));
  assert.strictEqual(a.confidence, 'medium');
  assert.strictEqual(a.classification, 'homeowner_recoverable');
  assert.ok(a.evidence.some((e) => e.kind === 'name_check' && /surname matches/.test(e.value)));
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
