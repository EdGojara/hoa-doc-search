// tests/test_working_forecast.js  (Ed 2026-10-10, Financial Intelligence slice 1)
// The next-year working forecast: deterministic driver bridges, evidence and confidence,
// unknown-is-not-zero, human overrides kept separate from the model, executed-contract
// evidence as a first-class driver, and the contract intake triage.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const Module = require('module');
const F = require('./fixtures/drama_creek_statements');
const realLoad = Module._load;
Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return realLoad.apply(this, arguments); };
const WF = require('../lib/forecast/working_forecast');
const { contractCostForYear } = require('../lib/contracts/contract_terms');
const intake = require('../lib/contracts/intake');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const ctx = { as_of_month: 9, base_year: 2026, target_year: 2027, policy: { expense_inflation_pct: 3, inflation_source: 'test policy', inflation_confidence: 'low' }, post_cutover_months: [8, 9] };
const flat = (annual) => { const m = Array(12).fill(Math.trunc(annual / 12)); m[0] += annual - m.reduce((a, b) => a + b, 0); return m; };
const L = (o) => ({ account_id: o.id || 'a1', account_number: o.n || '5770', account_name: o.name || 'Security', account_type: o.type || 'expense', fund_id: 'f', fund_code: 'OPR',
  budget_months: o.budget === null ? null : (o.budget || Array(12).fill(1000000)), ytd_actual: o.ytd ?? 9000000, month_actuals: o.months || { 8: 1000000, 9: 1000000 }, contracts: o.contracts });
const item = (l, d) => l.bridge.find((b) => b.driver === d);

(async () => {
  console.log('2026 current forecast and base');
  const a = WF.buildLine(L({}), ctx);
  check('2026 current forecast = YTD actual through Sep + remaining approved budget Oct-Dec (no annualizing)', a.base_year.current_forecast_cents === 9000000 + 3000000 && a.base.choice === 'current_forecast');
  const inc = WF.buildLine(L({ months: { 8: 0, 9: 0 } }), ctx);
  check('no post-cutover activity on a budgeted line: base falls back to the approved budget, flagged, low confidence', inc.base.choice === 'approved_budget' && inc.base.cents === 12000000 && inc.flags.some((f) => f.code === 'no_post_cutover_activity') && inc.confidence.model === 'low');
  check('... and the omitted-recurring driver says needs evidence (not zero, excluded)', item(inc, 'omitted_recurring').status === 'needs_evidence' && item(inc, 'omitted_recurring').amount_cents === null);
  const incRev = WF.buildLine(L({ type: 'revenue', n: '4000', name: 'Assessments', months: { 8: 0, 9: 0 } }), ctx);
  check('an incomplete revenue line has unknown confidence and is not inflated', incRev.confidence.model === 'unknown' && item(incRev, 'rate').status === 'not_applicable' && incRev.recommendation_cents === 12000000);

  console.log('normalization: reviewed, never assumed');
  const over = WF.buildLine(L({ ytd: 13000000 }), ctx);
  check('a 2026 overrun is flagged "needs review", with the overrun as evidence, and NOT removed', item(over, 'one_time').status === 'needs_review' && item(over, 'one_time').amount_cents === null && item(over, 'one_time').evidence.overrun_cents === 4000000);
  check('... the recommendation keeps the overrun until a person decides (base 16,000,000 + 3%)', over.recommendation_cents === 16000000 + 480000);
  const norm = WF.buildLine(L({ ytd: 13000000 }), ctx, { one_time: { amount_cents: -4000000, assumption: 'Gate rebuild invoiced in 2026 is one-time', confidence: 'medium', source: 'management', actor: 'ed', created_at: '2026-10-10T10:00:00Z' } });
  check('a human one-time adjustment (signed effect) normalizes the base and inflation applies to the normalized base', norm.base_year.normalized_cents === 12000000 && item(norm, 'rate').amount_cents === 360000 && norm.recommendation_cents === 12360000);
  check('... and the bridge carries the assumption, actor, confidence and source', item(norm, 'one_time').assumption.includes('Gate rebuild') && item(norm, 'one_time').actor === 'ed' && item(norm, 'one_time').source === 'management');
  const unb = WF.buildLine(L({ budget: null, ytd: 7426400, months: { 8: 100, 9: 100 } }), ctx);
  check('unbudgeted 2026 activity is carried as the base but flagged "does it recur?" (needs review)', unb.flags.some((f) => f.code === 'unbudgeted') && item(unb, 'one_time').status === 'needs_review' && unb.evidence_status === 'needs_review');

  console.log('unknown is not zero');
  check('contract with nothing on file shows "none on file", excluded from the arithmetic', item(a, 'contract').status === 'no_evidence' && item(a, 'contract').amount_cents === null);
  check('volatility without history is "not available", excluded', item(a, 'volatility').status === 'not_available' && item(a, 'volatility').amount_cents === null);
  check('recommendation = base + only the applied drivers', a.recommendation_cents === a.base.cents + a.bridge.filter((b) => b.status === 'applied').reduce((t, b) => t + b.amount_cents, 0));
  check('inflation is a labelled management assumption, not part of line confidence', item(a, 'rate').source === 'management policy' && a.confidence.model === 'medium');

  console.log('human override kept separate from the model');
  const tenK = [...Array(9).fill(833333), 833334, 833333, 833333];   // Oct-Dec = 2,500,000 exactly
  const ov = WF.buildLine(L({ budget: tenK, ytd: 7500000, months: { 8: 833333, 9: 833333 } }), { ...ctx, policy: { expense_inflation_pct: 0 } }, {}, { override_cents: 9400000, model_recommendation_cents: 10000000, reason: 'Board expects fewer patrol hours', actor: 'ed', created_at: '2026-10-10T11:00:00Z' });
  check('model recommendation is preserved (100,000) beside the override (94,000), delta (6,000), reason and actor', ov.recommendation_cents === 10000000 && ov.override.amount_cents === 9400000 && ov.override.delta_vs_recorded_model_cents === -600000 && ov.override.reason.includes('patrol') && ov.override.actor === 'ed');
  check('final = override; confidence of the final number is "management decision"', ov.final_cents === 9400000 && ov.confidence.final === 'management decision' && ov.confidence.model !== 'management decision');
  const ov2 = WF.buildLine(L({ budget: tenK, ytd: 7600000, months: { 8: 833333, 9: 833333 } }), { ...ctx, policy: { expense_inflation_pct: 0 } }, {}, { override_cents: 9400000, model_recommendation_cents: 10000000, reason: 'Board expects fewer patrol hours', actor: 'ed', created_at: 'x' });
  check('if the model later changes, the override says so (recorded model vs current model)', ov2.override.model_changed_since_override === true && ov2.override.delta_vs_current_model_cents === 9400000 - ov2.recommendation_cents);

  console.log('monthly phasing preserved');
  const shaped = [500000, 500000, 500000, 1000000, 1000000, 1500000, 1500000, 1500000, 1000000, 500000, 250000, 250000];
  const ph = WF.buildLine(L({ budget: shaped, ytd: 7500000, months: { 8: 1500000, 9: 1000000 } }), ctx);
  check('2027 months follow the 2026 approved phasing shape (not annual / 12), exact to the cent', ph.months_2027.reduce((t, v) => t + v, 0) === ph.final_cents && ph.months_2027[6] > ph.months_2027[0] * 2.5 && /phasing/.test(ph.phasing));
  check('no budget: even spread, and it says so', /even spread/.test(unb.phasing));

  console.log('whole forecast, summary, data status, reproducibility');
  const input = { community: { id: 'c', name: 'Test' }, base_year: 2026, target_year: 2027, as_of: '2026-09-30', as_of_month: 9, post_cutover_months: [8, 9], policy: ctx.policy,
    facts: { converted_through: '2026-07-31', recognition_schedules: 0, bank_recs_incomplete: 2, closed_through: null, vendor_contracts: 0 },
    lines: [L({ id: 'a1' }), L({ id: 'a2', n: '5250', name: 'Monument', ytd: 12000000 }), L({ id: 'a3', n: '4000', name: 'Assessments', type: 'revenue', months: { 8: 0, 9: 0 } })] };
  const m1 = WF.buildWorkingForecast(input, { now: new Date('2026-10-10T00:00:00Z') });
  const m2 = WF.buildWorkingForecast(JSON.parse(JSON.stringify(input)), { now: new Date('2026-10-11T00:00:00Z') });
  check('deterministic: same inputs give the same model hash (generation time excluded)', m1.model_sha256 === m2.model_sha256);
  check('data status is incomplete with evidence-derived reasons; revenue flagged unreliable', m1.data_status.status === 'incomplete' && !m1.data_status.revenue_reliable && ['converted_mid_year', 'post_cutover_gaps', 'no_recognition_schedules', 'bank_recs_incomplete', 'no_closed_month', 'no_contracts'].every((c) => m1.data_status.reasons.some((r) => r.code === c)));
  check('summary: totals, change vs approved and vs normalized, needs-evidence count, top drivers', m1.summary.model.expense === m1.lines.filter((l) => l.account_type === 'expense').reduce((t, l) => t + l.recommendation_cents, 0)
    && m1.summary.change_vs_approved.model.expense === m1.summary.model.expense - m1.summary.approved_base_year.expense && m1.summary.needs_evidence.lines === 2 && m1.summary.top_drivers[0].account.includes('5250'));
  check('model version recorded', m1.model_version === 'trusted.working_forecast.v1');

  console.log('contract terms (deterministic)');
  const k1 = contractCostForYear({ effective_date: '2025-01-01', end_date: '2027-12-31', periodic_amount: 19583.33, periodic_frequency: 'monthly', rate_schedule: [{ effective_date: '2027-07-01', periodic_amount: 21000, note: 'year-3 rate' }] }, 2027);
  check('a dated mid-year rate change: Jan-Jun at the old rate, Jul-Dec at the new rate, exact cents ($243,499.98)', k1.annual_cents === 24349998 && k1.steps.length === 2 && k1.rate_at_start_of_year.cents === 1958333, `${k1.annual_cents} ${k1.steps.join(' | ')}`);
  const k2 = contractCostForYear({ effective_date: '2026-04-01', end_date: null, auto_renews: false, periodic_amount: 30000, periodic_frequency: 'quarterly', escalator_kind: 'fixed_pct', escalator_pct: 4 }, 2027);
  check('quarterly pricing with a fixed 4% escalator on the anniversary (Apr 2027)', k2.months.slice(0, 3).every((v) => v === 1000000) && k2.months.slice(3).every((v) => v === 1040000) && k2.annual_cents === 3000000 + 9360000);
  const k3 = contractCostForYear({ effective_date: '2025-06-01', end_date: '2027-05-31', auto_renews: false, periodic_amount: 1000, periodic_frequency: 'monthly' }, 2027);
  check('months after the end date are uncovered (not zero cost), and listed', k3.covered_months === 5 && k3.months[5] === null && k3.issues.some((x) => x.code === 'uncovered_months'));
  const k4 = contractCostForYear({ effective_date: '2025-06-01', end_date: '2027-05-31', auto_renews: true, periodic_amount: 1000, periodic_frequency: 'monthly' }, 2027);
  check('auto-renewal covers later months but is flagged to confirm', k4.covered_months === 12 && k4.renewal_assumed_months === 7 && k4.issues.some((x) => x.code === 'renewal_assumed'));
  const k5 = contractCostForYear({ effective_date: '2026-01-01', periodic_amount: 1200, periodic_frequency: 'monthly', escalator_kind: 'cpi_only', one_time_fees: [{ date: '2027-03-15', amount: 500, description: 'mobilization' }], unit_pricing: { per_call: 85 } }, 2027);
  check('CPI escalators are not guessed; unit pricing is reported not forecast; one-time fees land in their month', k5.issues.some((x) => x.code === 'cpi_escalator') && k5.issues.some((x) => x.code === 'unit_pricing') && k5.one_time_cents === 50000 && k5.months[2] === 120000 + 50000);

  console.log('contract driver in the forecast');
  const doc = { file_hash: 'abc123', document_version: 1, file_path: 'vendor-contracts/c/abc123.pdf', source_message_id: 'MSG-1' };
  const verified = { id: 'vc1', vendor_name: 'Star Protection', execution_status: 'verified_executed', status: 'active', effective_date: '2025-01-01', end_date: '2027-12-31', periodic_amount: 19583.33, periodic_frequency: 'monthly',
    rate_schedule: [{ effective_date: '2027-01-01', periodic_amount: 20500, note: '2027 renewal rate' }], verified_by: 'ed', verified_at: '2026-10-10T12:00:00Z', verification_source: 'Signed copy page 7', ...doc };
  const cv = WF.buildLine(L({ budget: flat(23500000), ytd: 17370200, months: { 8: 1958300, 9: 1958300 }, contracts: [verified] }), ctx);
  const ci = item(cv, 'contract');
  check('a verified contract prices 2027: 2026 baseline + contract rate change = contractual forecast', ci.status === 'applied' && cv.recommendation_cents === 24600000 && ci.amount_cents === 24600000 - cv.base_year.normalized_cents, `${ci.status} ${cv.recommendation_cents}`);
  check('the bridge shows vendor, effective date, source document/version/hash, old rate, new rate, calculation, confidence', ci.evidence.contract.vendor === 'Star Protection' && ci.evidence.contract.effective_date === '2025-01-01'
    && ci.evidence.contract.document.file_hash === 'abc123' && ci.evidence.contract.document.document_version === 1 && ci.evidence.contract.document.source_message_id === 'MSG-1'
    && ci.evidence.old_rate.cents === 1958333 && ci.evidence.new_rate.cents === 2050000 && ci.evidence.calculation.length && ci.confidence === 'high');
  check('general inflation is not stacked on a contract that sets the full-year price', item(cv, 'rate').status === 'not_applicable');
  const likely = { ...verified, id: 'vc2', execution_status: 'likely_executed', verified_by: null, verified_at: null, verification_source: null, execution_reason: 'both parties signed (machine-read)' };
  const cl = WF.buildLine(L({ budget: flat(23500000), ytd: 17370200, months: { 8: 1958300, 9: 1958300 }, contracts: [likely] }), ctx);
  check('a likely-executed contract is shown with its would-be effect but NOT applied; confidence lowered', item(cl, 'contract').status === 'needs_verification' && item(cl, 'contract').amount_cents === null
    && item(cl, 'contract').evidence.would_be_cost_cents === 24600000 && cl.recommendation_cents !== 24600000 && cl.confidence.model === 'low');
  check('no verified contract: no contractual adjustment is invented', item(a, 'contract').status === 'no_evidence' && !a.bridge.some((b) => b.driver === 'contract' && b.status === 'applied'));
  const two = WF.buildLine(L({ contracts: [verified, { ...verified, id: 'vc3' }] }), ctx);
  check('two verified contracts on one line: needs review, nothing applied', item(two, 'contract').status === 'needs_review' && item(two, 'contract').amount_cents === null);
  const part = WF.buildLine(L({ budget: flat(12000000), ytd: 9000000, months: { 8: 1000000, 9: 1000000 }, contracts: [{ ...verified, end_date: '2027-06-30', periodic_amount: 1100, rate_schedule: [] }] }), ctx);
  check('partial-year contract: contract prices covered months; inflation only on the uncovered share; flagged', item(part, 'contract').status === 'applied' && item(part, 'contract').evidence.contract_cost_cents === 660000
    && item(part, 'rate').amount_cents === Math.round(Math.round(part.base_year.normalized_cents * 6 / 12) * 0.03) && /not covered/.test(item(part, 'contract').note));

  console.log('contract intake triage (machine never verifies)');
  const both = intake.determineExecution({ signatures: { association_signed: true, vendor_signed: true, association_signed_date: '2025-12-15', vendor_signed_date: '2025-12-12', association_signer: 'Pres', vendor_signer: 'VP' }, warnings: [] });
  check('both parties signed and dated -> likely_executed (never verified_executed), with a reason', both.execution_status === 'likely_executed' && both.execution_confidence === 0.85 && /needs human verification/.test(both.execution_reason));
  check('one signature -> detected; none -> detected', intake.determineExecution({ signatures: { association_signed: false, vendor_signed: true }, warnings: [] }).execution_status === 'detected' && intake.determineExecution({ signatures: null }).execution_status === 'detected');
  check('extraction warnings lower the triage score', intake.determineExecution({ signatures: { association_signed: true, vendor_signed: true, association_signed_date: '2025-01-01', vendor_signed_date: '2025-01-01' }, warnings: ['two fee schedules'] }).execution_confidence === 0.75);
  const rec = intake.contractRecord({ management_company_id: 'm', community_id: 'c', extraction: { vendor_name: 'X', signatures: { association_signed: true, vendor_signed: true, association_signed_date: '2025-01-01', vendor_signed_date: '2025-01-01' }, periodic_amount: 100, periodic_frequency: 'monthly', rate_schedule: [], one_time_fees: [], warnings: [] }, file_path: 'p', file_hash: 'h', file_size_bytes: 1 });
  check('the contract record from an upload is never verified and keeps the document hash', rec.execution_status === 'likely_executed' && !rec.verified_by && rec.file_hash === 'h' && rec.periodic_amount === 100);
  const stub = intake.onEmailEvent({ id: 'MSG-9' });
  check('email intake is a stub that describes the pipeline and writes nothing', stub.stub === true && stub.message_id === 'MSG-9' && stub.plan.length === 6);

  console.log('loader (read-only) on the Drama Creek fixture');
  F.seed();
  const { loadWorkingForecastInput } = require('../lib/forecast/working_forecast_data');
  const inp = await loadWorkingForecastInput(F.fakeClient(), { community_id: F.CID, target_year: 2027, as_of: '2026-09-30' });
  check('loader: base year 2026, true post-cutover months Aug-Sep, approved-budget lines with monthly phasing', inp.base_year === 2026 && inp.post_cutover_months.join() === '8,9' && inp.lines.some((l) => Array.isArray(l.budget_months) && l.budget_months.length === 12));
  const lm = WF.buildWorkingForecast(inp);
  const l5200 = lm.lines.find((l) => l.account_number === '5200');
  check('loader + engine: a fixture line forecasts with YTD from the statement engine (incl. carryforward)', l5200 && l5200.base_year.ytd_actual_cents === 11870000 && l5200.base_year.current_forecast_cents === 11870000 + 3 * 1290000);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
