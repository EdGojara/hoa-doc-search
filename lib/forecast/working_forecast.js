// ============================================================================
// lib/forecast/working_forecast.js  (Ed 2026-10-10, Financial Intelligence slice 1)
// ----------------------------------------------------------------------------
// THE NEXT-YEAR WORKING FORECAST (management forecast, not the board budget).
// PURE and deterministic: integer cents in, integer cents out, no I/O, no AI.
//
// TrustEd does not build next year by copying the prior budget and applying a
// percentage. Each line is built from explicit drivers, and every driver keeps
// its evidence, assumption, confidence and source:
//
//   2026 expected spend (base)
//     - one-time / abnormal costs            (driver: one_time)
//     + recurring costs omitted from 2026    (driver: omitted_recurring)
//     + contractual changes                  (driver: contract)
//     + inflation / rate changes             (driver: rate)
//     + expected recurring volatility        (driver: volatility)
//   = TrustEd 2027 model recommendation
//   (human / board override kept SEPARATE; the model value is never overwritten)
//
// Unknown is not zero. A driver without evidence is "needs evidence" or "not
// available"; it is listed in the bridge, excluded from the arithmetic, and it
// lowers the line's confidence. Nothing is classified one-time without a human
// adjustment carrying a written assumption.
//
// Driver types are open by design: contracts, utility quantity x rate, asset
// models, probabilistic ranges and backtesting plug in as new driver sources.
// ============================================================================

const crypto = require('crypto');
const { buildForecastLine } = require('../accounting/forecast_engine');
const { scaleSchedule } = require('../accounting/budget_merge');
const { contractCostForYear } = require('../contracts/contract_terms');

const MODEL_VERSION = 'trusted.working_forecast.v1';
const DRIVERS = ['one_time', 'omitted_recurring', 'contract', 'rate', 'volatility'];
const DRIVER_LABEL = {
  one_time: 'One-time / abnormal (removed)', omitted_recurring: 'Recurring cost omitted from 2026',
  contract: 'Contract / known change', rate: 'Inflation / rate', volatility: 'Expected recurring volatility',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CONF_ORDER = ['high', 'medium', 'low', 'unknown'];
const worst = (...c) => c.reduce((a, b) => (CONF_ORDER.indexOf(b) > CONF_ORDER.indexOf(a) ? b : a), 'high');
const int = (n) => Math.round(Number(n) || 0);
const sum = (a) => (a || []).reduce((t, v) => t + int(v), 0);
const fmt = (c) => { const n = int(c) / 100; const t = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `($${t})` : `$${t}`; };
const key = (a, f) => `${a}|${f || ''}`;
const vendorOf = (c) => c.vendor_name || c.vendor_name_raw || 'The contract';
// Exact source of every contract term used: the contract record and the document / version it came from.
const contractRef = (c) => ({ vendor_contract_id: c.id, vendor: c.vendor_name || c.vendor_name_raw || null, service: c.service_category || null, effective_date: c.effective_date || null, end_date: c.end_date || null,
  execution_status: c.execution_status, execution_confidence: c.execution_confidence ?? null, execution_reason: c.execution_reason || null,
  verified_by: c.verified_by || null, verified_at: c.verified_at || null, verification_source: c.verification_source || null,
  document: { file_path: c.file_path || null, file_hash: c.file_hash || null, document_version: c.document_version ?? null, source_document_id: c.source_document_id || null, source_message_id: c.source_message_id || null } });

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * Build one line.
 * line: { account_id, account_number, account_name, account_type, fund_id, fund_code,
 *         budget_months[12]|null, ytd_actual, month_actuals: {8: cents, 9: cents, ...} (post-cutover true months),
 *         carryforward_through: 'YYYY-MM-DD'|null }
 * ctx:  { as_of_month, base_year, target_year, policy: { expense_inflation_pct, inflation_source }, post_cutover_months: [8,9] }
 * adj:  { [driver]: { amount_cents, assumption, evidence, confidence, source, actor, created_at } }   (latest per driver)
 * ovr:  { override_cents, reason, actor, created_at, model_recommendation_cents } | null
 */
function buildLine(line, ctx, adj = {}, ovr = null) {
  const isExp = line.account_type === 'expense';
  const hasBudget = Array.isArray(line.budget_months) && line.budget_months.length === 12;
  const budget = hasBudget ? line.budget_months.map(int) : Array(12).fill(0);
  const annualBudget = sum(budget);
  const asOf = int(ctx.as_of_month);
  const flags = [];

  // ---- 2026 current forecast: actual through the as-of month + remaining approved budget
  // (lib/accounting/forecast_engine.js 'remaining_budget'; the conversion lump sits in
  // the cutover month and is never treated as monthly detail).
  const actual = Array(12).fill(0);
  const post = (ctx.post_cutover_months || []).filter((m) => m <= asOf);
  let postActual = 0;
  for (const m of post) { actual[m - 1] = int((line.month_actuals || {})[m]); postActual += actual[m - 1]; }
  const preLump = int(line.ytd_actual) - postActual;
  const lumpMonth = post.length ? Math.max(post[0] - 1, 1) : asOf;
  if (lumpMonth >= 1) actual[lumpMonth - 1] += preLump;
  const cf = buildForecastLine({ account_type: line.account_type, budget_months: budget, actual_months: actual, as_of_month: asOf, cutover_month: post.length ? post[0] : null, method: 'remaining_budget' });
  const currentForecast = cf.annual_forecast;
  const postBudget = post.reduce((t, m) => t + budget[m - 1], 0);

  // ---- data quality (evidence-derived, never assumed)
  let baseChoice = 'current_forecast';
  let lineConf = 'medium';
  if (post.length && postBudget !== 0 && postActual === 0) {
    flags.push({ code: 'no_post_cutover_activity', text: `No ${isExp ? 'expense' : 'revenue'} recorded in trustEd for ${post.map((m) => MONTHS[m - 1]).join('-')} ${ctx.base_year} against ${fmt(postBudget)} budgeted; the ${ctx.base_year} actual is incomplete for this line.` });
    baseChoice = 'approved_budget';
    lineConf = isExp ? 'low' : 'unknown';
  }
  if (!hasBudget) flags.push({ code: 'unbudgeted', text: `Not in the ${ctx.base_year} approved budget: ${fmt(currentForecast)} of ${ctx.base_year} activity is carried as the base until someone decides whether it recurs. Monthly phasing is an even spread.` });
  const base = baseChoice === 'approved_budget' ? annualBudget : currentForecast;
  const baseNote = baseChoice === 'approved_budget'
    ? `${ctx.base_year} approved budget (${fmt(annualBudget)}), because the ${ctx.base_year} actual for this line is incomplete. The current forecast (${fmt(currentForecast)}) is shown but not used.`
    : `${ctx.base_year} current forecast: actual through ${MONTHS[asOf - 1]} ${fmt(int(line.ytd_actual))} + remaining approved budget ${MONTHS[asOf] || ''}-Dec ${fmt(currentForecast - int(line.ytd_actual))}.`;

  // ---- bridge
  const items = [];
  const applied = (driver, a, extra = {}) => ({ driver, label: DRIVER_LABEL[driver], status: 'applied', amount_cents: int(a.amount_cents), assumption: a.assumption, evidence: a.evidence || null, confidence: a.confidence || 'medium', source: a.source || 'management', actor: a.actor || null, at: a.created_at || null, ...extra });

  // one-time / abnormal: only a human-reviewed adjustment; a 2026 overrun is flagged for review, never assumed
  // Unbudgeted activity (revenue or expense) and expense overruns are review items, never auto-classified.
  const overrun = !hasBudget ? currentForecast : isExp ? currentForecast - annualBudget : 0;
  if (adj.one_time && int(adj.one_time.amount_cents) !== 0) items.push(applied('one_time', adj.one_time));
  else if (overrun !== 0 && (overrun > 0 || !hasBudget) && baseChoice === 'current_forecast') {
    items.push({ driver: 'one_time', label: DRIVER_LABEL.one_time, status: 'needs_review', amount_cents: null, assumption: null,
      evidence: { overrun_cents: overrun }, confidence: 'unknown', source: 'system',
      note: hasBudget
        ? `${ctx.base_year} is pacing ${fmt(overrun)} over budget. Is any of it one-time? Not classified until reviewed; enter a normalization with a reason.`
        : `${fmt(overrun)} of ${ctx.base_year} activity was not budgeted. Does it recur in ${ctx.target_year}? Not classified until reviewed; enter a normalization with a reason.` });
  } else items.push({ driver: 'one_time', label: DRIVER_LABEL.one_time, status: 'none', amount_cents: 0, source: 'system', note: 'No overrun to review and no one-time item entered.' });

  // omitted recurring: human/evidence only; an incomplete line is flagged
  if (adj.omitted_recurring && int(adj.omitted_recurring.amount_cents) !== 0) items.push(applied('omitted_recurring', adj.omitted_recurring));
  else if (flags.some((f) => f.code === 'no_post_cutover_activity')) {
    items.push({ driver: 'omitted_recurring', label: DRIVER_LABEL.omitted_recurring, status: 'needs_evidence', amount_cents: null, confidence: 'unknown', source: 'system',
      note: `Post-cutover ${ctx.base_year} activity is missing; the base uses the approved budget instead. Enter a recurring amount only with evidence.` });
  } else items.push({ driver: 'omitted_recurring', label: DRIVER_LABEL.omitted_recurring, status: 'none', amount_cents: 0, source: 'system', note: 'None identified.' });

  // Normalized base-year spend: base + the signed normalization effects (a one-time removal is negative).
  const normalized = base + items.filter((i) => ['one_time', 'omitted_recurring'].includes(i.driver) && i.status === 'applied').reduce((t, i) => t + int(i.amount_cents), 0);

  // contract: a VERIFIED executed contract bound to this line sets the price for the months it
  // covers (structured terms only, lib/contracts/contract_terms.js). A likely-executed or detected
  // contract is shown with its would-be effect but never applied. Absent both, a management entry
  // with evidence may be used; otherwise "none on file". Nothing is invented.
  const contracts = line.contracts || [];
  const live = (c) => !['terminated', 'superseded'].includes(c.status);
  const verified = contracts.filter((c) => c.execution_status === 'verified_executed' && live(c));
  const unverified = contracts.filter((c) => ['likely_executed', 'detected'].includes(c.execution_status) && live(c));
  let contractShare = 0;   // months (of 12) the verified contract prices
  if (verified.length > 1) {
    items.push({ driver: 'contract', label: DRIVER_LABEL.contract, status: 'needs_review', amount_cents: null, confidence: 'unknown', source: 'contract',
      evidence: { contracts: verified.map(contractRef) }, note: `${verified.length} verified contracts are bound to this line; pick the one that governs ${ctx.target_year} before the contract driver is applied.` });
  } else if (verified.length === 1) {
    const c = verified[0]; const cost = contractCostForYear(c, ctx.target_year);
    if (!cost.covered_months) {
      items.push({ driver: 'contract', label: DRIVER_LABEL.contract, status: 'needs_review', amount_cents: null, confidence: 'unknown', source: 'contract', evidence: { contract: contractRef(c), issues: cost.issues },
        note: `The verified contract does not price ${ctx.target_year}: ${cost.issues.map((x) => x.text).join(' ')}` });
    } else {
      contractShare = cost.covered_months;
      const baseShare = Math.round(normalized * cost.covered_months / 12);
      const amt = cost.annual_cents - baseShare;
      items.push({ driver: 'contract', label: DRIVER_LABEL.contract, status: 'applied', amount_cents: amt, source: 'contract', confidence: cost.issues.length ? 'medium' : 'high', actor: c.verified_by || null, at: c.verified_at || null,
        assumption: `${vendorOf(c)} prices ${cost.covered_months} month(s) of ${ctx.target_year} at ${fmt(cost.annual_cents)} (vs ${fmt(baseShare)} of the normalized ${ctx.base_year} base for those months).`,
        evidence: { contract: contractRef(c), old_rate: cost.rate_at_end_of_prior_year, new_rate: cost.rate_at_start_of_year, calculation: cost.steps, contract_cost_cents: cost.annual_cents, base_share_cents: baseShare, months: cost.months, issues: cost.issues },
        note: cost.issues.length ? cost.issues.map((x) => x.text).join(' ') : null });
    }
  } else if (unverified.length) {
    const c = unverified[0]; const cost = contractCostForYear(c, ctx.target_year);
    items.push({ driver: 'contract', label: DRIVER_LABEL.contract, status: 'needs_verification', amount_cents: null, confidence: 'unknown', source: 'contract',
      evidence: { contract: contractRef(c), would_be_cost_cents: cost.covered_months ? cost.annual_cents : null, old_rate: cost.rate_at_end_of_prior_year, new_rate: cost.rate_at_start_of_year, calculation: cost.steps, issues: cost.issues },
      note: `${vendorOf(c)} is ${c.execution_status === 'likely_executed' ? 'likely executed' : 'detected'} but not verified${cost.covered_months ? `; it would price ${ctx.target_year} at ${fmt(cost.annual_cents)}` : ''}. Not applied until a person verifies execution against the source document.` });
  } else if (adj.contract && int(adj.contract.amount_cents) !== 0) items.push(applied('contract', adj.contract));
  else items.push({ driver: 'contract', label: DRIVER_LABEL.contract, status: 'no_evidence', amount_cents: null, confidence: 'unknown', source: 'system', note: 'No contract or known change on file for this line.' });

  // rate / inflation: an explicit management assumption from policy, applied to the normalized base (expenses only)
  if (adj.rate) items.push(applied('rate', adj.rate));
  else if (isExp && contractShare === 12) {
    items.push({ driver: 'rate', label: DRIVER_LABEL.rate, status: 'not_applicable', amount_cents: 0, source: 'contract', note: `The verified contract sets the ${ctx.target_year} price; general inflation is not applied on top.` });
  } else if (isExp && ctx.policy && ctx.policy.expense_inflation_pct != null) {
    const pct = Number(ctx.policy.expense_inflation_pct);
    const share = Math.round(normalized * (12 - contractShare) / 12);
    const amt = Math.round(share * pct / 100);
    items.push({ driver: 'rate', label: DRIVER_LABEL.rate, status: 'applied', amount_cents: amt, factor: pct / 100,
      assumption: contractShare ? `${pct}% on the ${12 - contractShare} month(s) not priced by the contract (${fmt(share)} of the normalized ${ctx.base_year} base).` : `${pct}% on the normalized ${ctx.base_year} base (${fmt(normalized)}).`, evidence: { policy: ctx.policy.inflation_source || 'management policy' },
      confidence: ctx.policy.inflation_confidence || 'low', source: 'management policy', note: ctx.policy.inflation_source || null });
  } else items.push({ driver: 'rate', label: DRIVER_LABEL.rate, status: isExp ? 'needs_evidence' : 'not_applicable', amount_cents: isExp ? null : 0, source: 'system',
    note: isExp ? 'No inflation assumption set.' : 'Revenue is not inflated by the model; assessment changes are board decisions.' });

  // volatility: from history (future driver source); thin history => not available
  if (adj.volatility) items.push(applied('volatility', adj.volatility));
  else items.push({ driver: 'volatility', label: DRIVER_LABEL.volatility, status: 'not_available', amount_cents: null, confidence: 'unknown', source: 'historical model',
    note: ctx.history_note || 'Not enough monthly history to measure recurring over/under-runs.' });

  // one_time amounts are stored as the signed effect on 2027 (a removal is negative)
  const recommendation = base + items.filter((i) => i.status === 'applied').reduce((t, i) => t + int(i.amount_cents), 0);
  const unresolved = items.filter((i) => ['needs_review', 'needs_evidence', 'needs_verification'].includes(i.status));
  // Line confidence reflects the line's own evidence; the inflation POLICY's confidence is reported once, at summary level.
  const modelConf = worst(lineConf, unresolved.length ? 'low' : 'medium', ...items.filter((i) => i.status === 'applied' && i.source !== 'management policy').map((i) => i.confidence || 'medium'));
  const evidenceStatus = flags.some((f) => f.code === 'no_post_cutover_activity') ? 'incomplete_source_data' : unresolved.length ? 'needs_review' : 'supported';

  const override = ovr && ovr.override_cents != null ? { amount_cents: int(ovr.override_cents), model_recommendation_cents: int(ovr.model_recommendation_cents), delta_vs_recorded_model_cents: int(ovr.override_cents) - int(ovr.model_recommendation_cents),
    delta_vs_current_model_cents: int(ovr.override_cents) - recommendation, model_changed_since_override: int(ovr.model_recommendation_cents) !== recommendation, reason: ovr.reason, actor: ovr.actor, at: ovr.created_at } : null;
  const final = override ? override.amount_cents : recommendation;
  const months = hasBudget && annualBudget !== 0 ? scaleSchedule(budget, annualBudget, final) : scaleSchedule(Array(12).fill(1), 12, final);

  return {
    account_id: line.account_id, account_number: line.account_number, account_name: line.account_name, account_type: line.account_type,
    fund_id: line.fund_id || null, fund_code: line.fund_code || null,
    base_year: { approved_budget_cents: hasBudget ? annualBudget : null, ytd_actual_cents: int(line.ytd_actual), current_forecast_cents: currentForecast,
      post_cutover: post.length ? { months: post.map((m) => MONTHS[m - 1]), actual_cents: postActual, budget_cents: postBudget } : null, normalized_cents: normalized },
    base: { cents: base, choice: baseChoice, note: baseNote },
    bridge: items,
    columns: {
      normalization_cents: items.filter((i) => ['one_time', 'omitted_recurring'].includes(i.driver) && i.status === 'applied').reduce((t, i) => t + i.amount_cents, 0),
      normalization_status: items.filter((i) => ['one_time', 'omitted_recurring'].includes(i.driver)).some((i) => ['needs_review', 'needs_evidence'].includes(i.status)) ? 'needs_review' : 'ok',
      contract_cents: (items.find((i) => i.driver === 'contract' && i.status === 'applied') || {}).amount_cents ?? null,
      rate_cents: (items.find((i) => i.driver === 'rate' && i.status === 'applied') || {}).amount_cents ?? null,
      volatility_cents: (items.find((i) => i.driver === 'volatility' && i.status === 'applied') || {}).amount_cents ?? null,
    },
    recommendation_cents: recommendation,
    override,
    final_cents: final,
    months_2027: months,
    phasing: hasBudget && annualBudget !== 0 ? `${ctx.base_year} approved monthly phasing, scaled to the ${ctx.target_year} amount` : 'even spread (no phasing source)',
    confidence: { model: modelConf, final: override ? 'management decision' : modelConf },
    evidence_status: evidenceStatus,
    contracts: contracts.map(contractRef),
    flags,
  };
}

/**
 * Build the whole working forecast.
 * input: { community, base_year, target_year, as_of, as_of_month, post_cutover_months, history_note,
 *          lines: [...], facts: {...}, policy: {...}, adjustments: [...], overrides: [...] }
 */
function buildWorkingForecast(input, { now = new Date() } = {}) {
  const ctx = { as_of_month: input.as_of_month, base_year: input.base_year, target_year: input.target_year, policy: input.policy || {}, post_cutover_months: input.post_cutover_months || [], history_note: input.history_note };
  // latest adjustment per (line, driver); latest override per line (append-only stores)
  const adjBy = new Map(); for (const a of [...(input.adjustments || [])].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) { const k = key(a.account_id, a.fund_id); if (!adjBy.has(k)) adjBy.set(k, {}); adjBy.get(k)[a.driver] = a; }
  const ovrBy = new Map(); for (const o of [...(input.overrides || [])].sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) ovrBy.set(key(o.account_id, o.fund_id), o);
  const lines = (input.lines || []).map((l) => buildLine(l, ctx, adjBy.get(key(l.account_id, l.fund_id)) || {}, ovrBy.get(key(l.account_id, l.fund_id)) || null))
    .sort((a, b) => (a.account_type === b.account_type ? String(a.account_number).localeCompare(String(b.account_number)) : a.account_type === 'revenue' ? -1 : 1));

  const tot = (type, f) => lines.filter((l) => l.account_type === type).reduce((t, l) => t + int(f(l)), 0);
  const block = (f) => { const r = tot('revenue', f), e = tot('expense', f); return { revenue: r, expense: e, net: r - e }; };
  const approved = block((l) => l.base_year.approved_budget_cents || 0);
  const current = block((l) => l.base_year.current_forecast_cents);
  const normalized = block((l) => l.base_year.normalized_cents);
  const model = block((l) => l.recommendation_cents);
  const working = block((l) => l.final_cents);
  const diff = (a, b) => ({ revenue: a.revenue - b.revenue, expense: a.expense - b.expense, net: a.net - b.net });

  // top drivers: every applied bridge effect plus the 2026 pace vs budget, ranked by size
  const drivers = [];
  for (const l of lines) {
    const pace = l.base.choice === 'current_forecast' && l.base_year.approved_budget_cents != null ? l.base_year.current_forecast_cents - l.base_year.approved_budget_cents : 0;
    if (pace) drivers.push({ account: `${l.account_number} ${l.account_name}`, account_type: l.account_type, driver: 'base_year_pace', label: `${input.base_year} pacing vs budget`, amount_cents: pace });
    for (const i of l.bridge) if (i.status === 'applied' && int(i.amount_cents) !== 0) drivers.push({ account: `${l.account_number} ${l.account_name}`, account_type: l.account_type, driver: i.driver, label: i.label, amount_cents: int(i.amount_cents) });
  }
  drivers.sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents));
  const needs = lines.filter((l) => l.evidence_status !== 'supported');
  const confCount = lines.reduce((o, l) => { o[l.confidence.model] = (o[l.confidence.model] || 0) + 1; return o; }, {});
  const f = input.facts || {};
  const reasons = [];
  if ((input.post_cutover_months || []).length && f.converted_through) reasons.push({ code: 'converted_mid_year', text: `trustEd's monthly detail begins after the ${f.converted_through} conversion; earlier ${input.base_year} activity is one carried-forward amount, so seasonality and recurring volatility cannot be measured yet.` });
  const missing = lines.filter((l) => l.flags.some((x) => x.code === 'no_post_cutover_activity'));
  if (missing.length) reasons.push({ code: 'post_cutover_gaps', text: `${missing.length} line(s) have budgeted ${input.base_year} amounts with no post-cutover activity recorded (${missing.filter((l) => l.account_type === 'revenue').length} revenue, ${missing.filter((l) => l.account_type === 'expense').length} expense). Their base falls back to the approved budget and confidence is lowered.` });
  if (f.recognition_schedules === 0) reasons.push({ code: 'no_recognition_schedules', text: `No recognition schedules are on file, so prepaid and deferred balances are not being recognized monthly. Expense and revenue lines fed by them may be understated in ${input.base_year} even where activity is recorded.` });
  if (f.bank_recs_incomplete) reasons.push({ code: 'bank_recs_incomplete', text: `${f.bank_recs_incomplete} bank reconciliation(s) are not complete.` });
  if (f.closed_through === null) reasons.push({ code: 'no_closed_month', text: `No month of ${input.base_year} has been closed under the month-end close.` });
  if (f.vendor_contracts === 0) reasons.push({ code: 'no_contracts', text: 'No vendor contracts are on file, so contract escalators cannot be applied yet (contract driver shows "none on file").' });
  const revenueReliable = !missing.some((l) => l.account_type === 'revenue');
  const status = reasons.some((r) => ['post_cutover_gaps', 'no_recognition_schedules'].includes(r.code)) ? 'incomplete' : reasons.length ? 'partial' : 'supported';

  const out = {
    model_version: MODEL_VERSION, kind: 'management_forecast',
    community: input.community, base_year: input.base_year, target_year: input.target_year, as_of: input.as_of,
    policy: input.policy || {},
    data_status: { status, revenue_reliable: revenueReliable, expense_note: 'Expense lines with post-cutover activity are supported by posted bills; lines without it fall back to the approved budget.', reasons },
    summary: {
      approved_base_year: approved, current_forecast_base_year: current, normalized_base_year: normalized, model: model, working: working,
      change_vs_approved: { model: diff(model, approved), working: diff(working, approved) },
      change_vs_normalized: { model: diff(model, normalized), working: diff(working, normalized) },
      top_drivers: drivers.slice(0, 5),
      needs_evidence: { lines: needs.length, model_cents: needs.reduce((t, l) => t + Math.abs(l.recommendation_cents), 0) },
      overrides: lines.filter((l) => l.override).length,
      confidence: confCount,
      assumptions: (input.policy && input.policy.expense_inflation_pct != null) ? [{ driver: 'rate', text: `Expense inflation ${input.policy.expense_inflation_pct}%`, source: input.policy.inflation_source || null, confidence: input.policy.inflation_confidence || 'low' }] : [],
    },
    lines, generated_at: new Date(now).toISOString(),
  };
  const { generated_at, ...content } = out;
  out.model_sha256 = crypto.createHash('sha256').update(canonical(content)).digest('hex');
  return out;
}

module.exports = { MODEL_VERSION, DRIVERS, DRIVER_LABEL, buildLine, buildWorkingForecast, canonical };
