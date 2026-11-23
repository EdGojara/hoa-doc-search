// Reconciled / Unreconciled / Stale (lib/banking/rec_standing.js, Ed 2026-11-21).
// An approval is not a reconciliation; a reconciliation the GL moved under is stale.
const assert = require('assert');
const { decideStanding } = require('../lib/banking/rec_standing');

const clean = { status: 'reconciled', difference_cents: 0 };
const same = { gl_now_cents: 100, gl_saved_cents: 100, changed_after_save: 0 };

// Reconciled: balances, nothing open, every bank item in the GL, GL unchanged.
assert.strictEqual(decideStanding(clean, { ...same, bank_only_count: 0 }).standing, 'reconciled');

// No reconciliation at all.
assert.strictEqual(decideStanding(null).standing, 'unreconciled');

// Exceptions open (stored in_progress) with difference 0: approved but NOT reconciled.
let d = decideStanding({ status: 'in_progress', difference_cents: 0 }, { ...same, approved: true });
assert.strictEqual(d.standing, 'unreconciled');
assert.ok(d.reasons.some((r) => /open/.test(r)));

// Difference 0 reached only by bank items missing from the GL: not reconciled.
d = decideStanding(clean, { ...same, bank_only_count: 3 });
assert.strictEqual(d.standing, 'unreconciled');
assert.ok(d.reasons.some((r) => /3 bank items not in the GL/.test(r)));

// Off by a difference.
assert.strictEqual(decideStanding({ status: 'unbalanced', difference_cents: 4793 }, same).standing, 'unreconciled');

// Stale: reconciled, then the GL balance at period end moved.
d = decideStanding(clean, { gl_now_cents: 500000, gl_saved_cents: 450000, changed_after_save: 0 });
assert.strictEqual(d.standing, 'stale');

// Stale: reconciled, balance the same, but an entry for the period changed after the save.
assert.strictEqual(decideStanding(clean, { ...same, changed_after_save: 2 }).standing, 'stale');

// Stale: approved with exceptions open, then the GL changed.
d = decideStanding({ status: 'in_progress', difference_cents: 0 }, { approved: true, gl_now_cents: 500000, gl_saved_cents: 450000, changed_after_save: 6 });
assert.strictEqual(d.standing, 'stale');
assert.ok(d.reasons[0].includes('5000.00') && d.reasons[0].includes('4500.00'));

// Not approved, not reconciled, GL changed: plainly unreconciled (nothing was ever claimed).
assert.strictEqual(decideStanding({ status: 'in_progress', difference_cents: 0 }, { approved: false, gl_now_cents: 1, gl_saved_cents: 2 }).standing, 'unreconciled');

// Unknown saved GL never by itself makes a reconciliation stale; a later change still does.
assert.strictEqual(decideStanding(clean, { gl_now_cents: 5, gl_saved_cents: null, changed_after_save: 0 }).standing, 'reconciled');
assert.strictEqual(decideStanding(clean, { gl_now_cents: 5, gl_saved_cents: null, changed_after_save: 1 }).standing, 'stale');

console.log('test_bank_rec_standing: ok');
