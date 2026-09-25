// ============================================================================
// lib/accounting/forecast_engine.js — Forecast Phase 3B (Ed 2026-09-25). PURE.
// ----------------------------------------------------------------------------
// Approved budget = what the board adopted (never changed here).
// Actual         = what happened (read from the GL by the caller; never written).
// Forecast       = our best estimate of where the year finishes.
//
// A forecast line = actual months (through as_of_month) + remaining months.
// The method that produced the remaining months is always recorded; there is
// no black-box number. Default: remaining approved budget. Run-rate is opt-in.
//
// Classification is EVIDENCE-ONLY. YTD variance minus full-year variance is
// NOT automatically "timing". Only drivers with evidence are known_timing /
// known_permanent; any residual is `unexplained`.
// ============================================================================

const { favorableVariance } = require('./variance');
const { scaleSchedule } = require('./budget_merge');

const METHODS = ['remaining_budget', 'run_rate', 'prior_year_pattern', 'recurring', 'manual', 'components', 'assessment_recognition'];
const COMPONENT_KINDS = ['project', 'contract', 'known_invoice', 'recurring', 'adjustment'];
const BASES = ['documented', 'calculated', 'manual'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const int = (n) => Math.round(Number(n) || 0);
const sum = (a) => (a || []).reduce((s, v) => s + int(v), 0);
const zeros = () => Array(12).fill(0);
const is12 = (m) => Array.isArray(m) && m.length === 12 && m.every((v) => Number.isFinite(Number(v)));
const err = (code) => { const e = new Error(code); e.code = code; return e; };

// Months (0-based index) that are "remaining" for an as-of month (1-12; 0 = none closed).
const remainingIdx = (asOf) => Array.from({ length: 12 }, (_, i) => i).filter((i) => i >= asOf);

// Spread `amount` over the remaining months using weights (exact to the cent).
function spread(amount, weights) {
  const w = weights.map((x) => (Number(x) > 0 ? Number(x) : 0));
  if (!w.some((x) => x > 0)) throw err('no_weight_in_remaining_months');
  return scaleSchedule(w, w.reduce((s, x) => s + x, 0), int(amount));
}

/**
 * Compute one forecast line.
 * @param {object} p
 *   account_type   'revenue' | 'expense'
 *   budget_months  [12] approved monthly budget (cents)
 *   actual_months  [12] GL actuals by month (natural sign, cents); only months < as_of_month are used
 *   as_of_month    0..12 — actuals are final through this month
 *   cutover_month  null | 1..12 — first month with TRUE monthly actuals (months before hold a lump)
 *   method         one of METHODS
 *   settings       method settings (see below)
 *   components     [{kind, label, months[12], basis, assumption?, refs:{...}, budget_months?}] for method 'components'
 * @returns {{ months, remaining, ytd_actual, remaining_total, annual_forecast, annual_budget, ytd_budget,
 *             basis, confidence, explanation, errors }}
 */
function buildForecastLine(p) {
  const asOf = int(p.as_of_month);
  if (asOf < 0 || asOf > 12) throw err('as_of_month_must_be_0_to_12');
  if (!is12(p.budget_months)) throw err('budget_months_need_12_values');
  const budget = p.budget_months.map(int);
  const actual = is12(p.actual_months) ? p.actual_months.map(int) : zeros();
  const rem = remainingIdx(asOf);
  const s = p.settings || {};
  let remaining = zeros(); let basis = 'calculated'; let confidence = 'medium'; let explanation;

  switch (p.method || 'remaining_budget') {
    case 'remaining_budget': {
      rem.forEach((i) => { remaining[i] = budget[i]; });
      explanation = `Actual through ${asOf ? MONTHS[asOf - 1] : 'none'} plus the remaining approved monthly budget.`;
      break;
    }
    case 'run_rate': {                                    // opt-in only
      const n = int(s.months_n) || 3;
      const first = Math.max(int(p.cutover_month) || 1, 1);          // never use a conversion lump
      const eligible = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => m >= first && m <= asOf);
      if (eligible.length < n) throw err('not_enough_true_monthly_actuals');
      const used = eligible.slice(-n);
      const avg = Math.round(used.reduce((t, m) => t + actual[m - 1], 0) / n);
      rem.forEach((i) => { remaining[i] = avg; });
      explanation = `Run-rate: average of ${used.map((m) => MONTHS[m - 1]).join(', ')} actuals ($${(avg / 100).toFixed(2)}/month) for the remaining months (chosen explicitly).`;
      break;
    }
    case 'prior_year_pattern': {
      if (!is12(s.prior_months)) throw err('prior_months_need_12_values');
      if (s.target_annual_cents == null) throw err('target_annual_required');
      const ytd = sum(actual.slice(0, asOf));
      const toGo = int(s.target_annual_cents) - ytd;
      const w = zeros(); rem.forEach((i) => { w[i] = Number(s.prior_months[i]) > 0 ? Number(s.prior_months[i]) : 0; });
      remaining = rem.length ? spread(toGo, w) : zeros();
      explanation = `Remaining amount to reach $${(int(s.target_annual_cents) / 100).toFixed(2)}, shaped like ${s.source_year || 'the prior year'}'s actual months.`;
      break;
    }
    case 'recurring': {
      if (s.monthly_cents == null) throw err('monthly_cents_required');
      rem.forEach((i) => { remaining[i] = int(s.monthly_cents); });
      basis = s.basis && BASES.includes(s.basis) ? s.basis : 'manual';
      explanation = `Known recurring amount of $${(int(s.monthly_cents) / 100).toFixed(2)} per remaining month.`;
      break;
    }
    case 'manual': {
      if (!String(s.reason || '').trim()) throw err('manual_override_requires_reason');
      if (!is12(s.months)) throw err('manual_months_need_12_values');
      rem.forEach((i) => { remaining[i] = int(s.months[i]); });
      basis = 'manual'; confidence = s.confidence || 'medium';
      explanation = `Manual forecast: ${String(s.reason).trim()}`;
      break;
    }
    case 'assessment_recognition': {
      // Annual levy recognized pro rata (or a documented schedule). Billing /
      // collection timing is NOT the revenue pattern.
      const levy = s.annual_levy_cents != null ? int(s.annual_levy_cents) : sum(budget);
      // Schedule: a documented one if given; else the approved monthly budget
      // (Ed: "recognized actual + remaining approved monthly assessment
      // budget"); else an even pro rata spread of the levy.
      const schedule = is12(s.schedule_months) ? s.schedule_months.map(int)
        : (sum(budget) === levy ? budget.slice() : spread(levy, Array(12).fill(1)));
      if (sum(schedule) !== levy) throw err('recognition_schedule_must_total_levy');
      rem.forEach((i) => { remaining[i] = schedule[i]; });
      basis = s.schedule_months ? 'documented' : 'calculated';
      explanation = `Assessment revenue recognized pro rata from the annual levy of $${(levy / 100).toFixed(2)}${s.schedule_months ? ' on its documented schedule' : ''}.`;
      // Months since cutover (through as-of) whose scheduled recognition was
      // never posted: the levy is still earned, so the forecast carries it as an
      // explicit catch-up in the first remaining month (labelled, never silent).
      if (s.include_unposted_recognition && rem.length) {
        const first = Math.max(int(p.cutover_month) || 1, 1);
        const missing = [];
        for (let m = first; m <= asOf; m++) if (schedule[m - 1] !== 0 && actual[m - 1] === 0) missing.push(m);
        if (missing.length) {
          const catchUp = missing.reduce((t, m) => t + schedule[m - 1], 0);
          remaining[rem[0]] += catchUp;
          explanation += ` Includes $${(catchUp / 100).toFixed(2)} of scheduled recognition for ${missing.map((m) => MONTHS[m - 1]).join(', ')} that has not been posted yet, carried in ${MONTHS[rem[0]]}.`;
        }
      }
      break;
    }
    case 'components': {
      const comps = p.components || [];
      if (!comps.length) throw err('components_method_needs_components');
      comps.forEach((c, n) => {
        if (!COMPONENT_KINDS.includes(c.kind)) throw err(`component_${n + 1}_unknown_kind`);
        if (!is12(c.months)) throw err(`component_${n + 1}_needs_12_months`);
        if (!BASES.includes(c.basis)) throw err(`component_${n + 1}_needs_basis`);
        if (c.months.some((v, i) => i < asOf && int(v) !== 0)) throw err(`component_${n + 1}_has_amounts_in_actual_months`);
        if (c.basis === 'documented' && c.assumption) throw err(`component_${n + 1}_cannot_be_documented_and_assumed`);
        if (c.kind === 'project' && !c.months.some((v) => int(v) !== 0) && !(c.refs && c.refs.posted)) throw err(`component_${n + 1}_project_has_no_forecast_month`);
      });
      remaining = zeros(); comps.forEach((c) => c.months.forEach((v, i) => { remaining[i] += int(v); }));
      const bases = [...new Set(comps.map((c) => c.basis))];
      basis = bases.length === 1 ? bases[0] : 'calculated';
      explanation = 'Sum of components: ' + comps.map((c) => `${c.label || c.kind} (${c.basis}${c.assumption ? ', assumed' : ''})`).join('; ') + '.';
      break;
    }
    default: throw err('unknown_forecast_method');
  }

  const months = actual.map((v, i) => (i < asOf ? v : remaining[i]));
  const ytdActual = sum(actual.slice(0, asOf));
  const remainingTotal = sum(remaining);
  return {
    months, remaining, ytd_actual: ytdActual, remaining_total: remainingTotal,
    annual_forecast: ytdActual + remainingTotal, annual_budget: sum(budget), ytd_budget: sum(budget.slice(0, asOf)),
    method: p.method || 'remaining_budget', basis, confidence: s.confidence || confidence, explanation, errors: [],
  };
}

// Components must explain 100% of the remaining months when used.
function checkComponentsExplainRemaining(remaining, components) {
  const tot = zeros(); (components || []).forEach((c) => c.months.forEach((v, i) => { tot[i] += int(v); }));
  const residual = remaining.map((v, i) => int(v) - tot[i]);
  return { ok: residual.every((v) => v === 0), residual };
}

/**
 * Evidence-backed drivers derivable from structured data (no inference):
 *  - project_moved: a budget component and a forecast component share a
 *    vendor_project_id and their months differ.
 *  - assessment_recognition_not_posted: months since cutover (through as-of)
 *    where the recognition schedule expects revenue but none was posted.
 * Other drivers (contract escalation, unplanned expense, ...) come from
 * entered facts with evidence refs.
 */
function deriveDrivers({ account_type, as_of_month, cutover_month, budget_components = [], forecast_components = [], actual_months, recognition }) {
  const drivers = []; const asOf = int(as_of_month);
  for (const fc of forecast_components.filter((c) => c.kind === 'project' && c.refs && c.refs.vendor_project_id)) {
    const bc = budget_components.find((b) => b.vendor_project_id === fc.refs.vendor_project_id);
    if (!bc) continue;
    const bMonths = bc.monthly_amounts_cents.map(int);
    const fMonths = fc.months.map(int);
    const moved = bMonths.some((v, i) => v !== fMonths[i]);
    if (!moved) continue;
    const bYtd = sum(bMonths.slice(0, asOf)), fYtd = sum(fMonths.slice(0, asOf));
    const bFirst = bMonths.findIndex((v) => v !== 0), fFirst = fMonths.findIndex((v) => v !== 0);
    drivers.push({
      type: 'project_moved', classification: 'known_timing',
      ytd_amount: favorableVariance(account_type, bYtd, fYtd),                 // effect on YTD variance
      full_year_amount: favorableVariance(account_type, sum(bMonths), sum(fMonths)), // non-zero only if cost changed
      budget_month: bFirst >= 0 ? MONTHS[bFirst] : null, forecast_month: fFirst >= 0 ? MONTHS[fFirst] : null,
      expected_reversal_month: fFirst >= 0 ? MONTHS[fFirst] : null,
      evidence: { vendor_project_id: fc.refs.vendor_project_id, budget_component_id: bc.id || null, source: 'live project timing vs frozen budget component' },
    });
  }
  if (recognition && is12(recognition.schedule_months) && is12(actual_months)) {
    const first = Math.max(int(cutover_month) || 1, 1);
    const missing = [];
    for (let m = first; m <= asOf; m++) if (int(recognition.schedule_months[m - 1]) !== 0 && int(actual_months[m - 1]) === 0) missing.push(m);
    if (missing.length) {
      const amt = missing.reduce((t, m) => t + int(recognition.schedule_months[m - 1]), 0);
      drivers.push({
        type: 'assessment_recognition_not_posted', classification: 'known_timing',
        ytd_amount: -amt, full_year_amount: 0,
        missing_months: missing.map((m) => MONTHS[m - 1]), expected_reversal_month: 'when the missing recognition entries are posted',
        evidence: { schedule: recognition.source || 'annual levy recognized pro rata', months_without_recognition: missing.map((m) => MONTHS[m - 1]) },
      });
    }
  }
  return drivers;
}

/**
 * Classify a line's YTD and full-year variance from evidence only.
 * drivers: [{type, classification:'known_timing'|'known_permanent', ytd_amount, full_year_amount, evidence, ...}]
 */
function classifyVariance({ ytd_variance, forecast_variance, drivers = [] }) {
  const bucket = (field) => {
    const known_timing = drivers.filter((d) => d.classification === 'known_timing').reduce((t, d) => t + int(d[field]), 0);
    const known_permanent = drivers.filter((d) => d.classification === 'known_permanent').reduce((t, d) => t + int(d[field]), 0);
    return { known_timing, known_permanent };
  };
  const y = bucket('ytd_amount'), f = bucket('full_year_amount');
  return {
    ytd: { ...y, unexplained: int(ytd_variance) - y.known_timing - y.known_permanent },
    full_year: { known_timing: f.known_timing, known_permanent: f.known_permanent, unexplained: forecast_variance == null ? null : int(forecast_variance) - f.known_timing - f.known_permanent },
  };
}

// Deterministic recommended action (rule table; overridable by a person).
function recommendAction({ classification, drivers = [], forecast_variance, annual_budget, materiality_cents = 50000, board_pct = 0.10 }) {
  if (drivers.some((d) => d.type === 'assessment_recognition_not_posted')) return 'post the missing assessment recognition entries (accounting)';
  if (drivers.some((d) => d.type === 'contract_assumed_unconfirmed')) return 'confirm or update the contract timing assumption';
  if (drivers.some((d) => d.type === 'project_moved')) return 'confirm project timing';
  const unexplained = Math.abs(int(classification.ytd.unexplained)) + Math.abs(int(classification.full_year.unexplained || 0));
  if (forecast_variance != null && forecast_variance < 0 && Math.abs(forecast_variance) > Math.max(materiality_cents, Math.abs(int(annual_budget)) * board_pct)) return 'board decision required (forecast overrun beyond threshold)';
  if (unexplained >= materiality_cents) return 'review invoices / postings';
  if (Math.abs(int(classification.ytd.known_timing)) > 0 && unexplained < materiality_cents) return 'no action; timing only';
  return 'no action';
}

/**
 * Amanda-ready management facts for one line (numbers + evidence; no prose).
 */
function managementFacts({ account, category = null, subcategory = null, account_type, line, drivers = [], manual_action = null, materiality_cents = 50000 }) {
  const ytdVar = favorableVariance(account_type, line.ytd_budget, line.ytd_actual);
  const fcVar = favorableVariance(account_type, line.annual_budget, line.annual_forecast);
  const classification = classifyVariance({ ytd_variance: ytdVar, forecast_variance: fcVar, drivers });
  const material = Math.abs(ytdVar) >= materiality_cents || Math.abs(fcVar) >= materiality_cents;
  return {
    account, category, subcategory, account_type,
    budget_ytd: line.ytd_budget, actual_ytd: line.ytd_actual, ytd_variance: ytdVar,
    annual_budget: line.annual_budget, annual_forecast: line.annual_forecast, forecast_variance: fcVar,
    forecast_method: line.method, forecast_basis: line.basis, forecast_confidence: line.confidence, forecast_explanation: line.explanation,
    classification, drivers, material,
    recommended_action: manual_action || recommendAction({ classification, drivers, forecast_variance: fcVar, annual_budget: line.annual_budget, materiality_cents }),
    recommended_action_source: manual_action ? 'manual' : 'rule',
  };
}

module.exports = { METHODS, COMPONENT_KINDS, BASES, MONTHS, buildForecastLine, checkComponentsExplainRemaining, deriveDrivers, classifyVariance, recommendAction, managementFacts };
