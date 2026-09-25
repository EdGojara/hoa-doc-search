// ============================================================================
// lib/accounting/budget_phasing.js — how a budget line's 12 months are planned.
// ----------------------------------------------------------------------------
// Budget Phase 2 (Ed 2026-09-25). One code path for every phasing method, the
// annual-change choices, component completeness, and schedule provenance. Pure
// (no database), so the API, the rehearsal and the tests all use the same math.
//
// PROVENANCE (schedule_basis) — what a monthly schedule can honestly claim:
//   documented  the months come from a source document's own schedule
//               (e.g. a contract's extracted monthly/payment schedule)
//   calculated  derived by rule from amounts/dates/patterns (even spread,
//               weights, a prior-year shape, or a contract's annual amount
//               spread across its active months). A contract-derived spread is
//               an ASSUMPTION until a person confirms it: settings.assumption
//               = true, and confirmation is recorded, never upgraded to
//               "documented".
//   manual      typed in by a person
// Amanda must be able to say why an amount sits in a month without overstating
// what the source says; this field is that answer.
// ============================================================================

const { evenSplit, isEvenSchedule, scaleSchedule } = require('./budget_merge');

const METHODS = ['even', 'manual', 'prior_budget', 'prior_actual', 'contract', 'project', 'weighted'];
const BASES = ['documented', 'calculated', 'manual'];
const KINDS = ['recurring', 'project', 'contract', 'other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toInt = (n) => Math.round(Number(n) || 0);
const sum = (m) => m.reduce((s, v) => s + toInt(v), 0);
const isMonths = (m) => Array.isArray(m) && m.length === 12 && m.every((v) => Number.isFinite(Number(v)));

// Distribute an amount by weights (largest-remainder rounding; sums exactly).
function byWeights(amount, weights) {
  const w = (weights || []).map((x) => (Number(x) > 0 ? Number(x) : 0));
  if (w.length !== 12 || !w.some((x) => x > 0)) throw new Error('weights_need_12_values_with_at_least_one_positive');
  return scaleSchedule(w, w.reduce((s, x) => s + x, 0), toInt(amount));
}

// Put an amount in chosen month(s) (0-11), split evenly across them, exact.
function placeInMonths(amount, monthIdx) {
  const idx = [...new Set((monthIdx || []).map(Number))].filter((i) => i >= 0 && i <= 11).sort((a, b) => a - b);
  if (!idx.length) throw new Error('choose_at_least_one_month');
  const w = Array(12).fill(0); idx.forEach((i) => { w[i] = 1; });
  return byWeights(amount, w);
}

// Month indexes (0-11) of fiscal year fy covered by [start, end] (dates or null).
function activeMonths(fy, start, end) {
  const out = [];
  for (let m = 0; m < 12; m++) {
    const first = `${fy}-${String(m + 1).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(fy, m + 1, 0)).toISOString().slice(0, 10);
    if ((start && last < start) || (end && first > end)) continue;
    out.push(m);
  }
  return out;
}

/**
 * Propose a contract-based schedule for fiscal year fy.
 * contract: { annual_cents, effective_date, end_date, escalator_pct, documented_schedule:[{month:1-12, amount_cents}] | null, source_label }
 * A documented schedule is used as-is (basis documented). Otherwise the annual
 * amount is spread across the contract's active months, with the escalator
 * applied from the anniversary month: basis calculated, assumption true.
 */
function contractSchedule(contract, fy) {
  const c = contract || {};
  const doc = Array.isArray(c.documented_schedule) ? c.documented_schedule : null;
  if (doc && doc.length) {
    const m = Array(12).fill(0);
    for (const r of doc) {
      const i = Number(r.month) - 1;
      if (!(i >= 0 && i <= 11)) throw new Error('documented_schedule_month_out_of_range');
      m[i] += toInt(r.amount_cents);
    }
    return { monthly: m, basis: 'documented', assumption: false,
      explanation: `Monthly amounts taken from the ${c.source_label || 'contract'}'s own schedule.` };
  }
  const annual = toInt(c.annual_cents);
  if (!annual) throw new Error('contract_has_no_annual_amount');
  const months = activeMonths(fy, c.effective_date || null, c.end_date || null);
  if (!months.length) throw new Error('contract_not_active_in_fiscal_year');
  const monthlyRate = annual / 12;
  const w = Array(12).fill(0);
  let escMonth = null;
  const pct = Number(c.escalator_pct) || 0;
  if (pct && c.effective_date) {
    const eff = new Date(c.effective_date + 'T00:00:00Z');
    if (eff.getUTCFullYear() < fy) escMonth = eff.getUTCMonth();       // anniversary inside fy
  }
  for (const i of months) w[i] = monthlyRate * (escMonth !== null && i >= escMonth ? (1 + pct / 100) : 1);
  const total = Math.round(w.reduce((s, x) => s + x, 0));
  const monthly = scaleSchedule(w, w.reduce((s, x) => s + x, 0), total);
  const parts = [`${c.source_label || 'Contract'} annual amount $${(annual / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} spread evenly across the ${months.length} month${months.length === 1 ? '' : 's'} it is active in ${fy} (${MONTHS[months[0]]}–${MONTHS[months[months.length - 1]]})`];
  if (escMonth !== null) parts.push(`${pct}% escalator applied from ${MONTHS[escMonth]}`);
  return { monthly, basis: 'calculated', assumption: true, explanation: parts.join('; ') + '. The contract data has no payment schedule, so this monthly timing is an assumption to confirm.' };
}

/**
 * Compute a line's months for a phasing method.
 * opts: { annual_cents, method, settings, fy, prior_budget_months, prior_actual_months, contract, current_months }
 * Returns { monthly, basis, settings, explanation }.
 */
function phase(opts) {
  const o = opts || {}; const annual = toInt(o.annual_cents); const s = o.settings || {};
  switch (o.method) {
    case 'even':
      return { monthly: evenSplit(annual), basis: 'calculated', settings: {}, explanation: 'Spread evenly across 12 months (chosen explicitly).' };
    case 'manual': {
      if (!isMonths(o.current_months)) throw new Error('manual_needs_12_months');
      const m = o.current_months.map(toInt);
      return { monthly: m, basis: 'manual', settings: {}, explanation: 'Months entered by hand.' };
    }
    case 'weighted': {
      const w = s.weights_pct;
      if (!Array.isArray(w) || w.length !== 12) throw new Error('weights_pct_needs_12_values');
      const t = w.reduce((a, x) => a + (Number(x) || 0), 0);
      if (Math.abs(t - 100) > 0.001) throw new Error('weights_pct_must_total_100');
      return { monthly: byWeights(annual, w), basis: 'calculated', settings: { weights_pct: w.map(Number) }, explanation: 'Distributed by the percentage weight set for each month.' };
    }
    case 'prior_budget':
    case 'prior_actual': {
      const src = o.method === 'prior_budget' ? o.prior_budget_months : o.prior_actual_months;
      if (!isMonths(src) || !src.some((v) => Number(v) > 0)) throw new Error(o.method + '_has_no_usable_months');
      const shape = src.map((v) => (Number(v) > 0 ? Number(v) : 0));
      return { monthly: byWeights(annual, shape), basis: 'calculated',
        settings: { source_year: s.source_year || null },
        explanation: `Shaped like the ${s.source_year ? s.source_year + ' ' : 'prior-year '}${o.method === 'prior_budget' ? 'approved budget' : 'actual spending'}, scaled to this annual amount.` };
    }
    case 'contract': {
      const r = contractSchedule(o.contract, o.fy);
      return { monthly: r.monthly, basis: r.basis, settings: { ...s, assumption: r.assumption, confirmed_by: null, confirmed_at: null }, explanation: r.explanation };
    }
    case 'project':
      throw new Error('project_phasing_is_set_by_components');
    default:
      throw new Error('unknown_phasing_method');
  }
}

/**
 * The annual amount of a line with a non-even schedule changed: nothing is
 * redistributed silently. choice: scale | even | allocate_difference | keep_months
 */
function applyAnnualChange(currentMonths, newAnnual, choice, opts = {}) {
  const cur = (currentMonths || []).map(toInt); const target = toInt(newAnnual);
  if (!isMonths(cur)) throw new Error('current_months_invalid');
  switch (choice) {
    case 'scale': return { monthly: scaleSchedule(cur, sum(cur), target), explanation: 'Existing monthly pattern scaled to the new annual amount.' };
    case 'even': return { monthly: evenSplit(target), explanation: 'Spread evenly across 12 months (chosen explicitly).' };
    case 'allocate_difference': {
      const diff = target - sum(cur);
      const add = placeInMonths(diff, opts.months);
      return { monthly: cur.map((v, i) => v + add[i]), explanation: `Difference of $${(diff / 100).toFixed(2)} added to ${opts.months.map((i) => MONTHS[i]).join(', ')}.` };
    }
    case 'keep_months': return { monthly: cur, explanation: 'Months left as they were; the annual stays their total until they are edited.' };
    default: throw new Error('choose_scale_even_allocate_or_keep');
  }
}

// Does changing a line's annual need a decision? (only when its schedule is intentional)
const needsAnnualDecision = (currentMonths, oldAnnual) => isMonths(currentMonths) && !isEvenSchedule(currentMonths, oldAnnual);

/**
 * Components must explain 100% of the line, month by month.
 * Returns { ok, residual:[12], problems:[] }.
 */
function checkComponents(lineMonths, components) {
  const line = (lineMonths || []).map(toInt);
  const problems = [];
  if (!components || !components.length) return { ok: true, residual: Array(12).fill(0), problems };
  const tot = Array(12).fill(0);
  components.forEach((c, n) => {
    if (!isMonths(c.monthly_amounts_cents)) { problems.push(`component ${n + 1} needs 12 monthly values`); return; }
    if (!KINDS.includes(c.kind)) problems.push(`component ${n + 1} has an unknown kind`);
    if (!String(c.name || '').trim()) problems.push(`component ${n + 1} needs a name`);
    if (c.kind === 'project' && !c.monthly_amounts_cents.some((v) => toInt(v) !== 0)) problems.push(`"${c.name}" is a project with no planned month`);
    c.monthly_amounts_cents.forEach((v, i) => { tot[i] += toInt(v); });
  });
  const residual = line.map((v, i) => v - tot[i]);
  if (residual.some((v) => v !== 0)) problems.push('components do not explain the whole line: ' + residual.map((v, i) => (v ? `${MONTHS[i]} ${(v / 100).toFixed(2)}` : null)).filter(Boolean).join(', ') + ' unexplained');
  return { ok: problems.length === 0, residual, problems };
}

// The remainder not covered by specific components, as a recurring/base component.
function baseComponentFor(lineMonths, components, name = 'Recurring / base') {
  const { residual } = checkComponents(lineMonths, (components || []).filter((c) => isMonths(c.monthly_amounts_cents)));
  if (residual.every((v) => v === 0)) return null;
  if (residual.some((v) => v < 0)) throw new Error('components_exceed_the_line_in_some_month');
  return { name, kind: 'recurring', monthly_amounts_cents: residual, annual_amount_cents: sum(residual), schedule_basis: 'calculated', schedule_settings: { derived: 'remainder_of_line' } };
}

// A line whose components exist: its months are the components' sum.
const lineMonthsFromComponents = (components) => components.reduce((acc, c) => acc.map((v, i) => v + toInt(c.monthly_amounts_cents[i])), Array(12).fill(0));

module.exports = { METHODS, BASES, KINDS, MONTHS, byWeights, placeInMonths, activeMonths, contractSchedule, phase, applyAnnualChange, needsAnnualDecision, checkComponents, baseComponentFor, lineMonthsFromComponents, sum };
