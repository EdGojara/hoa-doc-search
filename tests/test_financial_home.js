#!/usr/bin/env node
// ============================================================================
// tests/test_financial_home.js  (Issue #6, Financial slice)
// ----------------------------------------------------------------------------
// Locks the Financial home aggregation (public/app/financial.js):
//   - failed source → "couldn't load" problem, never clear;
//   - 403 source → "not available to your role", never clear, not a problem;
//   - cash the server couldn't compute → "cash not checked", never covered;
//   - cash shortfall leads; errors from readiness lead the attention list;
//   - open conversion exceptions (ledger partial) surface as attention;
//   - the matrix reuses readiness statuses verbatim (no new accounting logic)
//     and puts leaving/prospect communities (all N/A) last;
//   - reconciled / tie counts come only from "ready" readiness cells.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { build } = require('../public/app/financial.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const ok = (data) => ({ ok: true, data });
const area = (key, status, extra) => Object.assign({ key, status, summary: key + ' ' + status, missing: [], href: '/x/' + key }, extra || {});
const rc = (id, name, statuses, extra) => ({
  community: Object.assign({ id, name, management_status: 'active' }, extra || {}),
  areas: ['ledger', 'ar', 'gl', 'budget', 'bank', 'violations'].map((k, i) => area(k, statuses[i] || 'ready')),
});
const clear = {
  edQueue: ok({ invoices: [], cash: [] }),
  managerQueue: ok({ invoices: [] }),
  intake: ok({ exceptions: [] }),
  readiness: ok({ communities: [rc('c1', 'Alpha', ['ready', 'ready', 'imported_not_verified', 'ready', 'ready'])] }),
};

console.log('test_financial_home');

t('all clear → no attention, three quiet, honest headline', () => {
  const r = build(clear);
  assert.strictEqual(r.attention.length, 0);
  assert.deepStrictEqual(r.quiet.map((q) => q.key), ['release', 'manager', 'intake']);
  assert.strictEqual(r.headline, 'Nothing needs financial attention right now.');
});

t('failed source is a problem, never quiet', () => {
  const r = build(Object.assign({}, clear, { managerQueue: { ok: false, status: 500, error: 'boom' } }));
  assert.ok(r.problems.some((p) => p.key === 'manager'));
  assert.ok(!r.quiet.some((q) => q.key === 'manager'));
  assert.strictEqual(r.headline, 'One thing needs financial attention.');
});

t('403 source is "not available", never quiet, not a problem', () => {
  const r = build(Object.assign({}, clear, { edQueue: { ok: false, status: 403, error: 'owner_only' }, intake: { ok: false, status: 403 } }));
  assert.deepStrictEqual(r.unavailable.map((u) => u.key).sort(), ['intake', 'release']);
  assert.ok(!r.quiet.some((q) => q.key === 'release' || q.key === 'intake'));
  assert.strictEqual(r.problems.length, 0);
});

t('cash not computed → "cash not checked", never treated as covered', () => {
  const r = build(Object.assign({}, clear, { edQueue: ok({ invoices: [{ total_cents: 1000, community: 'Alpha' }], cash: [{ community: 'Alpha', count: 1, pending_cents: 1000, operating_cash_cents: null, covered: null }] }) }));
  const rel = r.attention.find((a) => a.key === 'release');
  assert.ok(/Cash not checked for Alpha/.test(rel.detail));
  assert.ok(!r.attention.some((a) => a.key.startsWith('cash_')));
});

t('cash shortfall leads the list', () => {
  const r = build(Object.assign({}, clear, {
    edQueue: ok({ invoices: [{ total_cents: 50000 }], cash: [{ community_id: 'c1', community: 'Alpha', count: 1, pending_cents: 50000, operating_cash_cents: 1000, covered: false }] }),
    managerQueue: ok({ invoices: [{ total_cents: 5, community: 'Beta' }] }),
  }));
  assert.ok(r.attention[0].key.startsWith('cash_'));
});

t('readiness error and open conversion exceptions surface as attention; other gaps stay in the matrix', () => {
  const r = build(Object.assign({}, clear, { readiness: ok({ communities: [
    rc('c1', 'Alpha', ['partial', 'ready', 'imported_not_verified', 'ready', 'partial']),
    rc('c2', 'Beta', ['not_imported', 'imported_not_reconciled', 'imported_not_verified', 'ready', 'error']),
  ] }) }));
  const keys = r.attention.map((a) => a.key);
  assert.ok(keys.includes('rd_c1_ledger'), 'posted conversion with open exceptions');
  assert.ok(keys.includes('rd_c2_bank'), 'bank error');
  assert.ok(!keys.includes('rd_c1_bank'), 'a partial bank rec stays in the matrix');
  assert.ok(!keys.includes('rd_c2_ar'), 'unconverted AR stays in the matrix');
  assert.strictEqual(r.attention[0].key, 'rd_c2_bank', 'errors rank first');
});

t('matrix reuses readiness statuses verbatim and puts all-N/A communities last', () => {
  const r = build(Object.assign({}, clear, { readiness: ok({ communities: [
    rc('c9', 'Leaving', ['not_applicable', 'not_applicable', 'not_applicable', 'not_applicable', 'not_applicable'], { management_status: 'terminating' }),
    rc('c1', 'Alpha', ['ready', 'imported_not_reconciled', 'partial', 'ready', 'in_progress']),
  ] }) }));
  assert.strictEqual(r.matrix[0].community.name, 'Alpha');
  assert.deepStrictEqual(r.matrix[0].cells.map((c) => c.status), ['ready', 'imported_not_reconciled', 'partial', 'ready', 'in_progress']);
  assert.strictEqual(r.matrix[1].not_applicable, true);
  assert.strictEqual(r.counts.communities, 1, 'leaving community not counted as managed');
});

t('reconciled / tie counts come only from ready cells', () => {
  const r = build(Object.assign({}, clear, { readiness: ok({ communities: [
    rc('c1', 'Alpha', ['ready', 'ready', 'imported_not_verified', 'ready', 'ready']),
    rc('c2', 'Beta', ['not_imported', 'imported_not_reconciled', 'imported_not_verified', 'ready', 'partial']),
    rc('c3', 'Gamma', ['not_applicable', 'not_applicable', 'not_applicable', 'not_applicable', 'not_applicable']),
  ] }) }));
  assert.strictEqual(r.counts.ar_ties, 1);
  assert.strictEqual(r.counts.ar_comparable, 1, 'only converted communities are comparable');
  assert.strictEqual(r.counts.ar_awaiting, 1, 'unconverted AR is awaiting conversion, not a miss');
  assert.strictEqual(r.counts.bank_reconciled, 1);
  assert.strictEqual(r.counts.not_ready, 1);
});

t('readiness failure is a problem and leaves an empty matrix, not a clean one', () => {
  const r = build(Object.assign({}, clear, { readiness: { ok: false, status: 500, error: 'x' } }));
  assert.ok(r.problems.some((p) => p.key === 'readiness'));
  assert.strictEqual(r.matrix.length, 0);
  assert.strictEqual(r.counts.communities, undefined);
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
