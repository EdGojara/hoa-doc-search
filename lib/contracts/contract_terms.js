// ============================================================================
// lib/contracts/contract_terms.js  (Ed 2026-10-10, Financial Intelligence slice 1)
// ----------------------------------------------------------------------------
// PURE: what a contract costs in a given year, from STRUCTURED terms only.
// No AI, no inference from text. Every month's amount is traceable to a term.
//
// Terms used (vendor_contracts, extended by migration 506):
//   effective_date, end_date, auto_renews
//   periodic_amount + periodic_frequency (monthly | quarterly | semiannual | annual)
//   rate_schedule  [{ effective_date, periodic_amount, periodic_frequency?, note? }]  dated rate changes
//   escalator_kind / escalator_pct  ('fixed_pct' applied on each anniversary when no
//                                    dated rate covers it; CPI-based = unknown, never guessed)
//   one_time_fees  [{ date, amount, description }]
//   unit_pricing   (variable / per-unit terms: reported, not forecast without quantities)
//
// A month is costed only when a term covers it. Months after the end date are
// covered only by an explicit auto-renewal (flagged); otherwise they are
// UNCOVERED (the caller decides; never treated as zero cost).
// ============================================================================

const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toCents = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const fmt = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ym = (d) => String(d).slice(0, 7);
const monthStart = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;

// Monthly-equivalent rate (cents) for a periodic amount. Exact to the cent over the period.
function monthlyRate(amountCents, freq) {
  const n = FREQ_MONTHS[freq];
  if (!n || amountCents === null) return null;
  return amountCents / n;   // fractional; the year's months are rounded together below
}

/**
 * @param c contract { vendor_name, effective_date, end_date, auto_renews, periodic_amount, periodic_frequency,
 *                     rate_schedule, escalator_kind, escalator_pct, one_time_fees, unit_pricing }
 * @param year target year (e.g. 2027)
 * @returns { months[12] (cents|null for uncovered), annual_cents, covered_months, uncovered_months, renewal_assumed_months,
 *            rate_at_start_of_year, rate_at_end_of_prior_year, steps[], issues[], one_time_cents }
 */
function contractCostForYear(c, year) {
  const steps = []; const issues = [];
  const eff = c.effective_date ? String(c.effective_date).slice(0, 10) : null;
  const end = c.end_date ? String(c.end_date).slice(0, 10) : null;
  if (!eff) issues.push({ code: 'no_effective_date', text: 'The contract has no effective date.' });
  const baseRate = c.periodic_frequency && c.periodic_amount != null ? { from: eff, cents: toCents(c.periodic_amount), freq: c.periodic_frequency, source: 'base rate' } : null;
  if (!baseRate) issues.push({ code: 'no_periodic_amount', text: 'No fixed periodic amount and frequency; the contract cannot be costed deterministically.' });
  if (baseRate && !FREQ_MONTHS[baseRate.freq]) issues.push({ code: 'frequency_unsupported', text: `Frequency "${baseRate.freq}" cannot be converted to a monthly cost.` });
  const sched = [...(c.rate_schedule || [])].filter((r) => r && r.effective_date && r.periodic_amount != null)
    .map((r) => ({ from: String(r.effective_date).slice(0, 10), cents: toCents(r.periodic_amount), freq: r.periodic_frequency || (baseRate && baseRate.freq), source: r.note ? `rate change: ${r.note}` : 'dated rate change' }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const cpi = ['cpi_only', 'max_cpi_or_pct'].includes(c.escalator_kind);
  const fixedPct = c.escalator_kind === 'fixed_pct' && c.escalator_pct != null ? Number(c.escalator_pct) : null;

  // Rate in force on a date: latest dated rate (or the base rate) on/before it, escalated on
  // anniversaries of the base effective date for 'fixed_pct' when no dated rate is newer.
  function rateOn(date) {
    if (!baseRate || !eff || date < eff) return null;
    let r = { ...baseRate };
    for (const s of sched) if (s.from <= date) r = { ...s };
    if (fixedPct !== null) {
      const anchor = r.from || eff;
      const yearsSince = Math.floor((Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - (Number(anchor.slice(0, 4)) * 12 + Number(anchor.slice(5, 7)))) / 12);
      if (yearsSince > 0) { r = { ...r, cents: Math.round(r.cents * Math.pow(1 + fixedPct / 100, yearsSince)), source: `${r.source} + ${fixedPct}% escalator x${yearsSince}` }; }
    }
    return r;
  }

  const raw = []; const months = Array(12).fill(null);
  let covered = 0, renewal = 0; const uncovered = [];
  for (let m = 1; m <= 12; m++) {
    const d = monthStart(year, m);
    const inTerm = eff && d >= ym(eff) + '-01' && (!end || d <= end);
    const renewed = eff && end && d > end && c.auto_renews === true;
    if (!inTerm && !renewed) { uncovered.push(MONTHS[m - 1]); raw.push(null); continue; }
    const r = rateOn(d);
    if (!r || !FREQ_MONTHS[r.freq]) { uncovered.push(MONTHS[m - 1]); raw.push(null); continue; }
    if (renewed) renewal++;
    covered++;
    raw.push({ m, rate: monthlyRate(r.cents, r.freq), r });
  }
  // Round the covered months together so the year is exact to the cent.
  const exact = raw.filter(Boolean).reduce((t, x) => t + x.rate, 0);
  let acc = 0, runningExact = 0;
  for (const x of raw.filter(Boolean)) { runningExact += x.rate; const target = Math.round(runningExact); months[x.m - 1] = target - acc; acc = target; }
  const annual = Math.round(exact);
  const oneTime = (c.one_time_fees || []).filter((f) => f && f.date && String(f.date).slice(0, 4) === String(year) && f.amount != null);
  const oneTimeCents = oneTime.reduce((t, f) => t + toCents(f.amount), 0);
  for (const f of oneTime) { const mi = Number(String(f.date).slice(5, 7)) - 1; months[mi] = (months[mi] || 0) + toCents(f.amount); }

  // Steps: one per distinct rate segment.
  const segs = [];
  for (const x of raw.filter(Boolean)) { const last = segs[segs.length - 1]; if (last && last.cents === x.r.cents && last.freq === x.r.freq) last.to = x.m; else segs.push({ from: x.m, to: x.m, cents: x.r.cents, freq: x.r.freq, source: x.r.source }); }
  for (const s of segs) {
    const n = s.to - s.from + 1;
    steps.push(`${MONTHS[s.from - 1]}${n > 1 ? '-' + MONTHS[s.to - 1] : ''}: ${fmt(s.cents)} ${s.freq} = ${fmt(Math.round(s.cents / FREQ_MONTHS[s.freq]))}/month x ${n} month${n === 1 ? '' : 's'} = ${fmt(Math.round((s.cents / FREQ_MONTHS[s.freq]) * n))} (${s.source})`);
  }
  if (oneTime.length) steps.push(`One-time fees in ${year}: ${oneTime.map((f) => `${f.description || 'fee'} ${fmt(toCents(f.amount))} (${f.date})`).join('; ')}`);
  if (renewal) issues.push({ code: 'renewal_assumed', text: `${renewal} month(s) fall after the ${end} end date and are costed only because the contract auto-renews; confirm the renewal.` });
  if (uncovered.length) issues.push({ code: 'uncovered_months', text: `${uncovered.join(', ')} ${year} ${uncovered.length === 1 ? 'is' : 'are'} not covered by the contract term.` });
  if (cpi) issues.push({ code: 'cpi_escalator', text: 'The escalator is CPI-based; the CPI change is not known, so no escalation is applied (needs a rate).' });
  if (c.unit_pricing && Object.keys(c.unit_pricing).length) issues.push({ code: 'unit_pricing', text: 'The contract also has unit / variable pricing; it is not forecast without quantities.' });
  const priorEnd = rateOn(`${year - 1}-12-01`); const start = rateOn(`${year}-01-01`);
  return {
    months, annual_cents: annual + oneTimeCents, recurring_cents: annual, one_time_cents: oneTimeCents,
    covered_months: covered, uncovered_months: uncovered, renewal_assumed_months: renewal,
    rate_at_end_of_prior_year: priorEnd ? { cents: priorEnd.cents, freq: priorEnd.freq, source: priorEnd.source } : null,
    rate_at_start_of_year: start ? { cents: start.cents, freq: start.freq, source: start.source } : null,
    steps, issues,
  };
}

module.exports = { contractCostForYear, FREQ_MONTHS };
