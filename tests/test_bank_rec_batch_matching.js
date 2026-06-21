// ============================================================================
// tests/test_bank_rec_batch_matching.js
// ----------------------------------------------------------------------------
// Regression test for the batched-deposit pass in lib/banking/matcher.js.
//
// Real scar this guards: Vantaca records each homeowner payment individually in
// the deposit register but deposits them to the bank in BATCHES (one
// "VANTACA - PAYOUT" credit covers several payments). A 1:1 matcher leaves every
// individual payment as a permanent deposit_in_transit that never clears —
// surfaced on Quail Ridge's Feb/Mar/Apr 2026 recs as a ~$2,600 rolling
// "out of balance" that Vantaca itself reported as reconciled.
//
// The batch pass must:
//   • group a subset of GL deposit entries that sums to a batched bank credit
//   • still match unambiguous 1:1 lockbox deposits
//   • leave a genuinely-uncleared deposit as deposit_in_transit
//   • leave an unmatchable bank credit as bank_only (no FALSE batch match)
//
// Run: node tests/test_bank_rec_batch_matching.js   (exit 1 on failure)
// ============================================================================

const assert = require('assert');
const { reconcile } = require('../lib/banking/matcher');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ✓', name); }
  else { console.log('  ✗', name); failures++; }
}

// --- Scenario: mirrors the real Quail Ridge batched-payout pattern -----------
const bank = [
  { id: 'b1', posting_date: '2026-02-05', amount_cents: 83000, transaction_type: 'ach_in',  description: 'VANTACA - PAYOUT' }, // = 260+285+285
  { id: 'b2', posting_date: '2026-02-12', amount_cents: 54500, transaction_type: 'ach_in',  description: 'VANTACA - PAYOUT' }, // = 260+285
  { id: 'b3', posting_date: '2026-02-16', amount_cents: 26150, transaction_type: 'deposit', description: 'LOCKBOX DEPOSIT' },  // unique → 1:1
  { id: 'b4', posting_date: '2026-02-20', amount_cents: 99999, transaction_type: 'ach_in',  description: 'VANTACA - PAYOUT' }, // matches nothing → bank_only
];
const gl = [
  { ref: 'g1', posting_date: '2026-02-03', entry_type: 'deposit', amount_signed_cents: 26000, description: 'p1' },
  { ref: 'g2', posting_date: '2026-02-03', entry_type: 'deposit', amount_signed_cents: 28500, description: 'p2' },
  { ref: 'g3', posting_date: '2026-02-04', entry_type: 'deposit', amount_signed_cents: 28500, description: 'p3' },
  { ref: 'g4', posting_date: '2026-02-10', entry_type: 'deposit', amount_signed_cents: 26000, description: 'p4' },
  { ref: 'g5', posting_date: '2026-02-11', entry_type: 'deposit', amount_signed_cents: 28500, description: 'p5' },
  { ref: 'g6', posting_date: '2026-02-16', entry_type: 'deposit', amount_signed_cents: 26150, description: 'lockbox' },
  { ref: 'g7', posting_date: '2026-02-27', entry_type: 'deposit', amount_signed_cents: 28820, description: '001 Items on Deposit Slip (genuine DIT)' },
];
const bankEnd = 83000 + 54500 + 26150 + 99999;
const glEnd = bankEnd - 99999 + 28820; // drop the phantom bank_only, add the genuine DIT → should balance

const r = reconcile({ bankTransactions: bank, checkRegisterChecks: [], glEntries: gl, bankEndingCents: bankEnd, glEndingCents: glEnd });
const batches = r.items.filter((i) => i.match_method === 'batch_deposit');

console.log('Batch-deposit matcher:');
check('two batched deposits matched', batches.length === 2);
check('$830 batch grouped 3 payments', batches.some((b) => b.amount_cents === 83000 && b.gl_ref.split(', ').length === 3));
check('$545 batch grouped 2 payments', batches.some((b) => b.amount_cents === 54500 && b.gl_ref.split(', ').length === 2));
check('unambiguous lockbox still matched 1:1', r.items.filter((i) => i.match_method === 'amount_date_proximity').length === 1);
check('genuine deposit stays in transit ($288.20)', r.summary.counts.deposit_in_transit === 1 && r.summary.deposits_in_transit_total_cents === 28820);
check('unmatchable bank credit stays bank_only (no false batch)', r.summary.counts.bank_only === 1 && r.summary.bank_only_adjustments_cents === 99999);
check('rec balances', r.summary.balanced === true && r.summary.difference_cents === 0);

// --- Guard: subset-sum must not hang on a large all-equal pool ---------------
const bigPool = Array.from({ length: 40 }, (_, i) => ({ ref: 'x' + i, posting_date: '2026-02-10', entry_type: 'deposit', amount_signed_cents: 10000 }));
const t0 = Date.now();
const r2 = reconcile({
  bankTransactions: [{ id: 'z', posting_date: '2026-02-12', amount_cents: 30000, transaction_type: 'ach_in', description: 'VANTACA - PAYOUT' }],
  glEntries: bigPool, bankEndingCents: 30000, glEndingCents: 30000,
});
check('large pool resolves quickly (<2s)', Date.now() - t0 < 2000);
check('large pool batch matched 3×$100', r2.items.some((i) => i.match_method === 'batch_deposit' && i.amount_cents === 30000));

if (failures) { console.log(`\nFAILED: ${failures} assertion(s)`); process.exit(1); }
console.log('\nAll batch-matching assertions passed ✓');
