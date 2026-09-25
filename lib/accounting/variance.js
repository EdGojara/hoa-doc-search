// ============================================================================
// lib/accounting/variance.js — the one business variance convention.
// ----------------------------------------------------------------------------
// Ed 2026-09-25 (Forecast Phase 3B): favorable = positive, unfavorable =
// negative, for every statement and for Amanda.
//   expense:  budget - (actual | forecast)
//   revenue:  (actual | forecast) - budget
// Raw budget / actual / forecast values are always kept alongside; this only
// derives the signed business variance. Existing statements are not yet
// rewritten to use it (the screen vs printed-statement mismatch stays deferred
// until the Forecast screens adopt this function).
// ============================================================================

const isRevenue = (accountType) => String(accountType || '').toLowerCase() === 'revenue';

// Favorable-positive variance of one comparison, in cents.
function favorableVariance(accountType, budgetCents, comparedCents) {
  const b = Math.round(Number(budgetCents) || 0);
  const c = Math.round(Number(comparedCents) || 0);
  return isRevenue(accountType) ? c - b : b - c;
}

const describe = (v) => (v > 0 ? 'favorable' : v < 0 ? 'unfavorable' : 'on budget');

// The standard set for one line: MTD, YTD, full-year forecast.
function varianceSet({ account_type, mtd_budget = 0, mtd_actual = 0, ytd_budget = 0, ytd_actual = 0, annual_budget = 0, annual_forecast = null }) {
  const out = {
    mtd: favorableVariance(account_type, mtd_budget, mtd_actual),
    ytd: favorableVariance(account_type, ytd_budget, ytd_actual),
    forecast: annual_forecast == null ? null : favorableVariance(account_type, annual_budget, annual_forecast),
  };
  out.labels = { mtd: describe(out.mtd), ytd: describe(out.ytd), forecast: out.forecast == null ? null : describe(out.forecast) };
  return out;
}

module.exports = { favorableVariance, varianceSet, describe, isRevenue };
