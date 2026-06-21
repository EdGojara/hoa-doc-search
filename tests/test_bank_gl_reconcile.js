// ============================================================================
// tests/test_bank_gl_reconcile.js
// ----------------------------------------------------------------------------
// Locks the bank↔GL reconciliation behaviors added 2026-06-21:
//   • payment-batch: one bank check ↔ several GL invoice lines summing to it
//   • opening position: pre-cutover checks/deposits clear forward; uncleared carry
//   • deterministic bank ordering (oldest-first) so batches don't get stolen
// Synthetic fixtures (no PII). Run: node tests/test_bank_gl_reconcile.js
// ============================================================================

const assert = require('assert');
const { reconcile } = require('../lib/banking/matcher');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; }

// --- payment batch: bank check $990.60 = GL lines 550 + 400 + 25 + 15.60 ----
{
  const bank = [{ posting_date: '2025-11-14', amount_cents: -99060, transaction_type: 'check', check_number: '18', description: 'Check #18' }];
  const gl = [
    { ref: 'a', posting_date: '2025-11-11', entry_type: 'payment', amount_signed_cents: -55000, description: 'Mgmt fee' },
    { ref: 'b', posting_date: '2025-11-11', entry_type: 'payment', amount_signed_cents: -40000, description: 'Service' },
    { ref: 'c', posting_date: '2025-11-11', entry_type: 'payment', amount_signed_cents: -2500, description: 'Misc' },
    { ref: 'd', posting_date: '2025-11-11', entry_type: 'payment', amount_signed_cents: -1560, description: 'Misc2' },
  ];
  const r = reconcile({ bankTransactions: bank, glEntries: gl, bankEndingCents: -99060, glEndingCents: -99060, bookIsComplete: true });
  const pb = r.items.find((i) => i.match_method === 'payment_batch');
  ok('payment_batch matches one check to 4 GL lines', pb && pb.gl_ref.split(', ').length === 4);
  ok('payment-batch run reconciles to 0', r.summary.balanced);
}

// --- opening position: cleared + carried-forward --------------------------
{
  const opening = {
    as_of_date: '2025-08-31',
    outstanding_checks: [
      { check_number: '7', amount_cents: 55000 },   // clears on the bank below
      { check_number: '9', amount_cents: 10000 },   // never clears → carries forward
    ],
    deposits_in_transit: [{ amount_cents: 294535, date: '2025-08-29' }], // clears below
  };
  // book = bank + opening DIT(2945.35) − opening OC still outstanding(100.00)
  const bank = [
    { posting_date: '2025-09-02', amount_cents: -55000, transaction_type: 'check', check_number: '7', description: 'Check #7' },
    { posting_date: '2025-09-03', amount_cents: 294535, transaction_type: 'deposit', description: 'DEPOSIT' },
  ];
  // The cleared opening items (#7, the deposit) are already reflected in the
  // bank ending balance; only the UNCLEARED opening check #9 still adjusts it.
  const bankEnding = 100000;
  const glEnding = bankEnding - 10000; // bank − uncleared opening OC #9
  const r = reconcile({ bankTransactions: bank, glEntries: [], openingPosition: opening, bankEndingCents: bankEnding, glEndingCents: glEnding, bookIsComplete: true });
  ok('opening check #7 cleared (not bank_only)', r.items.some((i) => i.match_method === 'opening_check_cleared'));
  ok('opening deposit cleared', r.items.some((i) => i.match_method === 'opening_deposit_cleared'));
  ok('uncleared opening check #9 carries as outstanding', r.items.some((i) => i.category === 'outstanding_check' && i.check_number === '9' && i.amount_cents === -10000));
  ok('opening-position run reconciles to 0', r.summary.balanced);
}

// --- deterministic ordering: result independent of input bank order --------
{
  const gl = [
    { ref: 'x', posting_date: '2025-11-11', entry_type: 'payment', amount_signed_cents: -55000, description: 'fee' },
    { ref: 'y', posting_date: '2025-11-11', entry_type: 'payment', amount_signed_cents: -40000, description: 'svc' },
  ];
  const a = [
    { posting_date: '2025-12-05', amount_cents: -55000, transaction_type: 'check', check_number: '30', description: 'Dec check' },
    { posting_date: '2025-11-14', amount_cents: -40000, transaction_type: 'check', check_number: '18', description: 'Nov check' },
  ];
  const b = [a[1], a[0]]; // reversed input order
  const ra = reconcile({ bankTransactions: a, glEntries: gl.slice(), bankEndingCents: -95000, glEndingCents: -95000, bookIsComplete: true });
  const rb = reconcile({ bankTransactions: b, glEntries: gl.slice(), bankEndingCents: -95000, glEndingCents: -95000, bookIsComplete: true });
  ok('same difference regardless of bank input order', ra.summary.difference_cents === rb.summary.difference_cents);
  ok('same matched count regardless of bank input order', ra.summary.counts.matched === rb.summary.counts.matched);
  ok('Nov check ($400) claims its Nov-11 GL line (oldest-first)',
    ra.items.some((i) => i.category === 'matched' && i.amount_cents === -40000));
}

console.log(`\n${passed} assertions passed.`);
