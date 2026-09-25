// tests/test_recognition_schedule.js — Phase 3C recognition schedules (pure; no DB).
// Run: node tests/test_recognition_schedule.js
const assert = require('assert');
const R = require('../lib/accounting/recognition_schedule');
const E = require('../lib/accounting/forecast_engine');
const { dailyMonthCents } = require('../lib/accounting/recognition_engine');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };
const sum = (a) => a.reduce((s, p) => s + (p.scheduled_cents != null ? p.scheduled_cents : p), 0);
const posted = (periods, n) => periods.slice(0, n).map((p) => ({ period_month: p.period_month, amount_cents: p.scheduled_cents, kind: 'recognition' }));

t('assessment: $389,698 billed once, recognized 1/12 monthly, 12 months tie to the cent', () => {
  const p = R.buildRecognitionPeriods({ total_cents: 38969800, start_month: '2026-01-01', term_months: 12 });
  assert.strictEqual(p.length, 12);
  assert.strictEqual(sum(p), 38969800);
  assert.ok(p.slice(0, 11).every((x) => x.scheduled_cents === 3247483));
  assert.strictEqual(p[11].scheduled_cents, 3247487);
  const st = R.recognitionStatus({ total_cents: 38969800, periods: p, postings: posted(p, 9), as_of_month: '2026-09-01', fiscal_year: 2026 });
  assert.strictEqual(st.recognized_cents, 29227347);
  assert.strictEqual(st.remaining_cents, 9742453);
  assert.strictEqual(st.recognized_cents + st.remaining_cents, 38969800);
  assert.strictEqual(st.next_recognition_month, '2026-10-01');
  assert.deepStrictEqual(st.missing_months, []);
});

t('insurance: $24,000 prepaid Jan 1, $2,000/month; after September $18,000 expensed, $6,000 prepaid', () => {
  const p = R.buildRecognitionPeriods({ total_cents: 2400000, start_month: '2026-01-01', term_months: 12 });
  assert.ok(p.every((x) => x.scheduled_cents === 200000));
  const f = R.recognitionFacts({
    schedule: { id: 's1', description: 'GL policy 2026', schedule_type: 'prepaid_expense', status: 'active', recognize_amount_cents: 2400000, schedule_basis: 'documented', period_start: '2026-01-01', period_end: '2026-12-31' },
    periods: p, postings: posted(p, 9), as_of_month: '2026-09-01', fiscal_year: 2026,
    balance_account: '1400 Prepaid Insurance', recognition_account: '5600 Insurance', source_document: 'policy declarations', gl_balance_cents: 600000,
  });
  assert.strictEqual(f.recognized_ytd_cents, 1800000);
  assert.strictEqual(f.remaining_cents, 600000);
  assert.strictEqual(f.remaining_label, 'prepaid remaining');
  assert.strictEqual(f.monthly_recognition_cents, 200000);
  assert.strictEqual(f.next_recognition_month, '2026-10-01');
  assert.strictEqual(f.overdue, false);
  assert.strictEqual(f.reconciles, true);
  assert.strictEqual(f.gl_matches_remaining, true);
});

t('rounding: odd totals tie exactly (straight-line and daily)', () => {
  const a = R.buildRecognitionPeriods({ total_cents: 100000, start_month: '2026-01-01', term_months: 3 });
  assert.deepStrictEqual(a.map((x) => x.scheduled_cents), [33333, 33333, 33334]);
  const d = R.buildRecognitionPeriods({ total_cents: 100001, start_month: '2026-02-01', term_months: 13, method: 'daily', period_start: '2026-02-15', period_end: '2027-02-14' });
  assert.strictEqual(sum(d), 100001);
  const prime = R.buildRecognitionPeriods({ total_cents: 1224200, start_month: '2026-09-01', term_months: 12 });
  assert.strictEqual(sum(prime), 1224200);
  assert.strictEqual(prime[11].scheduled_cents, 1224200 - 102017 * 11);
});

t('parity: calculated periods equal the live engine (straight-line stub and daily)', () => {
  const sch = { recognize_amount_cents: 843140, start_month: '2026-07-01', term_months: 6, monthly_amount_cents: 140523, period_start: '2026-05-17', period_end: '2026-12-31' };
  const sl = R.buildRecognitionPeriods({ total_cents: 843140, start_month: '2026-07-01', term_months: 6, monthly_cents: 140523 });
  assert.deepStrictEqual(sl.map((x) => x.scheduled_cents), [140523, 140523, 140523, 140523, 140523, 843140 - 140523 * 5]);
  const d = R.buildRecognitionPeriods({ total_cents: 843140, start_month: '2026-07-01', term_months: 6, method: 'daily', period_start: sch.period_start, period_end: sch.period_end });
  d.forEach((x, k) => assert.strictEqual(x.scheduled_cents, dailyMonthCents(sch, k)));
});

t('documented schedule: must sum to the total; a month cannot appear twice', () => {
  assert.throws(() => R.buildRecognitionPeriods({ total_cents: 1000, method: 'documented_schedule', months: [{ period_month: '2026-01-01', scheduled_cents: 600 }, { period_month: '2026-02-01', scheduled_cents: 500 }] }), /sum 1100/);
  assert.throws(() => R.buildRecognitionPeriods({ total_cents: 1000, method: 'documented_schedule', months: [{ period_month: '2026-01-01', scheduled_cents: 500 }, { period_month: '2026-01-01', scheduled_cents: 500 }] }), /twice/);
});

t('reversal nets explicitly: a reversed month is recognized again only once re-posted', () => {
  const p = R.buildRecognitionPeriods({ total_cents: 2400000, start_month: '2026-01-01', term_months: 12 });
  const ps = posted(p, 9); ps[8].reversed = true;
  ps.push({ period_month: '2026-09-01', amount_cents: -200000, kind: 'reversal' });
  let st = R.recognitionStatus({ total_cents: 2400000, periods: p, postings: ps, as_of_month: '2026-09-01' });
  assert.strictEqual(st.recognized_cents, 1600000);
  assert.deepStrictEqual(st.missing_months, ['2026-09-01']);
  ps.push({ period_month: '2026-09-01', amount_cents: 200000, kind: 'recognition' });
  st = R.recognitionStatus({ total_cents: 2400000, periods: p, postings: ps, as_of_month: '2026-09-01' });
  assert.strictEqual(st.recognized_cents, 1800000);
  assert.deepStrictEqual(st.missing_months, []);
});

t('forecast: insurance paid Jan 1 forecasts $2,000/month of expense, not $24,000 in January', () => {
  const p = R.buildRecognitionPeriods({ total_cents: 2400000, start_month: '2026-01-01', term_months: 12 });
  const schedules = [{ id: 's1', description: 'GL policy 2026', status: 'active', schedule_basis: 'documented', periods: p, postings: posted(p, 9) }];
  const actual = [...Array(9).fill(200000), 0, 0, 0];
  const line = E.buildForecastLine({ account_type: 'expense', budget_months: Array(12).fill(200000), actual_months: actual, as_of_month: 9, method: 'recognition_schedule', settings: { schedules, fiscal_year: 2026 } });
  assert.deepStrictEqual(line.remaining.slice(9), [200000, 200000, 200000]);
  assert.strictEqual(line.annual_forecast, 2400000);
  assert.strictEqual(line.basis, 'documented');
  assert.strictEqual(line.confidence, 'high');
});

t('forecast precedence: manual reason > documented schedule > calculated schedule > components > remaining budget; never run-rate', () => {
  assert.strictEqual(E.chooseForecastMethod({ manual_reason: 'board approved rebid', schedules: [{ status: 'active', schedule_basis: 'documented' }] }).method, 'manual');
  assert.strictEqual(E.chooseForecastMethod({ schedules: [{ status: 'active', schedule_basis: 'documented' }], has_components: true }).method, 'recognition_schedule');
  assert.strictEqual(E.chooseForecastMethod({ schedules: [{ status: 'draft', schedule_basis: 'documented' }] }).method, 'remaining_budget');
  assert.strictEqual(E.chooseForecastMethod({ has_components: true }).method, 'components');
  assert.strictEqual(E.chooseForecastMethod({}).method, 'remaining_budget');
  assert.throws(() => E.buildForecastLine({ account_type: 'expense', budget_months: Array(12).fill(0), as_of_month: 9, method: 'recognition_schedule', settings: { schedules: [{ status: 'draft', periods: [{ period_month: '2026-10-01', scheduled_cents: 1 }] }], fiscal_year: 2026 } }), /not_active/);
});

t('LOPF shape: 2205 balance $162,374.19 recognized Aug-Dec; Aug/Sep unposted = timing, forecast ties to the levy exactly', () => {
  const p = R.buildRecognitionPeriods({ total_cents: 16237419, start_month: '2026-08-01', term_months: 5, monthly_cents: 3247483 });
  assert.deepStrictEqual(p.map((x) => x.scheduled_cents), [3247483, 3247483, 3247483, 3247483, 3247487]);
  const schedules = [{ id: 'conv', description: '2026 assessments: 7/31 unearned balance', status: 'active', schedule_basis: 'calculated', periods: p, postings: [] }];
  const budget = [...Array(11).fill(3247483), 3247487];
  const actual = [0, 0, 0, 0, 0, 0, 22732381, 0, 0, 0, 0, 0];
  const line = E.buildForecastLine({ account_type: 'revenue', budget_months: budget, actual_months: actual, as_of_month: 9, cutover_month: 8, method: 'recognition_schedule', settings: { schedules, fiscal_year: 2026 } });
  assert.strictEqual(line.annual_forecast, 38969800);
  assert.strictEqual(line.remaining[9], 3247483 * 3);
  const drivers = E.deriveDrivers({ account_type: 'revenue', as_of_month: 9, recognition_schedules: schedules, fiscal_year: 2026 });
  assert.strictEqual(drivers[0].type, 'recognition_not_posted');
  assert.strictEqual(drivers[0].ytd_amount, -6494966);
  const facts = E.managementFacts({ account: '4000', account_type: 'revenue', line, drivers });
  assert.strictEqual(facts.forecast_variance, 0);
  assert.strictEqual(facts.classification.ytd.unexplained, 0);
  assert.strictEqual(facts.recommended_action, 'post the due recognition entries (accounting)');
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
