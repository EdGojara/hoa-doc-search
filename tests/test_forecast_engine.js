#!/usr/bin/env node
// ============================================================================
// Forecast Phase 3B (Ed 2026-09-25): pure forecast engine, variance convention,
// evidence-only classification, and the assessment-authority funding check.
// Synthetic data only. DB-side rules (one working forecast, snapshot
// immutability, component completeness, approved budget + GL unchanged) are
// rehearsed by tests/sql/465_forecast_rehearsal.sql, rolled back.
// ============================================================================
const assert = require('assert');
const E = require('../lib/accounting/forecast_engine');
const { favorableVariance, varianceSet } = require('../lib/accounting/variance');
const { assessmentFundingCheck } = require('../lib/accounting/assessment_authority');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };
const sum = (a) => a.reduce((s, v) => s + v, 0);
const even = (annual) => { const e = Math.trunc(annual / 12); const m = Array(12).fill(e); m[11] += annual - e * 12; return m; };
const oct = (amt) => { const m = Array(12).fill(0); m[9] = amt; return m; };
const dec = (amt) => { const m = Array(12).fill(0); m[11] = amt; return m; };

t('favorable = positive: expense budget - actual; revenue actual - budget', () => {
  assert.strictEqual(favorableVariance('expense', 1000, 800), 200);
  assert.strictEqual(favorableVariance('expense', 1000, 1300), -300);
  assert.strictEqual(favorableVariance('revenue', 1000, 1300), 300);
  assert.strictEqual(favorableVariance('revenue', 1000, 800), -200);
  const v = varianceSet({ account_type: 'revenue', ytd_budget: 900, ytd_actual: 700, annual_budget: 1200, annual_forecast: 1200 });
  assert.deepStrictEqual([v.ytd, v.forecast, v.labels.ytd, v.labels.forecast], [-200, 0, 'unfavorable', 'on budget']);
});

t('remaining-budget is the default: actual YTD + remaining approved months', () => {
  const budget = even(132500); const actual = [...Array(9).fill(14833), 0, 0, 0];
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: budget, actual_months: actual, as_of_month: 9 });
  assert.strictEqual(r.method, 'remaining_budget');
  assert.deepStrictEqual(r.remaining.slice(9), budget.slice(9));
  assert.deepStrictEqual(r.months.slice(0, 9), actual.slice(0, 9));
  assert.strictEqual(r.annual_forecast, sum(actual.slice(0, 9)) + sum(budget.slice(9)));
});

t('seasonal budget: remaining months follow the approved seasonal schedule', () => {
  const pool = [124500, 124500, 124500, 124500, 861300, 1583700, 1739200, 1051500, 718100, 124500, 124500, 124500];
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: pool, actual_months: pool, as_of_month: 9 });
  assert.deepStrictEqual(r.remaining.slice(9), [124500, 124500, 124500]);
  assert.strictEqual(r.annual_forecast, sum(pool));
});

t('run-rate is opt-in and never uses months before cutover (the conversion lump)', () => {
  const actual = [0, 0, 0, 0, 0, 0, 2100000, 250000, 260000, 0, 0, 0];   // Jan-Jul lumped into July
  assert.throws(() => E.buildForecastLine({ account_type: 'expense', budget_months: even(3000000), actual_months: actual, as_of_month: 9, cutover_month: 8, method: 'run_rate', settings: { months_n: 3 } }), /not_enough_true_monthly_actuals/);
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: even(3000000), actual_months: actual, as_of_month: 9, cutover_month: 8, method: 'run_rate', settings: { months_n: 2 } });
  assert.deepStrictEqual(r.remaining.slice(9), [255000, 255000, 255000]);
  assert.match(r.explanation, /Aug, Sep/);
});

t('moved project: budget Oct $30,000, forecast Dec; approved budget untouched; driver = known_timing', () => {
  const budgetComp = [{ id: 'bc1', vendor_project_id: 'p1', monthly_amounts_cents: oct(3000000) }];
  const budget = even(300000).map((v, i) => v + oct(3000000)[i]);
  const budgetBefore = JSON.stringify(budget);
  const comps = [
    { kind: 'recurring', label: 'Recurring repairs', months: [...Array(10).fill(0), 25000, 25000].map((v, i) => (i === 9 ? 25000 : v)), basis: 'calculated' },
    { kind: 'project', label: 'Fence replacement', months: dec(3000000), basis: 'calculated', refs: { vendor_project_id: 'p1' } },
  ];
  // as of October: the project did not happen in October
  const actual = [...Array(9).fill(0), 0, 0, 0]; actual[0] = 9900;
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: budget, actual_months: actual, as_of_month: 10, method: 'components', components: comps.map((c) => ({ ...c, months: c.months.map((v, i) => (i < 10 ? 0 : v)) })) });
  assert.strictEqual(JSON.stringify(budget), budgetBefore, 'budget months not modified');
  const drivers = E.deriveDrivers({ account_type: 'expense', as_of_month: 10, budget_components: budgetComp, forecast_components: [{ kind: 'project', months: dec(3000000), refs: { vendor_project_id: 'p1' } }] });
  assert.strictEqual(drivers.length, 1);
  assert.strictEqual(drivers[0].type, 'project_moved');
  assert.strictEqual(drivers[0].ytd_amount, 3000000, 'October favorable variance is timing');
  assert.strictEqual(drivers[0].full_year_amount, 0, 'full-year unchanged');
  assert.deepStrictEqual([drivers[0].budget_month, drivers[0].forecast_month], ['Oct', 'Dec']);
  assert.ok(r.remaining[11] >= 3000000);
});

t('contract: documented schedule vs assumed spread keep their provenance; documented+assumed refused', () => {
  const documented = { kind: 'contract', label: 'Pool contract', months: [...Array(9).fill(0), 0, 0, 0], basis: 'documented' };
  const assumed = { kind: 'contract', label: 'Landscape contract', months: [...Array(9).fill(0), 510000, 510000, 510000], basis: 'calculated', assumption: true };
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: even(6100000), actual_months: Array(12).fill(0), as_of_month: 9, method: 'components', components: [assumed] });
  assert.strictEqual(r.basis, 'calculated'); assert.match(r.explanation, /assumed/);
  assert.throws(() => E.buildForecastLine({ account_type: 'expense', budget_months: even(1), actual_months: Array(12).fill(0), as_of_month: 9, method: 'components', components: [{ ...documented, assumption: true }] }), /cannot_be_documented_and_assumed/);
});

t('known invoice component lands in its month as documented', () => {
  const inv = { kind: 'known_invoice', label: 'Invoice 1042 (received, not posted)', months: [...Array(9).fill(0), 481501, 0, 0], basis: 'documented', refs: { ap_invoice_id: 'i1' } };
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: even(0), actual_months: Array(12).fill(0), as_of_month: 9, method: 'components', components: [inv] });
  assert.strictEqual(r.remaining[9], 481501); assert.strictEqual(r.basis, 'documented');
});

t('manual override requires a reason', () => {
  assert.throws(() => E.buildForecastLine({ account_type: 'expense', budget_months: even(1200), actual_months: Array(12).fill(0), as_of_month: 9, method: 'manual', settings: { months: Array(12).fill(100) } }), /requires_reason/);
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: even(1200), actual_months: Array(12).fill(0), as_of_month: 9, method: 'manual', settings: { months: Array(12).fill(100), reason: 'Vendor quoted $100/mo' } });
  assert.strictEqual(r.basis, 'manual'); assert.strictEqual(r.remaining_total, 300);
});

t('hybrid line: components explain 100% of remaining months; a gap is reported', () => {
  const comps = [
    { kind: 'recurring', label: 'Base', months: [...Array(9).fill(0), 20000, 20000, 20000], basis: 'calculated' },
    { kind: 'project', label: 'Repair', months: [...Array(9).fill(0), 0, 150000, 0], basis: 'manual', refs: { vendor_project_id: 'p2' } },
  ];
  const r = E.buildForecastLine({ account_type: 'expense', budget_months: even(240000), actual_months: Array(12).fill(0), as_of_month: 9, method: 'components', components: comps });
  assert.ok(E.checkComponentsExplainRemaining(r.remaining, comps).ok);
  const gap = E.checkComponentsExplainRemaining(r.remaining, [comps[0]]);
  assert.ok(!gap.ok); assert.strictEqual(gap.residual[10], 150000);
  assert.throws(() => E.buildForecastLine({ account_type: 'expense', budget_months: even(1), actual_months: Array(12).fill(0), as_of_month: 9, method: 'components', components: [{ ...comps[0], months: [5, ...Array(11).fill(0)] }] }), /has_amounts_in_actual_months/);
});

t('classification: only evidence is timing; the residual is unexplained (no automatic timing)', () => {
  const c = E.classifyVariance({ ytd_variance: 3200000, forecast_variance: 200000, drivers: [{ type: 'project_moved', classification: 'known_timing', ytd_amount: 3000000, full_year_amount: 0 }] });
  assert.deepStrictEqual(c.ytd, { known_timing: 3000000, known_permanent: 0, unexplained: 200000 });
  assert.deepStrictEqual(c.full_year, { known_timing: 0, known_permanent: 0, unexplained: 200000 });
  const none = E.classifyVariance({ ytd_variance: -1020100, forecast_variance: -1020200, drivers: [] });
  assert.strictEqual(none.ytd.known_timing, 0, 'YTD minus full-year is NOT labelled timing');
  assert.strictEqual(none.ytd.unexplained, -1020100);
});

t('assessments: pro rata recognition; unposted months are evidence-backed timing, not a shortfall', () => {
  const levy = 38969800; const schedule = even(levy);
  const actual = Array(12).fill(0); actual[6] = sum(schedule.slice(0, 7));          // conversion: Jan-Jul recognized, posted in July
  const r = E.buildForecastLine({ account_type: 'revenue', budget_months: schedule, actual_months: actual, as_of_month: 9, cutover_month: 8, method: 'assessment_recognition', settings: { annual_levy_cents: levy, include_unposted_recognition: true } });
  assert.strictEqual(r.annual_forecast, levy, 'forecast = the full annual levy');
  const d = E.deriveDrivers({ account_type: 'revenue', as_of_month: 9, cutover_month: 8, actual_months: actual, recognition: { schedule_months: schedule } });
  assert.strictEqual(d[0].type, 'assessment_recognition_not_posted'); assert.deepStrictEqual(d[0].missing_months, ['Aug', 'Sep']);
  const facts = E.managementFacts({ account: '4000', account_type: 'revenue', line: r, drivers: d });
  assert.strictEqual(facts.forecast_variance, 0);
  assert.strictEqual(facts.classification.ytd.unexplained, facts.ytd_variance - d[0].ytd_amount);
  assert.strictEqual(facts.recommended_action, 'post the missing assessment recognition entries (accounting)');
});

t('assessment authority: no verified source-backed rule = no conclusion (no default cap)', () => {
  const r = assessmentFundingCheck({ required_operating_cents: 42000000, required_reserve_cents: 5000000, non_assessment_revenue_cents: 1000000, current_assessment_revenue_cents: 38969800, authority: null });
  assert.strictEqual(r.conclusion, 'authority_not_on_file'); assert.strictEqual(r.board_max_increase_pct, undefined);
  const draft = assessmentFundingCheck({ required_operating_cents: 1, required_reserve_cents: 0, non_assessment_revenue_cents: 0, current_assessment_revenue_cents: 1, authority: { status: 'draft', board_max_increase_pct: 10 } });
  assert.strictEqual(draft.conclusion, 'authority_not_on_file');
});

t('assessment authority: verified synthetic 10% cap → shortfall at cap and member-approval path', () => {
  const authority = { status: 'verified', board_max_increase_pct: 10, source_document_id: 'doc', source_citation: 'Art. X §2', source_excerpt: '…', above_cap_permitted: true, member_approval_threshold_pct: 66.667, member_approval_basis: 'votes_cast', procedural_steps: ['notice', 'member vote'] };
  const r = assessmentFundingCheck({ required_operating_cents: 42000000, required_reserve_cents: 4270000, non_assessment_revenue_cents: 470000, current_assessment_revenue_cents: 38969800, units: 543, authority });
  assert.strictEqual(r.required_assessment_revenue_cents, 45800000);
  assert.strictEqual(r.required_increase_pct, 17.527);
  assert.strictEqual(r.max_without_member_approval_cents, 42866780);
  assert.strictEqual(r.shortfall_at_cap_cents, 2933220);
  assert.strictEqual(r.conclusion, 'member_approval_required');
  assert.strictEqual(r.member_approval.basis, 'votes_cast');
});

t('management action: no configured policy → neutral review, never an invented board threshold', () => {
  const line = { ytd_budget: 2100100, ytd_actual: 3120200, annual_budget: 2800000, annual_forecast: 3820100, method: 'remaining_budget', basis: 'calculated', confidence: 'medium', explanation: '' };
  const none = E.managementFacts({ account: '5105', account_type: 'expense', line });
  assert.strictEqual(none.recommended_action, 'review variance');
  assert.strictEqual(none.material, null);
  assert.strictEqual(none.variance_policy, null);
  const zero = E.managementFacts({ account: 'x', account_type: 'expense', line: { ...line, ytd_actual: 2100100, annual_forecast: 2800000 } });
  assert.strictEqual(zero.recommended_action, 'no action');
  const policy = { materiality_cents: 50000, board_decision_overrun_pct: 10, source: 'SYNTHETIC board policy' };
  const cfg = E.managementFacts({ account: '5105', account_type: 'expense', line, policy });
  assert.strictEqual(cfg.recommended_action, 'board decision required (forecast overrun beyond configured policy)');
  assert.strictEqual(cfg.material, true);
  assert.strictEqual(cfg.variance_policy.source, 'SYNTHETIC board policy');
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
