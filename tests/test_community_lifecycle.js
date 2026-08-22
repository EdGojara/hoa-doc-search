// ============================================================================
// tests/test_community_lifecycle.js — losing a client without losing the file.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "we aren't going to onboard eaglewood, we are losing them as a
// client. we need to keep the DRV and ARC in our system but lets not do any
// financials or payments. our last day will be 9/30." Then: "we are going to
// keep in vantaca and stop all migration" and "only DRV and ARC will need to be
// exported later."
//
// communities.active was the only lifecycle state there was, and turning it off
// would have taken DRV and ARC down with everything else. Enforcement has to run
// to the last day — a §209 ladder that goes quiet for six weeks is a statutory
// problem handed to whoever takes over.
//
// These run against injected rows, deliberately. A gate that decides whether a
// check gets cut should not be verifiable only by having the right client
// mid-termination in production.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluate, evaluateFinancials, isPastEnd } = require('../lib/community/lifecycle');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// Eaglewood, exactly as migration 382 leaves it.
const EAGLEWOOD = {
  id: 'eag', name: 'Eaglewood',
  management_status: 'terminating',
  management_end_date: '2026-09-30',
  financials_active: false,
  enforcement_active: true,
  arc_active: true,
  books_of_record: 'vantaca',
  records_handover_due_date: '2026-10-30',
};
// Any community that is simply fine.
const NORMAL = {
  id: 'wv', name: 'Waterview Estates',
  management_status: 'active', management_end_date: null,
  financials_active: true, enforcement_active: true, arc_active: true,
  books_of_record: 'trusted',
};

console.log('\nEaglewood, before the last day');
check('payments are refused', () => {
  const r = evaluate('payments', EAGLEWOOD, '2026-08-21');
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /payments are switched off/i);
});
check('financial work is refused, and says where the books are', () => {
  const r = evaluate('financials', EAGLEWOOD, '2026-08-21');
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /vantaca/i, 'a refusal nobody understands gets worked around');
});
check('DRV keeps running — this is the whole point', () => {
  // A violation case that stops mid-ladder because the engagement is ending is
  // a §209 problem for the next manager, and for the owner.
  assert.strictEqual(evaluate('enforcement', EAGLEWOOD, '2026-08-21').allowed, true);
});
check('ARC keeps running too', () => {
  assert.strictEqual(evaluate('arc', EAGLEWOOD, '2026-08-21').allowed, true);
});

console.log('\nThe last day is still ours');
check('9/30 is not past the end', () => {
  assert.strictEqual(isPastEnd(EAGLEWOOD, '2026-09-30'), false, 'the last day of management is a day we manage');
  assert.strictEqual(evaluate('enforcement', EAGLEWOOD, '2026-09-30').allowed, true);
});
check('10/01 is', () => {
  assert.strictEqual(isPastEnd(EAGLEWOOD, '2026-10-01'), true);
});
check('after the end, even DRV stops', () => {
  const r = evaluate('enforcement', EAGLEWOOD, '2026-10-01');
  assert.strictEqual(r.allowed, false, 'we cannot enforce covenants for an association we no longer represent');
  assert.match(r.reason, /stopped managing/i);
});
check('but the refusal says records are still readable', () => {
  // Only DRV and ARC need exporting, and that happens AFTER the last day. A
  // refusal that reads as "everything is gone" would be wrong and alarming.
  const r = evaluate('enforcement', EAGLEWOOD, '2026-10-15');
  assert.match(r.reason, /read and export/i);
});

console.log('\nStatements from a ledger that is not the books');
check('Eaglewood statements are refused', () => {
  // 179 journal entries for Jan-Aug 2026 sit in trustEd from the cancelled
  // cutover. A balance sheet built from them renders perfectly and is wrong.
  const r = evaluateFinancials(EAGLEWOOD);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /partial/i);
  assert.match(r.reason, /look complete and be wrong/i);
});
check('a normal community renders fine', () => {
  assert.strictEqual(evaluateFinancials(NORMAL).allowed, true);
});
check('books_of_record is what decides it, not the termination', () => {
  // A community can keep its books elsewhere without leaving. Tying this to
  // termination would miss every mid-migration community in the portfolio.
  const midMigration = { ...NORMAL, books_of_record: 'vantaca' };
  assert.strictEqual(evaluateFinancials(midMigration).allowed, false);
  const terminatingButOurs = { ...EAGLEWOOD, books_of_record: 'trusted' };
  assert.strictEqual(evaluateFinancials(terminatingButOurs).allowed, true);
});

console.log('\nEverybody else is untouched');
check('a normal community can do everything', () => {
  for (const s of ['payments', 'financials', 'enforcement', 'arc']) {
    assert.strictEqual(evaluate(s, NORMAL, '2026-08-21').allowed, true, s + ' must be allowed');
  }
});
check('no lifecycle row means no change at all', () => {
  // Before migration 382 runs, every lookup returns null. The platform must
  // behave exactly as it did.
  for (const s of ['payments', 'financials', 'enforcement', 'arc']) {
    assert.strictEqual(evaluate(s, null).allowed, true);
  }
  assert.strictEqual(evaluateFinancials(null).allowed, true);
});
check('an unknown service is not silently refused', () => {
  // A typo'd service name must not become an outage.
  assert.strictEqual(evaluate('something_new', EAGLEWOOD, '2026-08-21').allowed, true);
});

console.log('\nThe flags are actually read');
check('Stripe onboarding checks it', () => {
  // "We aren't going to onboard Eaglewood" was the literal request. Connect
  // onboarding creates an account in the ASSOCIATION's name and asks a board
  // officer for identity documents.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'payments.js'), 'utf8');
  const onboard = src.slice(src.indexOf("router.post('/connect/onboard'"), src.indexOf("router.get('/connect/status'"));
  assert.ok(/canDo\('payments'/.test(onboard), 'onboarding must refuse a community that is winding down');
});
check('checkout checks it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'payments.js'), 'utf8');
  const co = src.slice(src.indexOf("router.post('/create-checkout-session'"));
  assert.ok(/canDo\('payments'/.test(co.slice(0, 4000)), 'never take money for a community we no longer manage');
});
check('the check run checks it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'checks.js'), 'utf8');
  const run = src.slice(src.indexOf("router.post('/run'"));
  assert.ok(/canDo\('financials'/.test(run.slice(0, 2500)),
    'a check is signed on the association account by Bedrock as agent — not after the agency ends');
});
check('the printed statements check it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'gl.js'), 'utf8');
  assert.strictEqual((src.match(/canRenderFinancials/g) || []).length >= 2, true,
    'both the income statement and balance sheet print paths must refuse');
});

console.log(`\ncommunity_lifecycle: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
