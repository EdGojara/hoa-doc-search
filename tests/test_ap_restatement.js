// Tests for prior-period restatement detection (lib/ap/statement_lines.js).
// Scar: Fort Bend County Sheriff restacks prior months as positive "Outstanding
// Invoice" lines + re-lists a mid-year true-up every month. Emma must pay only
// the current month. (Ed 2026-09-04.)
const assert = require('assert');
const { classifyRestatement, classifyStatement } = require('../lib/ap/statement_lines');

let failures = 0;
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ' — ' + e.message); } }

// The real Sheriff 26-11S shape (August current + true-up + June + July).
const sheriff = [
  { line_number: 1, id: 'a', amount_cents: 1423000, description: 'August Contract Deputy Service per 2026 Contract' },
  { line_number: 2, id: 'b', amount_cents: -500000, description: 'Mid-Year True Up FY26' },
  { line_number: 3, id: 'c', amount_cents: 1423000, description: '2609S - Outstanding Invoice - June' },
  { line_number: 4, id: 'd', amount_cents: 1423000, description: '2610S - Outstanding Invoice - July' },
];

check('Sheriff bill is flagged as a restatement', () => {
  const r = classifyRestatement(sheriff);
  assert.strictEqual(r.is_restatement, true, 'should be a restatement');
});
check('current-month payable is $14,230 (August only)', () => {
  const r = classifyRestatement(sheriff);
  assert.strictEqual(r.current_cents, 1423000, 'current_cents should be 1423000, got ' + r.current_cents);
});
check('true-up + both outstanding lines are held', () => {
  const r = classifyRestatement(sheriff);
  assert.deepStrictEqual([...r.held_line_numbers].sort(), [2, 3, 4], 'held lines should be 2,3,4');
  assert.deepStrictEqual(r.held_line_ids.sort(), ['b', 'c', 'd']);
  assert.strictEqual(r.prior_period_count, 2, 'two prior-period lines');
  assert.strictEqual(r.has_adjustment, true, 'true-up is an adjustment');
});
check('held lines + current sum back to the billed total', () => {
  const r = classifyRestatement(sheriff);
  assert.strictEqual(r.current_cents + r.held_cents, 3769000, 'should reconstruct $37,690');
});

// A plain single-line current bill must NOT be a restatement.
check('normal single-line bill is not a restatement', () => {
  const r = classifyRestatement([{ line_number: 1, amount_cents: 50000, description: 'August Landscaping' }]);
  assert.strictEqual(r.is_restatement, false);
});

// A MUD-style net-payment bill (Previous Balance + Payment Received + current)
// is handled by classifyStatement, NOT restatement — must not double-flag.
const mud = [
  { line_number: 1, amount_cents: 8370, description: 'Previous Balance' },
  { line_number: 2, amount_cents: -8370, description: 'Payment Received' },
  { line_number: 3, amount_cents: 1925, description: 'Water Charges' },
  { line_number: 4, amount_cents: 1480, description: 'Fire Protection Services' },
];
check('MUD net-payment bill is NOT a restatement', () => {
  const r = classifyRestatement(mud);
  assert.strictEqual(r.is_restatement, false, '"Previous Balance" must not trip restatement');
});
check('MUD net-payment bill still classifies as a statement', () => {
  const s = classifyStatement(mud);
  assert.strictEqual(s.is_statement, true, 'Payment Received should make it a statement');
});

if (failures) { console.error('\n' + failures + ' restatement test(s) failed.'); process.exit(1); }
console.log('\nAll restatement tests passed.');
