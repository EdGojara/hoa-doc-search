// Statement tie check uses the transaction lines, not summary totals that may
// already include interest/fees (Ed 2026-11-22: LOPF Reserve Oct false warning).
const assert = require('assert');
const { tieWarnings } = require('../lib/banking/extractors/bank_statement');
// One interest line; the model reports it in BOTH total_deposits and total_interest.
assert.deepStrictEqual(tieWarnings({ beginning_balance_cents: 32698450, ending_balance_cents: 32762951,
  total_deposits_cents: 64501, total_interest_cents: 64501, total_withdrawals_cents: 0,
  transactions: [{ amount_cents: 64501 }] }), [], 'interest counted once');
// Fee inside withdrawals and in total_fees: still ties on lines.
assert.deepStrictEqual(tieWarnings({ beginning_balance_cents: 100000, ending_balance_cents: 89000,
  total_withdrawals_cents: 11000, total_fees_cents: 1000, transactions: [{ amount_cents: -10000 }, { amount_cents: -1000 }] }), []);
// A missing line is still caught.
const w = tieWarnings({ beginning_balance_cents: 100000, ending_balance_cents: 95000, transactions: [{ amount_cents: -3000 }] });
assert.ok(w.length === 1 && /20\.00/.test(w[0]), w.join());
// No lines: falls back to summary totals.
assert.strictEqual(tieWarnings({ beginning_balance_cents: 100, ending_balance_cents: 200, total_deposits_cents: 100, transactions: [] }).length, 0);
assert.strictEqual(tieWarnings({ beginning_balance_cents: 100, ending_balance_cents: 900, total_deposits_cents: 100, transactions: [] }).length, 1);
console.log('test_bank_statement_tie: ok');
