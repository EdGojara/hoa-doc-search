// ============================================================================
// lib/forecast/working_forecast_data.js  (Ed 2026-10-10, Financial Intelligence slice 1)
// ----------------------------------------------------------------------------
// READ-ONLY loader for the next-year working forecast (lib/forecast/working_forecast.js).
// Reuses what exists; builds no parallel system:
//   - approved base-year budget + monthly phasing   community_budgets / budget_line_items (171, 464)
//   - base-year actuals (YTD incl. conversion carryforward, true post-cutover months)
//                                                    lib/accounting/financial_statements.js budgetVsActual
//   - conversion cutover                             lib/accounting/statement_periods.js loadWindows
//   - data-quality facts                             recognition_schedules, bank_reconciliations,
//                                                    close_closed_through (502), vendor_contracts
//   - human adjustments / overrides                  working_forecast_* (migration 506), when applied
// It never writes.
// ============================================================================

const FS = require('../accounting/financial_statements');
const SP = require('../accounting/statement_periods');

const DEFAULT_POLICY = {
  expense_inflation_pct: 3,
  inflation_source: 'Management assumption: the 3% expense default the living-budget planner already uses (api/books.js). It is not a sourced index; confirm or change it.',
  inflation_confidence: 'low',
};
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const must = (r, w) => { if (r.error) throw Object.assign(new Error(`${w}: ${r.error.message}`), { code: r.error.code }); return r.data || []; };

async function tableRows(supabase, table, build) {
  const r = await build(supabase.from(table));
  if (r.error) {
    if (/does not exist|relation|schema cache/i.test(r.error.message || '')) return { available: false, rows: [] };
    throw Object.assign(new Error(`${table}: ${r.error.message}`), { code: r.error.code });
  }
  return { available: true, rows: r.data || [] };
}

async function loadWorkingForecastInput(supabase, { community_id, target_year, as_of }) {
  const baseYear = Number(target_year) - 1;
  const asOf = String(as_of).slice(0, 10);
  if (Number(asOf.slice(0, 4)) !== baseYear) throw Object.assign(new Error('as_of_must_be_in_the_base_year'), { code: 'invalid_input' });
  const asOfMonth = Number(asOf.slice(5, 7));
  const comm = must(await supabase.from('communities').select('id, name, legal_name').eq('id', community_id).maybeSingle(), 'communities');
  if (!comm) throw Object.assign(new Error('community_not_found'), { code: 'not_found' });

  const budgets = must(await supabase.from('community_budgets').select('id, fiscal_year, status, approved_at').eq('community_id', community_id).eq('fiscal_year', baseYear).in('status', ['approved', 'active']).order('approved_at', { ascending: false }).limit(5), 'community_budgets');
  const budget = budgets[0] || null;
  const coa = must(await supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, fund_id').eq('community_id', community_id).in('account_type', ['revenue', 'expense']).limit(5000), 'chart_of_accounts');
  const funds = must(await supabase.from('account_funds').select('id, fund_code, fund_type').eq('community_id', community_id).limit(50), 'account_funds');
  const FC = new Map(funds.map((f) => [f.id, f.fund_code])); const FT = new Map(funds.map((f) => [f.id, f.fund_type])); const A = new Map(coa.map((a) => [a.id, a]));
  const bl = budget ? must(await supabase.from('budget_line_items').select('account_id, fund_id, annual_amount_cents, monthly_amounts_cents').eq('budget_id', budget.id).limit(5000), 'budget_line_items') : [];

  // Conversion cutover: true monthly detail starts the month after the latest carryforward window.
  const windows = await SP.loadWindows(supabase, community_id, new Map(coa.map((a) => [a.id, a.account_type])));
  const through = windows.length ? windows.map((w) => w.through).sort().pop() : null;
  const postMonths = through && Number(through.slice(0, 4)) === baseYear ? Array.from({ length: asOfMonth - Number(through.slice(5, 7)) }, (_, i) => Number(through.slice(5, 7)) + 1 + i) : [];

  // Actuals from the statement engine (one rule for activity).
  const bva = await FS.budgetVsActual({ community_id, period_end: asOf });
  const monthly = {};
  for (const m of postMonths) monthly[m] = m === asOfMonth ? bva : await FS.budgetVsActual({ community_id, period_end: monthEnd(baseYear, m) });

  const lines = new Map();
  const keyOf = (acct, fund) => `${acct}|${fund || ''}`;
  for (const b of bl) {
    const a = A.get(b.account_id); if (!a) continue;
    lines.set(keyOf(b.account_id, b.fund_id), { account_id: b.account_id, account_number: a.account_number, account_name: a.account_name, account_type: a.account_type,
      fund_id: b.fund_id || a.fund_id || null, fund_code: FC.get(b.fund_id || a.fund_id) || null, fund_type: FT.get(b.fund_id || a.fund_id) || null, budget_months: (b.monthly_amounts_cents || []).map(Number), ytd_actual: 0, month_actuals: {} });
  }
  const findLine = (r) => lines.get(keyOf(r.account_id, r.fund_id)) || lines.get(keyOf(r.account_id, null)) || [...lines.values()].find((l) => l.account_id === r.account_id);
  for (const r of bva.rows || []) {
    if (!['revenue', 'expense'].includes(r.account_type)) continue;
    let l = findLine(r);
    if (!l) { const a = A.get(r.account_id) || {}; l = { account_id: r.account_id, account_number: r.account_number || a.account_number, account_name: r.account_name || a.account_name, account_type: r.account_type, fund_id: r.fund_id || a.fund_id || null, fund_code: r.fund_code || FC.get(r.fund_id || a.fund_id) || null, fund_type: FT.get(r.fund_id || a.fund_id) || null, budget_months: null, ytd_actual: 0, month_actuals: {} }; lines.set(keyOf(r.account_id, r.fund_id), l); }
    l.ytd_actual += Number(r.ytd_actual_cents || 0);
  }
  for (const m of postMonths) for (const r of (monthly[m].rows || [])) { const l = findLine(r); if (l) l.month_actuals[m] = (l.month_actuals[m] || 0) + Number(r.mtd_actual_cents || 0); }

  // Executed-contract evidence bound to a GL line (vendor_contracts + migration 506 columns).
  const vcr = await tableRows(supabase, 'vendor_contracts', (q) => q.select('id, vendor_name_raw, service_category, effective_date, end_date, auto_renews, status, periodic_amount, periodic_frequency, rate_schedule, escalator_kind, escalator_pct, one_time_fees, unit_pricing, termination_notice_date, execution_status, execution_confidence, execution_reason, verified_by, verified_at, verification_source, file_path, file_hash, document_version, source_document_id, source_message_id, forecast_account_id, forecast_fund_id')
    .eq('community_id', community_id).not('forecast_account_id', 'is', null).limit(500));
  const contracts = vcr.available ? vcr.rows : [];
  for (const c of contracts) {
    const l = lines.get(keyOf(c.forecast_account_id, c.forecast_fund_id)) || [...lines.values()].find((x) => x.account_id === c.forecast_account_id);
    if (l) (l.contracts = l.contracts || []).push({ ...c, vendor_name: c.vendor_name_raw });
  }

  // Data-quality facts (counts only; the engine words them).
  const rec = await tableRows(supabase, 'recognition_schedules', (q) => q.select('id', { count: 'exact', head: false }).eq('community_id', community_id).limit(500));
  const recs = await tableRows(supabase, 'bank_reconciliations', (q) => q.select('id, status').eq('community_id', community_id).limit(500));
  const vc = await tableRows(supabase, 'vendor_contracts', (q) => q.select('id').eq('community_id', community_id).limit(500));
  const thru = await supabase.rpc('close_closed_through', { p_community: community_id });
  const facts = {
    converted_through: through, recognition_schedules: rec.available ? rec.rows.length : null,
    bank_recs_incomplete: recs.available ? recs.rows.filter((x) => !['reconciled', 'exported_to_vantaca'].includes(x.status)).length : null,
    closed_through: thru.error ? null : (thru.data || null), vendor_contracts: vc.available ? vc.rows.length : null,
  };

  // Persisted working forecast (migration 506) — optional until applied.
  const wf = await tableRows(supabase, 'working_forecasts', (q) => q.select('id, policy, created_by, created_at').eq('community_id', community_id).eq('fiscal_year', Number(target_year)).eq('status', 'working').limit(1));
  const forecast = wf.rows[0] || null;
  const adj = forecast ? await tableRows(supabase, 'working_forecast_adjustments', (q) => q.select('id, account_id, fund_id, driver, amount_cents, assumption, evidence, confidence, source, actor, created_at').eq('forecast_id', forecast.id).order('created_at').limit(5000)) : { available: wf.available, rows: [] };
  const ovr = forecast ? await tableRows(supabase, 'working_forecast_overrides', (q) => q.select('id, account_id, fund_id, model_recommendation_cents, model_sha256, override_cents, reason, actor, created_at').eq('forecast_id', forecast.id).order('created_at').limit(5000)) : { available: wf.available, rows: [] };

  return {
    community: { id: comm.id, name: comm.name, legal_name: comm.legal_name || null },
    base_year: baseYear, target_year: Number(target_year), as_of: asOf, as_of_month: asOfMonth,
    post_cutover_months: postMonths,
    history_note: through ? `trustEd's monthly detail starts ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(through.slice(5, 7)) % 12]} ${baseYear} (after the conversion); recurring over/under-runs need more monthly history.` : null,
    base_budget: budget ? { id: budget.id, status: budget.status, approved_at: budget.approved_at } : null,
    lines: [...lines.values()],
    facts, policy: { ...DEFAULT_POLICY, ...((forecast && forecast.policy) || {}) },
    adjustments: adj.rows.map((a) => ({ ...a, amount_cents: Number(a.amount_cents) })),
    overrides: ovr.rows.map((o) => ({ ...o, override_cents: o.override_cents == null ? null : Number(o.override_cents), model_recommendation_cents: Number(o.model_recommendation_cents) })),
    persistence: { available: wf.available, forecast_id: forecast ? forecast.id : null },
    contract_evidence: { available: vcr.available, bound: contracts.length },
  };
}

module.exports = { loadWorkingForecastInput, DEFAULT_POLICY };
