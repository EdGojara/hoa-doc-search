#!/usr/bin/env node
// tests/test_budget_four_columns.js  (Ed 2026-10-12)
// ----------------------------------------------------------------------------
// The budget screen's four columns: (1) base-year ADOPTED budget, (2) base-year ACTUAL YTD
// through ONE displayed GL cutoff, (3) base-year FORECAST = actual through the cutoff + each
// account's remaining months by a named method (never annualized), (4) PROPOSED = the saved
// amounts, exactly. Cases mirror Canyon Gate's GL 4000, 4030, 4070, 4100, 5010 and the
// $164,000 Operating-to-Reserve transfer (4010) at the 2026-09-30 cutoff.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'x';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WF = require('../lib/forecast/working_forecast');
const { applySavedDraft } = require('../lib/accounting/budget_merge');

let passed = 0; let failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };

const ctx = { as_of: '2026-09-30', as_of_month: 9, base_year: 2026, target_year: 2027, policy: { expense_inflation_pct: 3 }, post_cutover_months: [8, 9] };
const line = (o) => ({ account_id: o.id || o.n, account_number: o.n, account_name: o.name || o.n, account_type: o.type || 'revenue', fund_id: o.fund_id || 'opr', fund_code: o.fund_code || 'OPR', budget_months: o.budget, ytd_actual: o.ytd, month_actuals: o.months || {}, ...(o.extra || {}) });
const monthly = (annual) => { const b = Math.trunc(annual / 12); const m = Array(12).fill(b); m[11] += annual - b * 12; return m; };

console.log('Budget screen: four columns');

// ---- cutoff ---------------------------------------------------------------------------
t('cutoff: one date for actual YTD and forecast = last day of the last completed month', () => {
  assert.deepStrictEqual(WF.baseYearCutoff({ now: new Date('2026-10-12T15:00:00Z'), target_year: 2027 }), { base_year: 2026, as_of: '2026-09-30', status: 'completed_month' });
  assert.strictEqual(WF.baseYearCutoff({ now: new Date('2026-10-01T05:00:00Z'), target_year: 2027 }).as_of, '2026-09-30');
  assert.strictEqual(WF.baseYearCutoff({ now: new Date('2026-03-01T12:00:00Z'), target_year: 2027 }).as_of, '2026-02-28');
  assert.strictEqual(WF.baseYearCutoff({ now: new Date('2028-03-01T12:00:00Z'), target_year: 2029 }).as_of, '2028-02-29', 'leap year');
});
t('cutoff: a finished base year is actual through Dec 31; January and future years have no forecast (no annualized fallback)', () => {
  assert.deepStrictEqual(WF.baseYearCutoff({ now: new Date('2027-02-10T12:00:00Z'), target_year: 2027 }), { base_year: 2026, as_of: '2026-12-31', status: 'full_year' });
  assert.deepStrictEqual(WF.baseYearCutoff({ now: new Date('2026-01-20T12:00:00Z'), target_year: 2027 }), { base_year: 2026, as_of: null, status: 'no_completed_month' });
  assert.deepStrictEqual(WF.baseYearCutoff({ now: new Date('2026-10-12T12:00:00Z'), target_year: 2029 }), { base_year: 2028, as_of: null, status: 'future' });
});

// ---- forecast arithmetic per account -------------------------------------------------
t('4030 late/interest fees: actual through Sep + remaining approved budget Oct-Dec, never annualized', () => {
  const l = WF.buildLine(line({ n: '4030', budget: monthly(4000000), ytd: 1085867, months: { 8: 0, 9: 0 } }), ctx);
  const b = l.base_year;
  assert.strictEqual(b.current_forecast_cents, 2085870, '$10,858.67 + $10,000.03 = $20,858.70');
  assert.notStrictEqual(b.current_forecast_cents, Math.round(1085867 * 12 / 9), 'not the 12/9 run-rate');
  assert.strictEqual(b.remaining_cents, 1000003); assert.strictEqual(b.remaining_period, 'Oct-Dec'); assert.strictEqual(b.forecast_method, 'remaining_budget'); assert.strictEqual(b.actual_through, '2026-09-30');
  assert.strictEqual(b.forecast_explanation, 'Actual through Sep $10,858.67 + remaining approved budget Oct-Dec $10,000.03 = $20,858.70.');
  assert.ok(l.flags.some((f) => f.code === 'no_post_cutover_activity'), 'Aug-Sep with no recorded revenue is flagged as incomplete source data');
  assert.deepStrictEqual(b.post_cutover.by_month, [{ month: 'Aug', actual_cents: 0 }, { month: 'Sep', actual_cents: 0 }]);
  assert.strictEqual(b.post_cutover.carryforward_cents, 1085867); assert.strictEqual(b.post_cutover.carryforward_through, 'Jul');
});
t('4070 clubhouse rental and 4100 operating interest: same method; a $0 year to date stays $0 actual', () => {
  const r = WF.buildLine(line({ n: '4070', budget: [41667, 41667, 41667, 41667, 41667, 41667, 41667, 41667, 41667, 41667, 41667, 41663], ytd: 350000, months: { 8: 0, 9: 0 } }), ctx);
  assert.strictEqual(r.base_year.current_forecast_cents, 474997);
  const i = WF.buildLine(line({ n: '4100', budget: Array(12).fill(2625), ytd: 0, months: { 8: 0, 9: 0 } }), ctx);
  assert.strictEqual(i.base_year.current_forecast_cents, 7875); assert.strictEqual(i.base_year.ytd_actual_cents, 0);
});
t('5010 bank charges: a net credit year to date (conversion -$140 + Aug $20) is carried with its sign', () => {
  const l = WF.buildLine(line({ n: '5010', type: 'expense', budget: [833, 833, 833, 833, 833, 833, 833, 833, 833, 833, 833, 837], ytd: -12000, months: { 8: 2000, 9: 0 } }), ctx);
  assert.strictEqual(l.base_year.current_forecast_cents, -9497, '($120.00) + $25.03 = ($94.97)');
  assert.deepStrictEqual(l.base_year.post_cutover.by_month, [{ month: 'Aug', actual_cents: 2000 }, { month: 'Sep', actual_cents: 0 }]);
  assert.strictEqual(l.base_year.post_cutover.carryforward_cents, -14000);
  assert.match(l.base_year.forecast_explanation, /^Actual through Sep \(\$120\.00\) \+ remaining approved budget Oct-Dec \$25\.03 = \(\$94\.97\)\.$/);
});
t('4000 assessments: actual + remaining SCHEDULED recognition (the schedule, not the budget)', () => {
  const per = (m) => ({ period_month: `2026-${String(m).padStart(2, '0')}-01`, scheduled_cents: 8561875 });
  const sched = { id: 's1', status: 'active', periods: [8, 9, 10, 11, 12].map(per), postings: [{ period_month: '2026-08-01', kind: 'recognition', reversed: false }, { period_month: '2026-09-01', kind: 'recognition', reversed: false }] };
  const l = WF.buildLine(line({ n: '4000', budget: Array(12).fill(9000000), ytd: 77056875, months: { 8: 8561875, 9: 8561875 }, extra: { schedules: [sched] } }), ctx);
  assert.strictEqual(l.base_year.current_forecast_cents, 102742500);
  assert.strictEqual(l.base_year.forecast_method, 'recognition_schedule');
  assert.strictEqual(l.base_year.forecast_explanation, 'Actual through Sep $770,568.75 + remaining scheduled recognition Oct-Dec $256,856.25 = $1,027,425.00.');
});
t('4010 Operating-to-Reserve transfer: the 2026 forecast is only what was recorded; the $164,000 model amount is unchanged', () => {
  const tr = { from_fund_id: 'opr', from_fund_code: 'OPR', from_fund_type: 'operating', to_fund_id: 'res', to_fund_code: 'RES', to_fund_type: 'reserve' };
  const budget = [-1366300, ...Array(11).fill(-1366700)];
  const l = WF.buildLine(line({ n: '4010', fund_id: 'res', fund_code: 'RES', budget, ytd: 0, extra: { transfer: tr } }), ctx);
  assert.strictEqual(l.base_year.current_forecast_cents, 0); assert.strictEqual(l.base_year.forecast_method, 'actual_only');
  assert.strictEqual(l.base_year.approved_budget_cents, -16400000);
  assert.strictEqual(l.recommendation_cents, -16400000); assert.strictEqual(l.final_cents, -16400000); assert.strictEqual(l.transfer.final_cents, 16400000);
  assert.match(l.base_year.forecast_explanation, /never assumed made/);
});

// ---- per-account folding + reconciliation --------------------------------------------
t('one entry per account: two funds add up; adopted, actual and forecast stay consistent', () => {
  const a = WF.buildLine(line({ n: '6000', id: 'acct6000', type: 'expense', budget: Array(12).fill(1000), ytd: 9000, months: { 8: 1000, 9: 1000 } }), ctx);
  const b = WF.buildLine(line({ n: '6000', id: 'acct6000', type: 'expense', fund_id: 'res', fund_code: 'RES', budget: Array(12).fill(500), ytd: 4500, months: { 8: 500, 9: 500 } }), ctx);
  const e = WF.baseYearByAccount({ lines: [a, b] }).get('acct6000');
  assert.strictEqual(e.adopted_cents, 18000); assert.strictEqual(e.ytd_cents, 13500); assert.strictEqual(e.forecast_cents, 13500 + 4500);
  assert.strictEqual(e.ytd_cents + e.remaining_cents, e.forecast_cents, 'actual + remaining = forecast');
  assert.deepStrictEqual(e.funds, ['OPR', 'RES']);
});
t('tie-out: Actual YTD equals the GL in total and the forecast engine on every account, or the difference is listed', () => {
  const rows = [{ account_id: 'a', account_number: '4000', account_name: 'A', account_type: 'revenue', actual_ytd_cents: 100, forecast_ytd_cents: 100 },
    { account_id: 'b', account_number: '5010', account_name: 'B', account_type: 'expense', actual_ytd_cents: -12000, forecast_ytd_cents: -12000 }];
  const ok = WF.reconcileBaseYear(rows, { revenue_cents: 100, expenses_cents: -12000 }, { as_of: '2026-09-30' });
  assert.strictEqual(ok.ties, true); assert.match(ok.text, /ties to the GL through 2026-09-30/);
  const off = WF.reconcileBaseYear([{ ...rows[0], forecast_ytd_cents: 90 }, rows[1]], { revenue_cents: 110, expenses_cents: -12000 }, { as_of: '2026-09-30' });
  assert.strictEqual(off.ties, false); assert.strictEqual(off.gl_ties, false); assert.strictEqual(off.account_differences[0].difference_cents, 10); assert.match(off.text, /does NOT tie/);
  assert.strictEqual(WF.reconcileBaseYear(rows, null).ties, false, 'an unavailable GL total never reads as a tie');
});

// ---- proposed values are preserved -----------------------------------------------------
t('proposed = the saved amount exactly (4030 $12,000 vs a $40,000 suggestion; 4010 -$164,000); suggestions ride along', () => {
  const rows = [
    { account_id: '4030', proposed_cents: 4000000, built_from: 'FY2026 adopted', flags: [] },
    { account_id: '4010', proposed_cents: 16400000, built_from: 'FY2026 adopted reserve contribution', flags: [] },
    { account_id: '4100', proposed_cents: 31500, flags: [] },
    { account_id: '6999', proposed_cents: 77700, built_from: 'trend', flags: [] },
  ];
  const before = JSON.stringify(rows);
  const saved = { id: 'd', status: 'draft', lines: [{ account_id: '4030', annual_amount_cents: 1200000 }, { account_id: '4010', annual_amount_cents: -16400000 }, { account_id: '4100', annual_amount_cents: 25000 }] };
  const out = applySavedDraft(rows, saved);
  const by = Object.fromEntries(out.map((r) => [r.account_id, r]));
  assert.strictEqual(by['4030'].proposed_cents, 1200000); assert.strictEqual(by['4030'].suggested_cents, 4000000); assert.strictEqual(by['4030'].proposed_source, 'saved_draft');
  assert.strictEqual(by['4010'].proposed_cents, -16400000, 'the $164,000 transfer keeps its saved amount and sign');
  assert.strictEqual(by['4100'].proposed_cents, 25000);
  assert.strictEqual(by['6999'].proposed_cents, 0, 'a line not in the saved draft is $0, never silently added');
  assert.ok(by['6999'].flags.some((f) => f.type === 'not_in_draft' && f.msg.includes('$777.00')), 'the suggestion amount keeps its dollar sign');
  assert.strictEqual(JSON.stringify(rows), before, 'input rows are not mutated');
  const fresh = applySavedDraft(rows, null);
  assert.ok(fresh.every((r) => r.proposed_source === 'system_suggestion' && r.proposed_cents === r.suggested_cents));
});

// ---- the route and the screen use the four-column rules ----------------------------------
t('living-lines: no annualized forecast; one cutoff; adopted = approved budget only; saved amounts applied server-side', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'books.js'), 'utf8');
  const route = src.slice(src.indexOf('async function applyWorkingForecast'), src.indexOf('// Undeposited Funds workflow'));
  assert.ok(!/ytdOf\(r\) \* mult/.test(route), 'YTD is never multiplied into a forecast');
  assert.ok(!/basis: 'annualized'/.test(route), 'no annualized fallback');
  assert.ok(/baseYearCutoff\(/.test(route) && /period_end: ytdEnd/.test(route) && /as_of: cutoff\.as_of/.test(route), 'actual YTD and the forecast read the same cutoff');
  assert.ok(/\.in\('status', \['approved', 'active'\]\)/.test(route), 'adopted budget is the approved one');
  assert.ok(/applySavedDraft\(rows, savedDraft\)/.test(route) && /reconcileBaseYear\(/.test(route));
  // every whole-dollar amount the route words keeps its $ (a bare figure reads as a count)
  assert.ok(!/[^$(]\$\{Math\.round\([^`}]*?\/ 100\)\.toLocaleString\(\)\}/.test(route), 'no bare dollar figure in the living-lines wording');
});
t('screen: columns read Adopted / Actual thru <cutoff> / Forecast / Proposed, in that order, and no "run-rate" label remains', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'accounting.html'), 'utf8');
  const hdr = html.slice(html.indexOf('const hdr=`'), html.indexOf('</div>`;', html.indexOf('const hdr=`')));
  const order = ['_llCol.adopted', '_llCol.ytd', '_llCol.forecast', '_llCol.proposed'].map((k) => hdr.indexOf(k));
  assert.ok(order.every((i) => i > 0) && order.every((i, n) => n === 0 || i > order[n - 1]), 'header order');
  assert.ok(/Actual thru \$\{_llDate\(c\.as_of\)\}/.test(html), 'the cutoff date is in the column label');
  assert.ok(!/annualized run-rate/.test(html) && !/run-rate\.<\/div>/.test(html), 'stale run-rate labels removed');
  assert.ok(!/savedMap\[/.test(html), 'the screen does not re-apply saved amounts on its own');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
