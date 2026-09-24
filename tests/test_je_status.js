#!/usr/bin/env node
// Regression tests for the voided-entry defect (lib/accounting/je_status.js).
// A void = original marked 'voided' + a posted reversal. Both must count, so the
// pair nets to zero; counting only 'posted' applied every void twice.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { countsInGl, COUNTED_JE_STATUSES } = require('../lib/accounting/je_status');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

// Same shape the statements use: lines carrying their entry; filter by the rule
// and by posting date, then sum per account (debit-positive).
function balances(lines, asOf) {
  const out = {};
  for (const l of lines) {
    if (!countsInGl(l.journal_entries)) continue;
    if (asOf && l.journal_entries.posting_date > asOf) continue;
    out[l.account] = (out[l.account] || 0) + l.debit_cents - l.credit_cents;
  }
  return out;
}
const je = (id, status, posting_date, extra = {}) => ({ id, status, posting_date, ...extra });
const invoice = (e, amt) => [
  { account: '5200', debit_cents: amt, credit_cents: 0, journal_entries: e },
  { account: '2000', debit_cents: 0, credit_cents: amt, journal_entries: e },
];
const reversalOf = (e, amt) => [
  { account: '5200', debit_cents: 0, credit_cents: amt, journal_entries: e },
  { account: '2000', debit_cents: amt, credit_cents: 0, journal_entries: e },
];

t('normal posted JE counts', () => {
  const b = balances(invoice(je('A', 'posted', '2026-07-10'), 10000));
  assert.deepStrictEqual(b, { 5200: 10000, 2000: -10000 });
});

t('voided JE with its reversal nets to zero (not minus the original)', () => {
  const orig = je('A', 'voided', '2026-07-10', { void_reversal_je_id: 'R' });
  const rev = je('R', 'posted', '2026-07-12', { reverses_je_id: 'A' });
  const b = balances([...invoice(orig, 10000), ...reversalOf(rev, 10000)]);
  assert.strictEqual(b['5200'], 0);
  assert.strictEqual(b['2000'], 0);
});

t('void and reversal both before cutover: zero at cutover', () => {
  const orig = je('A', 'voided', '2026-06-30', { void_reversal_je_id: 'R' });
  const rev = je('R', 'posted', '2026-07-28', { reverses_je_id: 'A' });
  const b = balances([...invoice(orig, 298636), ...reversalOf(rev, 298636)], '2026-07-31');
  assert.strictEqual(b['2000'], 0);
  assert.strictEqual(b['5200'], 0);
});

t('original before cutover, reversal after: stands at cutover, zero after', () => {
  const orig = je('A', 'voided', '2026-07-13', { void_reversal_je_id: 'R' });
  const rev = je('R', 'posted', '2026-08-11', { reverses_je_id: 'A' });
  const lines = [...invoice(orig, 76900), ...reversalOf(rev, 76900)];
  assert.deepStrictEqual(balances(lines, '2026-07-31'), { 5200: 76900, 2000: -76900 });
  const after = balances(lines, '2026-08-31');
  assert.strictEqual(after['2000'], 0);
  assert.strictEqual(after['5200'], 0);
});

t('draft entries never count', () => {
  assert.strictEqual(countsInGl(je('D', 'draft', '2026-07-01')), false);
});

t('a voided entry with no reversal does not count', () => {
  assert.strictEqual(countsInGl(je('V', 'voided', '2026-07-01')), false);
});

t('any other status (e.g. a future superseded) does not count', () => {
  assert.strictEqual(countsInGl(je('S', 'superseded', '2026-07-01')), false);
  assert.deepStrictEqual(COUNTED_JE_STATUSES, ['posted', 'voided']);
});

t('every balance surface uses the shared rule (no private status filter left)', () => {
  const root = path.resolve(__dirname, '..');
  const files = ['lib/accounting/financial_statements.js', 'api/books.js', 'api/bank_rec.js', 'api/checks.js', 'lib/askEdTools.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.includes('countsInGl'), `${f} does not use countsInGl`);
    assert.ok(!/\.eq\('journal_entries\.status', 'posted'\)/.test(src), `${f} still filters journal_entries.status = posted`);
    assert.ok(!/\.neq\('journal_entries\.status', 'voided'\)/.test(src), `${f} still excludes voided entries`);
    assert.ok(!/status \|\| 'posted'\) !== 'voided'/.test(src), `${f} still drops voided originals`);
  }
  const sql = fs.readFileSync(path.join(root, 'migrations/453_trial_balance_counted_entries.sql'), 'utf8');
  assert.ok(/je\.status = 'posted'\s+OR \(je\.status = 'voided' AND je\.void_reversal_je_id IS NOT NULL\)/.test(sql), 'v_trial_balance predicate differs from countsInGl');
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exit(failed ? 1 : 0);
