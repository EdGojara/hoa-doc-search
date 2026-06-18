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

// ----------------------------------------------------------------------------
// Grouped "Violation Report - Detail" parser: stage comes from the SECTION
// HEADER (authoritative current status), date from the following status row.
// ----------------------------------------------------------------------------
{
  const { _parseVantacaGroupedReport } = require('../lib/enforcement/vantaca_violation_import');
  // Build an AOA mirroring the real layout: col0=$XN, col2=account, col3=owner,
  // col5=address, col9=category (identity row) / status (status row).
  const row = (cells) => { const a = []; for (const [i, v] of Object.entries(cells)) a[i] = v; return a; };
  const aoa = [
    ['Waterview Estates HOA'],
    ['Violation Report - Detail for 1/1/2026 - 5/31/2026'],
    ['SUMMARY'],
    ['Closed', null, null, null, '$2'],
    ['Closed (Total Count = 2)'],
    row({ 0: 'XN', 2: 'Account', 3: 'Homeowner', 5: 'Address', 8: 'Hearing Date', 10: 'Details' }),
    row({ 0: '$1', 2: '10110115', 3: 'John Doe', 5: '5307 Baldwin Elm Street', 9: 'Sod Yard' }),
    [],
    row({ 9: 'Closed - 01/14/2026 - Pennie Mancuso' }),
    row({ 0: '$2', 2: '10110116', 3: 'Jane Roe', 5: '5319 Baldwin Elm Street', 9: 'Mow' }),
    [],
    row({ 9: 'Closed - 02/01/2026 - Pennie Mancuso' }),
    ['First Notice (Total Count = 1)'],
    row({ 0: 'XN', 2: 'Account', 3: 'Homeowner', 5: 'Address', 8: 'Hearing Date', 10: 'Details' }),
    row({ 0: '$3', 2: '10110200', 3: 'Bob Smith', 5: '100 Main St', 9: 'Fences' }),
    [],
    row({ 9: 'First Notice - 05/06/2026 - Jen' }),
    ['Certified Letter Notice (Total Count = 1)'],
    row({ 0: 'XN', 2: 'Account', 3: 'Homeowner', 5: 'Address', 8: 'Hearing Date', 10: 'Details' }),
    row({ 0: '$4', 2: '10110300', 3: 'Amy Lee', 5: '200 Oak Ave', 9: 'Mildew' }),
    [],
    row({ 9: 'Certified Letter Notice - 04/28/2026 - Liz' }),
  ];
  const out = _parseVantacaGroupedReport(aoa);
  check('grouped: parsed 4 violations', out.rows.length === 4);
  check('grouped: source tag set', out.mapping._source === 'vantaca_grouped_report');
  const byAcct = Object.fromEntries(out.rows.map((r) => [r.vantaca_account_id, r]));
  check('grouped: Closed row → cured (from section header)', byAcct['10110115'].stage === 'cured');
  check('grouped: Closed row carries the closure date', byAcct['10110115'].opened_at === '2026-01-14');
  check('grouped: Closed row has resolved_at', byAcct['10110115'].resolved_at === '2026-01-14');
  check('grouped: First Notice → courtesy_1', byAcct['10110200'].stage === 'courtesy_1');
  check('grouped: Certified → certified_209', byAcct['10110300'].stage === 'certified_209');
  check('grouped: Certified uses the cert date', byAcct['10110300'].opened_at === '2026-04-28');
  check('grouped: category from identity row', byAcct['10110300'].category_label === 'Mildew');
}

console.log(`\n${passed} assertions passed.`);
