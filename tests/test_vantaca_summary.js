// ============================================================================
// tests/test_vantaca_summary.js — Run: node tests/test_vantaca_summary.js
//
// Proves the printed-SUMMARY total parser that powers the import coverage
// cross-check (catches detail-row under-extraction: "report says 34 certified,
// we parsed 11"). Mirrors the real Waterview 5/31 report layout where status
// labels are concatenated to their counts ("Certified Letter Notice34") and the
// per-property detail tables begin at "(Total Count =".
// ============================================================================

const assert = require('assert');
const { _parseSummaryText, _parseSsrsStatusString, _normalizeStage } = require('../lib/enforcement/vantaca_violation_import');

let passed = 0;
function check(name, cond) { assert.ok(cond, `FAIL: ${name}`); passed += 1; console.log(`  ✓ ${name}`); }

// Shape taken from the actual Waterview report's extracted text.
const SUMMARY = `
Violation Report - Detail for 1/1/2026 - 5/31/2026
Waterview Estates Homeowners Association, Inc
SUMMARY
Certified Letter Notice34
Fences 8
Mildew 5
Closed901
Fences 64
Mow 87
First Notice118
Storage Of Unapproved Items 17
Owner Response2
Pending Hearing34
Sod Yard 7
Resolved1
Second Notice54
Void6
1150
Closed (Total Count = 901)
5307 Baldwin Elm Street  Farid Ahmad Abdullah First Notice - 05/06/2026
`;

const r = _parseSummaryText(SUMMARY);
check('summary parsed (non-null)', r !== null);
check('First Notice → courtesy_1 = 118', r.by_stage.courtesy_1 === 118);
check('Second Notice → courtesy_2 = 54', r.by_stage.courtesy_2 === 54);
// Certified Letter Notice (34) + Pending Hearing (34) fold into certified_209.
check('Certified + Pending Hearing → certified_209 = 68', r.by_stage.certified_209 === 68);
check('Closed (901) + Resolved (1) → cured = 902', r.by_stage.cured === 902);
check('Void → voided = 6', r.by_stage.voided === 6);
check('Owner Response tracked separately = 2', r.by_stage.owner_response === 2);
// Per-label totals preserved for display.
check('by_label keeps Certified Letter Notice = 34', r.by_label['Certified Letter Notice'] === 34);
check('by_label keeps Pending Hearing = 34', r.by_label['Pending Hearing'] === 34);

// "First Notice" appears again in the DETAIL section (after the cut marker) as a
// status string — must NOT be double-counted. 118 stays 118.
check('detail-section status strings are not double-counted', r.by_stage.courtesy_1 === 118);

// No summary → null (e.g. a CSV with no printed totals).
check('text without labels → null', _parseSummaryText('just some unrelated text') === null);
check('empty text → null', _parseSummaryText('') === null);

// ----------------------------------------------------------------------------
// Multi-event status strings: the current status is the LATEST event, with its
// date — not the first. This is the bug that stored escalated cases as Courtesy 1
// and dated the cert clock from the first-notice day.
// ----------------------------------------------------------------------------
{
  const hist = 'First Notice - 02/23/2026 - Pennie; Second Notice - 03/25/2026 - Jen; Certified Letter Notice - 04/28/2026 - Lizette';
  const r = _parseSsrsStatusString(hist);
  check('multi-event picks the latest status label', r.stageLabel === 'Certified Letter Notice');
  check('multi-event uses the latest event date', r.date === '2026-04-28');
  check('multi-event maps to certified_209', _normalizeStage(r.stageLabel) === 'certified_209');

  // History that ends in closure → current status is Closed, even though
  // Certified ranks higher on the ladder.
  const closedHist = 'First Notice - 02/23/2026 - X; Certified Letter Notice - 03/25/2026 - Y; Closed - 05/01/2026 - Z';
  const rc = _parseSsrsStatusString(closedHist);
  check('history ending in closure → Closed (by date, not rank)', rc.stageLabel === 'Closed');
  check('closed history uses the closure date', rc.date === '2026-05-01');

  // Single event still works exactly as before.
  const single = _parseSsrsStatusString('First Notice - 05/06/2026 - Jennifer Flores');
  check('single event unchanged', single.stageLabel === 'First Notice' && single.date === '2026-05-06');

  // No date at all → returns the raw label, null date (unchanged contract).
  const noDate = _parseSsrsStatusString('Some Status With No Date');
  check('no-date status → raw label, null date', noDate.stageLabel === 'Some Status With No Date' && noDate.date === null);
}

console.log(`\n${passed} assertions passed.`);
