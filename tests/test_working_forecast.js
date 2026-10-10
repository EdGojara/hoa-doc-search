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
const L = (o) => ({ account_id: o.id || 'a1', account_number: o.n || '5770', account_name: o.name || 'Security', account_type: o.type || 'expense', fund_id: o.fund === undefined ? 'f' : o.fund, fund_code: o.fundCode || 'OPR', fund_type: o.fundType === undefined ? 'operating' : o.fundType,
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
  const norm = WF.buildLine(L({ ytd: 13000000 }), ctx, { one_time: { amount_cents: -4000000, base_cents: 16000000, base_as_of: '2026-09-30', assumption: 'Gate rebuild invoiced in 2026 is one-time', confidence: 'medium', source: 'management', actor: 'ed', created_at: '2026-10-10T10:00:00Z' } });
  check('a human one-time adjustment (signed effect) normalizes the base and inflation applies to the normalized base', norm.base_year.normalized_cents === 12000000 && item(norm, 'rate').amount_cents === 360000 && norm.recommendation_cents === 12360000);
  check('... and the bridge carries the assumption, actor, confidence and source', item(norm, 'one_time').assumption.includes('Gate rebuild') && item(norm, 'one_time').actor === 'ed' && item(norm, 'one_time').source === 'management');
  const unb = WF.buildLine(L({ budget: null, ytd: 7426400, months: { 8: 100, 9: 100 } }), ctx);
  check('unbudgeted 2026 activity is carried as the base but flagged "does it recur?" (needs review)', unb.flags.some((f) => f.code === 'unbudgeted') && item(unb, 'one_time').status === 'needs_review' && unb.evidence_status === 'needs_review');

  console.log('A. accounting base changes after a normalization (no double removal)');
  const NORM = { amount_cents: -4000000, base_cents: 16000000, base_as_of: '2026-09-30', assumption: 'Gate rebuild invoiced in 2026 is one-time', evidence: { reference: 'Inv 29548' }, confidence: 'medium', source: 'management', actor: 'ed', created_at: '2026-10-10T10:00:00Z' };
  const recl = WF.buildLine(L({ ytd: 9000000 }), { ...ctx, as_of: '2026-09-30' }, { one_time: NORM });   // the books moved 40,000 to reserve: base 160,000 -> 120,000
  check('base changed since the normalization: flagged needs review, NOT applied', item(recl, 'one_time').status === 'needs_review' && item(recl, 'one_time').amount_cents === null && item(recl, 'one_time').evidence.issues.some((x) => x.code === 'base_changed'));
  check('... so the cost is not removed twice (recommendation = corrected base + 3%, not base - 40,000)', recl.recommendation_cents === 12000000 + 360000 && recl.base_year.normalized_cents === 12000000);
  check('... and the management decision is preserved unaltered (amount, base at entry, evidence, actor) and flagged on the line', item(recl, 'one_time').evidence.recorded_adjustment.amount_cents === -4000000 && item(recl, 'one_time').evidence.recorded_adjustment.base_cents === 16000000
    && item(recl, 'one_time').evidence.recorded_adjustment.evidence.reference === 'Inv 29548' && item(recl, 'one_time').actor === 'ed' && recl.flags.some((f) => f.code === 'normalization_needs_review') && recl.evidence_status === 'needs_review');
  const same = WF.buildLine(L({ ytd: 13000000 }), ctx, { one_time: NORM });
  check('unchanged base: the normalization applies and records the base it was made against', item(same, 'one_time').status === 'applied' && item(same, 'one_time').base_cents_at_entry === 16000000 && same.recommendation_cents === 12360000);
  const big = WF.buildLine(L({ ytd: 13000000 }), ctx, { one_time: { ...NORM, amount_cents: -20000000 } });
  check('a removal larger than the base is flagged, not applied', item(big, 'one_time').status === 'needs_review' && item(big, 'one_time').evidence.issues.some((x) => x.code === 'exceeds_base'));
  const nobase = WF.buildLine(L({ ytd: 13000000 }), ctx, { one_time: { ...NORM, base_cents: null } });
  check('a normalization without its recorded base is flagged, not applied', item(nobase, 'one_time').status === 'needs_review' && item(nobase, 'one_time').evidence.issues.some((x) => x.code === 'base_not_recorded'));

  console.log('C. normalization sign rules');
  const pos = WF.buildLine(L({ ytd: 13000000 }), ctx, { one_time: { ...NORM, amount_cents: 4000000 } });
  check('engine: a positive one-time entry is never applied as an addition', item(pos, 'one_time').status === 'needs_review' && item(pos, 'one_time').evidence.issues.some((x) => x.code === 'sign') && pos.recommendation_cents === 16000000 + 480000);
  const negR = WF.buildLine(L({}), ctx, { omitted_recurring: { ...NORM, base_cents: 12000000, amount_cents: -100 } });
  check('engine: a negative omitted-recurring entry is never applied', item(negR, 'omitted_recurring').status === 'needs_review' && item(negR, 'omitted_recurring').evidence.issues.some((x) => x.code === 'sign'));
  check('API rule: a positive one-time removal is refused', WF.checkAdjustment({ driver: 'one_time', amount_cents: 4000000 }).error === 'one_time_must_be_negative');
  check('API rule: a negative omitted-recurring amount is refused', WF.checkAdjustment({ driver: 'omitted_recurring', amount_cents: -1 }).error === 'omitted_recurring_must_be_positive');
  check('API rule: a removal larger than the base is refused; a valid removal passes', WF.checkAdjustment({ driver: 'one_time', amount_cents: -20000000, base_cents: 16000000 }).error === 'removal_exceeds_base' && WF.checkAdjustment({ driver: 'one_time', amount_cents: -4000000, base_cents: 16000000 }) === null);
  check('API rule: other drivers keep their sign freedom; unknown drivers and non-integers are refused', WF.checkAdjustment({ driver: 'contract', amount_cents: -500 }) === null && WF.checkAdjustment({ driver: 'guess', amount_cents: 1 }).error === 'driver_invalid' && WF.checkAdjustment({ driver: 'rate', amount_cents: 1.5 }).error === 'amount_cents_must_be_an_integer');

  console.log('B. unbudgeted revenue excluded unless authorized');
  const GAINS = { id: 'g', n: '4205', name: 'Unrealized Gains/Losses', type: 'revenue', budget: null, ytd: 6364500, months: { 8: 100, 9: 100 }, fund: 'r', fundCode: 'RES', fundType: 'reserve' };
  const gains = WF.buildLine(L(GAINS), ctx);
  check('unrealized gains (unbudgeted revenue) are excluded from the recommendation', gains.recommendation_cents === 0 && gains.base.choice === 'excluded_unbudgeted_revenue' && gains.final_cents === 0);
  check('... but stay visible: amount shown, flagged, and listed as needs review', gains.base_year.current_forecast_cents === 6364500 && gains.base_year.excluded_cents === 6364500 && gains.flags.some((f) => f.code === 'unbudgeted_revenue_excluded')
    && item(gains, 'omitted_recurring').status === 'needs_review' && item(gains, 'omitted_recurring').evidence.excluded_cents === 6364500 && gains.evidence_status === 'needs_review');
  const auth = WF.buildLine(L(GAINS), ctx, { omitted_recurring: { amount_cents: 2000000, base_cents: 0, base_as_of: '2026-09-30', assumption: 'Board expects recurring investment income of 20,000', confidence: 'low', source: 'board', actor: 'ed', created_at: 'x' } });
  check('explicit authorization (a recorded recurring entry with a reason) includes only the authorized amount', auth.recommendation_cents === 2000000 && item(auth, 'omitted_recurring').status === 'applied' && item(auth, 'omitted_recurring').source === 'board');
  const unbExp = WF.buildLine(L({ budget: null, ytd: 500000, months: { 8: 100, 9: 100 } }), ctx);
  check('unbudgeted EXPENSE is still carried (conservative) and flagged', unbExp.base.cents === 500000 && unbExp.recommendation_cents > 0 && unbExp.flags.some((f) => f.code === 'unbudgeted'));

  console.log('E. summary separates funds; operating is the board budget');
  const fin = { community: { id: 'c', name: 'Test' }, base_year: 2026, target_year: 2027, as_of: '2026-09-30', as_of_month: 9, post_cutover_months: [8, 9], policy: ctx.policy, facts: {},
    lines: [L({ id: 'o1', n: '4000', name: 'Assessments', type: 'revenue' }), L({ id: 'o2', n: '5250', name: 'Monument' }), L(GAINS),
      L({ id: 'r2', n: '6000', name: 'Reserve Expenditures', fund: 'r', fundCode: 'RES', fundType: 'reserve', ytd: 30000000, months: { 8: 100000, 9: 100000 } }),
      L({ id: 'x1', n: '5999', name: 'No fund line', fund: null, fundType: null })] };
  const fm = WF.buildWorkingForecast(fin);
  const opr = fm.summary.funds.find((x) => x.fund_code === 'OPR' && x.fund_type === 'operating'), res = fm.summary.funds.find((x) => x.fund_code === 'RES');
  check('headline summary is the operating fund only (basis + primary fund named)', fm.summary.basis === 'operating_fund' && fm.summary.primary_fund.fund_code === 'OPR' && fm.summary.model.expense === opr.model.expense && fm.summary.model.revenue === opr.model.revenue);
  check('reserve results are not in the operating headline', fm.summary.model.expense === fm.lines.filter((l) => l.fund_id === 'f' && l.account_type === 'expense').reduce((t, l) => t + l.recommendation_cents, 0) && res.model.expense > 0);
  check('every fund is listed separately (operating first), lines without a fund in their own group; no all-funds total', fm.summary.funds.length === 3 && fm.summary.funds[0].primary && fm.summary.funds.some((x) => x.fund_type === 'unassigned' && x.line_count === 1)
    && fm.data_status.reasons.some((r) => r.code === 'lines_without_fund') && !('all_funds' in fm.summary));
  check('excluded unbudgeted revenue is reported in its own fund', res.excluded_unbudgeted_revenue.lines === 1 && res.excluded_unbudgeted_revenue.cents === 6364500 && opr.excluded_unbudgeted_revenue.lines === 0);
  const neg = WF.buildWorkingForecast({ ...fin, lines: [...fin.lines, L({ id: 'r3', n: '4010', name: 'Reserve Contribution', type: 'revenue', budget: flat(-16400000), ytd: 0, months: { 8: 0, 9: 0 }, fund: 'r', fundCode: 'RES', fundType: 'reserve' })] });
  const negR2 = neg.data_status.reasons.find((r) => r.code === 'negative_revenue_budget');
  check('a negative revenue budget (a transfer between funds) is called out with its fund, not re-assigned', negR2 && negR2.accounts[0].account.startsWith('4010') && negR2.accounts[0].fund_code === 'RES' && neg.summary.funds.find((x) => x.fund_code === 'RES').approved_base_year.revenue < 0);
  const twoOp = WF.buildWorkingForecast({ ...fin, lines: [L({ id: 'o1' }), L({ id: 'o3', fund: 'g', fundCode: 'OPR2' })] });
  check('two operating funds: no combined operating budget is invented (headline empty, reason given)', twoOp.summary.basis === null && twoOp.summary.model === null && twoOp.data_status.reasons.some((r) => r.code === 'no_operating_fund') && twoOp.summary.funds.length === 2);

  console.log('F. interfund transfers (4010 Reserve Contribution, explicitly configured)');
  const TX = { from_fund_id: 'f', from_fund_code: 'OPR', from_fund_type: 'operating', to_fund_id: 'r', to_fund_code: 'RES', to_fund_type: 'reserve' };
  const none = { 8: 0, 9: 0 };
  const cgLines = (o = {}) => [
    L({ id: 'o4000', n: '4000', name: 'Assessments', type: 'revenue', budget: flat(110579600), ytd: 0, months: none }),
    L({ id: 'o5000', n: '5000', name: 'Operating expenses', budget: flat(96507800), ytd: 0, months: none }),
    { ...L({ id: 'r4010', n: '4010', name: 'Reserve Contribution', type: 'revenue', budget: flat(-16400000), ytd: 0, months: none, fund: 'r', fundCode: 'RES', fundType: 'reserve' }), ...(o.cfg === undefined ? { transfer: TX } : o.cfg) },
    L({ id: 'a4050', n: '4050', name: 'Adopt a School Income', type: 'revenue', budget: flat(495000), ytd: 0, months: none, fund: 'a', fundCode: 'ADO', fundType: 'other' }),
    L({ ...GAINS }),
  ];
  const cg = (o = {}) => WF.buildWorkingForecast({ ...fin, facts: {}, lines: cgLines(o), overrides: o.overrides || [] });
  const tm = cg();
  const t4010 = tm.lines.find((l) => l.account_number === '4010');
  check('a configured transfer line is presented as a transfer, never as revenue or expense', t4010.kind === 'interfund_transfer' && t4010.transfer.from_fund_code === 'OPR' && t4010.transfer.to_fund_code === 'RES' && t4010.transfer.recorded_leg === 'outgoing');
  check('no inflation, normalization or other driver applies to a transfer (even with a 3% policy)', t4010.bridge.every((b) => b.status === 'not_applicable' && b.amount_cents === 0) && t4010.recommendation_cents === -16400000);
  check('the $164,000 is carried as a provisional 2027 assumption marked Needs board decision', t4010.transfer.model_cents === 16400000 && t4010.transfer.status === 'needs_board_decision' && t4010.evidence_status === 'needs_board_decision' && t4010.flags.some((f) => f.code === 'transfer_provisional' && /Needs board decision/.test(f.text)));
  const tAdj = WF.buildLine(cgLines()[2], ctx, { one_time: { amount_cents: -5000000, base_cents: -16400000, base_as_of: '2026-09-30', assumption: 'should never apply to a transfer', confidence: 'low', actor: 'x', created_at: 'x' }, rate: { amount_cents: 99, assumption: 'should never apply to a transfer', actor: 'x', created_at: 'x' } });
  check('a stray adjustment on a transfer line is never applied', tAdj.bridge.every((b) => b.status === 'not_applicable') && tAdj.recommendation_cents === -16400000);
  const op = tm.summary;
  check('operating before reserve funding excludes the transfer (2026 approved $140,718)', op.approved_base_year.revenue === 110579600 && op.approved_base_year.net === 14071800);
  check('planned reserve funding is shown separately ($164,000 out of Operating)', op.approved_base_year.transfers_out === 16400000 && op.approved_base_year.transfers_in === 0 && op.transfers.length === 1 && op.transfers[0].label === 'Planned reserve funding' && op.board_decisions.length === 1);
  check('operating after reserve funding = before - funding (2026 approved ($23,282))', op.approved_base_year.net_after_transfers === -2328200 && op.model.net_after_transfers === op.model.net - 16400000);
  const resF = tm.summary.funds.find((x) => x.fund_code === 'RES');
  check('the Reserve fund shows the positive transfer in, and the transfer is not reserve revenue', resF.approved_base_year.transfers_in === 16400000 && resF.approved_base_year.revenue === 0 && resF.approved_base_year.net_after_transfers === 16400000 && resF.transfers[0].label === 'Transfer in from OPR');
  const adoF = tm.summary.funds.find((x) => x.fund_code === 'ADO');
  check('Adopt-a-School stays out of the Operating summary and is presented on its own ($4,950)', adoF.approved_base_year.net_after_transfers === 495000 && op.approved_base_year.revenue === 110579600 && op.line_count === 2);
  const rc = tm.summary.reconciliation;
  check('reconciliation: approved budget as recorded = ($18,332), and the fund contributions tie to it without combining funds', rc.approved_budget_total.net === -1833200 && rc.ties && rc.sum_of_fund_contributions_cents === -1833200
    && rc.funds.find((x) => x.fund_code === 'OPR').contribution_to_budget_total === -2328200 && rc.funds.find((x) => x.fund_code === 'RES').contribution_to_budget_total === 0 && rc.funds.find((x) => x.fund_code === 'ADO').contribution_to_budget_total === 495000);
  check('... the $4,950 between ($23,282) and ($18,332) is the Adopt-a-School fund', rc.approved_budget_total.net - rc.funds.find((x) => x.fund_code === 'OPR').contribution_to_budget_total === 495000);
  check('... and Reserve\'s transfer in is listed as the unrecorded other side of 4010 (nets to zero across funds)', rc.unrecorded_transfer_legs.length === 1 && rc.unrecorded_transfer_legs[0].fund_code === 'RES' && rc.unrecorded_transfer_legs[0].cents === 16400000);
  check('a configured transfer does not raise the negative-revenue warning; the board decision is called out', !tm.data_status.reasons.some((r) => r.code === 'negative_revenue_budget') && tm.data_status.reasons.some((r) => r.code === 'transfers_need_board_decision'));
  check('transfers never appear in the top drivers', !op.top_drivers.some((d) => d.account.startsWith('4010')) && !resF.top_drivers.some((d) => d.account.startsWith('4010')));
  const unc = cg({ cfg: {} });
  check('without configuration (name alone), 4010 is NOT treated as a transfer and the warning is preserved', !unc.lines.find((l) => l.account_number === '4010').transfer && unc.data_status.reasons.some((r) => r.code === 'negative_revenue_budget') && unc.summary.reconciliation.ties);
  const bad = cg({ cfg: { transfer_config_error: 'the from and to funds are the same' } });
  check('an invalid configuration is reported, treated as an ordinary line, and the warning is preserved', bad.lines.find((l) => l.account_number === '4010').flags.some((f) => f.code === 'transfer_config_invalid') && bad.data_status.reasons.some((r) => r.code === 'transfer_config_invalid') && bad.data_status.reasons.some((r) => r.code === 'negative_revenue_budget'));
  const dec = cg({ overrides: [{ account_id: 'r4010', fund_id: 'r', override_cents: -20000000, model_recommendation_cents: -16400000, reason: 'Board adopted the reserve study funding of 200,000', actor: 'ed', created_at: '2026-11-01T00:00:00Z' }] });
  const dOp = dec.summary;
  check('a recorded decision (override with reason) sets the 2027 transfer; the model value is kept', dec.lines.find((l) => l.account_number === '4010').transfer.status === 'set_by_decision' && dOp.working.transfers_out === 20000000 && dOp.model.transfers_out === 16400000 && dOp.board_decisions.length === 0
    && dec.summary.funds.find((x) => x.fund_code === 'RES').working.transfers_in === 20000000);
  const D = require('../lib/forecast/working_forecast_data');
  const FUNDS = [{ id: 'f', fund_code: 'OPR', fund_type: 'operating' }, { id: 'r', fund_code: 'RES', fund_type: 'reserve' }];
  const acct = (o) => ({ account_number: '4010', account_name: 'Reserve Contribution', account_type: 'revenue', fund_id: 'r', account_subtype: 'interfund_transfer', interfund_from_fund_id: 'f', interfund_to_fund_id: 'r', ...o });
  check('loader config: subtype + direction in this community -> transfer', D.transferConfig(acct({}), FUNDS).transfer.to_fund_code === 'RES');
  check('loader config: the name alone never makes a transfer', JSON.stringify(D.transferConfig(acct({ account_subtype: 'operating_revenue', interfund_from_fund_id: null, interfund_to_fund_id: null }), FUNDS)) === '{}');
  check('loader config: missing direction, same fund, foreign fund, or account outside its funds -> reported error', /not configured/.test(D.transferConfig(acct({ interfund_to_fund_id: null }), FUNDS).transfer_config_error)
    && /same/.test(D.transferConfig(acct({ interfund_from_fund_id: 'r' }), FUNDS).transfer_config_error) && /belong/.test(D.transferConfig(acct({ interfund_to_fund_id: 'zz' }), FUNDS).transfer_config_error)
    && /sit in/.test(D.transferConfig(acct({ fund_id: 'a' }), [...FUNDS, { id: 'a', fund_code: 'ADO' }]).transfer_config_error));


  console.log('D. contract upload files the document in the library under the community management company');
  const fakeDocs = (opts = {}) => {
    const log = { inserts: [], uploads: [] };
    const tables = { communities: [{ id: 'c1', name: 'Canyon Gate', management_company_id: opts.noMc ? null : 'mc-cg' }, { id: 'c2', name: 'Other', management_company_id: 'mc-cg' }], library_documents: opts.docs || [] };
    const q = (t) => { const f = []; const api = { select: () => api, eq: (k, v) => { f.push([k, v]); return api; },
      maybeSingle: async () => ({ data: tables[t].find((r) => f.every(([k, v]) => r[k] === v)) || null, error: null }),
      insert: (row) => { log.inserts.push({ t, row }); return { select: () => ({ single: async () => ({ data: { id: 'doc-new' }, error: null }) }) }; } }; return api; };
    return { log, client: { from: q, storage: { from: () => ({ upload: async (path) => { log.uploads.push(path); return { error: null }; } }) } } };
  };
  const buf = Buffer.from('signed contract bytes');
  const fd = fakeDocs();
  const filed = await intake.fileContractDocument(fd.client, { community_id: 'c1', buffer: buf, filename: 'Star Protection.pdf', mimetype: 'application/pdf', extraction: { vendor_name: 'Star Protection', service_category: 'security', effective_date: '2026-01-01', end_date: 'not a date' } });
  const ins = fd.log.inserts.find((x) => x.t === 'library_documents');
  check('a library_documents row is created: category vendor_contract, current, this community, the file hash', ins && ins.row.category === 'vendor_contract' && ins.row.status === 'current' && ins.row.community_id === 'c1' && ins.row.file_hash === intake.sha256(buf) && filed.library_document_id === 'doc-new');
  check('the community management company is used (not an arbitrary one), and storage is filed under it', ins.row.management_company_id === 'mc-cg' && filed.management_company_id === 'mc-cg' && fd.log.uploads[0].startsWith('mc-cg/c1/vendor_contract/'));
  check('a malformed extracted date is not written to the library', ins.row.effective_date === '2026-01-01' && ins.row.expiration_date === null);
  const rec2 = intake.contractRecord({ management_company_id: filed.management_company_id, community_id: 'c1', source_document_id: filed.library_document_id, extraction: { vendor_name: 'Star Protection', signatures: null, warnings: [] }, file_path: filed.file_path, file_hash: filed.file_hash, file_size_bytes: buf.length });
  check('the contract record cites the library document and the community management company', rec2.source_document_id === 'doc-new' && rec2.management_company_id === 'mc-cg' && rec2.file_hash === filed.file_hash);
  const fd2 = fakeDocs({ docs: [{ id: 'doc-old', management_company_id: 'mc-cg', community_id: 'c1', category: 'vendor_contract', file_hash: intake.sha256(buf), file_path: 'mc-cg/c1/vendor_contract/x.pdf' }] });
  const again = await intake.fileContractDocument(fd2.client, { community_id: 'c1', buffer: buf, filename: 'copy.pdf', extraction: {} });
  check('the same bytes already in the library are reused, not duplicated or re-uploaded', again.reused && again.library_document_id === 'doc-old' && !fd2.log.inserts.length && !fd2.log.uploads.length);
  const fd3 = fakeDocs({ docs: [{ id: 'doc-x', management_company_id: 'mc-cg', community_id: 'c2', file_hash: intake.sha256(buf), file_path: 'p' }] });
  let crossErr = null; try { await intake.fileContractDocument(fd3.client, { community_id: 'c1', buffer: buf, extraction: {} }); } catch (e) { crossErr = e.message; }
  check('a document filed under another community is refused, not re-linked', crossErr === 'this_document_is_filed_under_another_community');
  let mcErr = null; try { await intake.fileContractDocument(fakeDocs({ noMc: true }).client, { community_id: 'c1', buffer: buf, extraction: {} }); } catch (e) { mcErr = e.message; }
  check('a community without a management company is refused (no guessing)', mcErr === 'community_has_no_management_company');


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
