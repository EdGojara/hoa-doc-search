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
const { _parseSummaryText } = require('../lib/enforcement/vantaca_violation_import');

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

console.log(`\n${passed} assertions passed.`);
