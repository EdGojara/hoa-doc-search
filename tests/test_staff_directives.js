#!/usr/bin/env node
// ============================================================================
// test_staff_directives.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// When a Bedrock staffer forwards a bill to emma@ with coding instructions,
// Emma EXECUTES them. She does not re-guess, and she does not silently drop
// half of them.
//
// THIS SCAR HAS NOW FIRED TWICE.
//
//   Water Logic #21245  — Celina wrote "code to 5125" and Emma booked 5120.
//                         Fixed 2026-07-31 by matchGlDirective.
//   Lake Pro  #262093   — Celina wrote:
//                             $700.00 to GL Code 5130
//                             $485.22 to GL Code 5140
//                         and the entire $1,185.22 landed in 5130. The $485.22
//                         for 5140 was simply lost.
//
// The second miss had two causes worth remembering:
//
//   1. matchGlDirective returns ONE account. It finds it by walking the
//      community's CHART and returning the first number appearing anywhere in
//      the note — so with two codes present, which one won was decided by chart
//      ordering (5130 sits at position 35, 5140 at 36), not by what Celina
//      wrote. A staffer reordering the chart would have changed the posting.
//
//   2. The first split parser written to fix it ALSO failed, on the trailing
//      "Total invoice $1,185.22" line: a loose [\d,]+ read that as amount "1,"
//      and account "185", and since 185 is on no chart the unknown-code guard
//      refused the whole split. It returned null on the exact note it was
//      written for.
//
// Per CLAUDE.md: a scar that recurs becomes a check, not another paragraph.
//
//   node tests/test_staff_directives.js     # or: npm run test:directives
// ============================================================================
const { matchGlDirective, matchGlSplitDirective } = require('../lib/ap/staff_directives');

// A realistic slice of a community chart, including neighbouring numbers so an
// off-by-one match is visible.
const CHART = [
  { id: 'a', account_number: '5120', account_name: 'Pool Maintenance' },
  { id: 'b', account_number: '5125', account_name: 'Irrigation Repair & Maintenance' },
  { id: 'c', account_number: '5130', account_name: 'Fountain/Lake Operating & Management' },
  { id: 'd', account_number: '5140', account_name: 'Fountains/Lake Service & Repairs' },
];
const acct = (n) => CHART.find((a) => a.account_number === n).id;

// Verbatim from Celina's forward, trailing total included — that line is what
// broke the first attempt.
const LAKE_PRO = [
  'Please process and post the invoice attached for Lake of Pine Forest.',
  '$700.00 to GL Code 5130',
  '$485.22 to GL Code 5140',
  'Total invoice $1,185.22',
].join('\n');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\nStaff coding directives — Emma executes them, exactly\n');

check('Celina\'s Lake Pro split is parsed', () => {
  const r = matchGlSplitDirective(LAKE_PRO, CHART);
  assert(r, 'returned null on the note this was written for');
  assert(r.lines.length === 2, 'expected 2 lines, got ' + r.lines.length);
});

check('the split lands on the right accounts for the right amounts', () => {
  const r = matchGlSplitDirective(LAKE_PRO, CHART);
  const by = Object.fromEntries(r.lines.map((l) => [l.account_number, l.amount_cents]));
  assert(by['5130'] === 70000, '5130 should be $700.00, got ' + (by['5130'] / 100));
  assert(by['5140'] === 48522, '5140 should be $485.22, got ' + (by['5140'] / 100));
});

check('the split reconciles to the invoice total', () => {
  const r = matchGlSplitDirective(LAKE_PRO, CHART);
  assert(r.total_cents === 118522, 'expected $1,185.22, got ' + (r.total_cents / 100));
});

check('the trailing "Total invoice $1,185.22" creates no phantom account', () => {
  const r = matchGlSplitDirective(LAKE_PRO, CHART);
  assert(r, 'the total line still voids the split');
  assert(!r.lines.some((l) => l.account_number === '185'), 'parsed "185" out of "1,185.22"');
});

check('a comma-grouped amount is not split into amount + account', () => {
  const r = matchGlSplitDirective('$1,200.00 to 5130\n$485.22 to 5140', CHART);
  assert(r, 'returned null');
  const by = Object.fromEntries(r.lines.map((l) => [l.account_number, l.amount_cents]));
  assert(by['5130'] === 120000, '$1,200.00 misread as ' + (by['5130'] / 100));
});

check('a single "code to 5125" is NOT treated as a split', () => {
  assert(matchGlSplitDirective('code to 5125', CHART) === null, 'one account is not a split');
});

check('the Water Logic case still works through the single matcher', () => {
  const r = matchGlDirective('Upload invoice for Waterview, code to 5125', CHART);
  assert(r && r.account_number === '5125', 'got ' + (r && r.account_number));
});

check('an account not on the chart refuses the WHOLE split', () => {
  assert(matchGlSplitDirective('$100.00 to 5130\n$50.00 to 9999', CHART) === null,
    'a partial split would post an unbalanced bill');
});

check('the same account twice is a correction, not a split', () => {
  assert(matchGlSplitDirective('$100.00 to 5130\n$50.00 to 5130', CHART) === null,
    'should collapse to one account rather than double-post');
});

check('three-way splits work', () => {
  const r = matchGlSplitDirective('$100.00 to 5120\n$200.00 to 5125\n$300.00 to 5130', CHART);
  assert(r && r.lines.length === 3, 'expected 3 lines, got ' + (r && r.lines.length));
  assert(r.total_cents === 60000, 'expected $600.00, got ' + (r.total_cents / 100));
});

check('alternate phrasings a staffer might actually type', () => {
  for (const t of [
    '700.00 - 5130\n485.22 - 5140',
    '$700 gl 5130\n$485.22 gl 5140',
    '$700.00 account 5130\n$485.22 account 5140',
  ]) {
    const r = matchGlSplitDirective(t, CHART);
    assert(r && r.lines.length === 2, 'failed on: ' + t.replace(/\n/g, ' / '));
  }
});

check('every returned account id is real', () => {
  const r = matchGlSplitDirective(LAKE_PRO, CHART);
  for (const l of r.lines) {
    assert([acct('5130'), acct('5140')].includes(l.account_id), 'invented an account id');
  }
});

if (fail) {
  console.error(`\n✗ ${fail} check(s) failed.`);
  console.error('  A written instruction from a colleague is not a suggestion.\n');
  process.exit(1);
}
console.log(`\n✓ Staff directives: all ${pass} checks passed.\n`);
