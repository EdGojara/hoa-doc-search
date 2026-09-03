// =============================================================================
// tests/test_billing_arc_dedupe.js — billing counts DISTINCT ARC lots
// =============================================================================
// Ed 2026-09-03 (Canyon Gate): the ACC intake can create more than one decided
// record for one application ("a second decision re-bills the ARC fee"), so
// billing off the raw decided count over-bills. The report must count DISTINCT
// lot + project. This proves the dedupe collapses true duplicates, keeps the row
// with the decision letter (evidence), and never collapses genuinely different
// work (two projects on one lot, or a different lot/kind).
//
// Run: node tests/test_billing_arc_dedupe.js   (wired into npm test)
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';

const assert = require('assert');
const { dedupeArcRows } = require('../api/billing');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  PASS  ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}`); console.log(`        ${e.message}`); } }

check('collapses exact same-lot + same-project duplicates', () => {
  const rows = [
    { property: '19918 Juniper Chase Trail', project: 'Replace windows white vinyl', kind: 'Resident ACC', date: '2026-08-21' },
    { property: '19918 Juniper Chase Trail', project: 'Replace windows white vinyl', kind: 'Resident ACC', date: '2026-08-21' },
    { property: '19918 Juniper Chase Trail', project: 'Replace windows white vinyl', kind: 'Resident ACC', date: '2026-08-21' },
    { property: '19918 Juniper Chase Trail', project: 'Replace windows white vinyl', kind: 'Resident ACC', date: '2026-08-21' },
  ];
  assert.strictEqual(dedupeArcRows(rows).length, 1, 'four identical → one billable');
});

check('keeps the duplicate that carries the decision letter', () => {
  const rows = [
    { property: '1 A St', project: 'Fence', kind: 'Resident ACC', date: '2026-08-01' },
    { property: '1 A St', project: 'Fence', kind: 'Resident ACC', date: '2026-08-01', letter_url: 'https://letter' },
  ];
  const out = dedupeArcRows(rows);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].letter_url, 'kept the row with the letter as evidence');
});

check('does NOT collapse two different projects on the same lot', () => {
  const rows = [
    { property: '100 Main St', project: 'Fence', kind: 'Resident ACC', date: '2026-08-01' },
    { property: '100 Main St', project: 'Roof replacement', kind: 'Resident ACC', date: '2026-08-02' },
  ];
  assert.strictEqual(dedupeArcRows(rows).length, 2, 'two distinct pieces of work');
});

check('does NOT collapse different lots or different kinds', () => {
  const rows = [
    { property: '100 Main St', project: 'Fence', kind: 'Resident ACC', date: '2026-08-01' },
    { property: '200 Main St', project: 'Fence', kind: 'Resident ACC', date: '2026-08-01' },
    { property: '100 Main St', project: 'Fence', kind: 'Builder ARC', date: '2026-08-01' },
  ];
  assert.strictEqual(dedupeArcRows(rows).length, 3);
});

check('address punctuation/case differences still collapse', () => {
  const rows = [
    { property: '6411 Grand Canyon Gate Drive, Katy, TX 77450', project: 'Tree removal', kind: 'Resident ACC', date: '2026-08-05' },
    { property: '6411 grand canyon gate dr katy tx 77450', project: 'tree removal', kind: 'Resident ACC', date: '2026-08-05' },
  ];
  assert.strictEqual(dedupeArcRows(rows).length, 1, 'normalized address+project match');
});

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll ARC billing dedupe checks passed.');
