// ============================================================================
// lib/accounting/builder_ownership.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// Builder assessments follow the builder's ACTUAL OWNERSHIP (the declaration:
// a builder pays its percentage "for the period of time that the Builder owns
// a Lot"). The period runs from the builder's recorded acquisition date through
// the day before settlement, split by assessment year, each year at THAT year's
// annual assessment. The architectural application date plays no part here (it
// stays on the builder application).
//
// transfer_proration_plan (migration 500) computes only the settlement year and
// starts the builder on the year's first day unless a trustEd-recorded transfer
// says otherwise. This review compares the plan with the ownership schedule and
// HOLDS the proration (never guesses) when they differ:
//   prior_year_builder_days      the builder owned the lot in an earlier year;
//                                those days must be reconciled against what the
//                                legacy books billed (Kat) before anything posts
//   builder_charged_before_acquisition  the plan or the conversion billed the
//                                builder for days the developer owned the lot;
//                                flagged separately, never charged to the builder
//   builder_acquisition_date_unknown    no recorded acquisition date on the tenure
//   assessment_rate_unknown      no annual rate on file for a year in the period
//   title_already_remitted       a closing packet on file shows the title company
//                                already paid the Association at this closing:
//                                no new charge until the packet is reconciled
// Nothing here writes anything.
// ============================================================================
const DAY = 86400000;
const ymdToUtc = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const utcToYmd = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (s, n) => utcToYmd(ymdToUtc(s) + n * DAY);
const daysBetweenInclusive = (a, b) => Math.round((ymdToUtc(b) - ymdToUtc(a)) / DAY) + 1;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Assessment year bounds for a calendar-style year end 'MM-DD'.
function yearBounds(dateYmd, yearEndMmdd = '12-31') {
  const y = Number(String(dateYmd).slice(0, 4));
  let end = `${y}-${yearEndMmdd}`;
  if (ymdToUtc(dateYmd) > ymdToUtc(end)) end = `${y + 1}-${yearEndMmdd}`;
  const start = addDays(`${Number(end.slice(0, 4)) - 1}-${yearEndMmdd}`, 1);
  return { fiscal_year: Number(end.slice(0, 4)), start, end, days_in_year: daysBetweenInclusive(start, end) };
}

// The ownership schedule. PURE.
//   acquisitionDate: the builder's recorded acquisition (tenure start)
//   settlementDate: the sale to the homeowner (builder owns through the day before)
//   builderPct: e.g. 50
//   rates: { [fiscal_year]: annual_amount_cents }
function ownershipSchedule({ acquisitionDate, settlementDate, builderPct, rates = {}, yearEndMmdd = '12-31' }) {
  const out = { periods: [], total_cents: 0, gaps: [] };
  if (!acquisitionDate) { out.gaps.push('builder_acquisition_date_unknown'); return out; }
  const last = addDays(settlementDate, -1);
  if (ymdToUtc(last) < ymdToUtc(acquisitionDate)) return out;
  let from = acquisitionDate;
  while (ymdToUtc(from) <= ymdToUtc(last)) {
    const yb = yearBounds(from, yearEndMmdd);
    const through = ymdToUtc(yb.end) < ymdToUtc(last) ? yb.end : last;
    const days = daysBetweenInclusive(from, through);
    const annual = rates[yb.fiscal_year];
    const known = annual != null && Number.isFinite(Number(annual));
    const cents = known ? Math.round(Number(annual) * Number(builderPct) * days / (100 * yb.days_in_year)) : null;
    out.periods.push({ fiscal_year: yb.fiscal_year, from, through, days, days_in_year: yb.days_in_year, annual_assessment_cents: known ? Number(annual) : null, builder_rate_pct: Number(builderPct), cents,
      formula: known ? `${(Number(annual) / 100).toFixed(2)} x ${builderPct}% x ${days}/${yb.days_in_year}` : null });
    if (!known) out.gaps.push(`assessment_rate_unknown_${yb.fiscal_year}`);
    else out.total_cents += cents;
    from = addDays(through, 1);
  }
  return out;
}

// Compare the plan (transfer_proration_plan) with the ownership schedule. PURE.
//   packetRemittances: Association checks on closing packets filed for this lot
function reviewPlan({ plan, acquisitionDate, acquisitionBasis, rates, packetRemittances = [] }) {
  const holds = []; const warnings = []; const flags = [];
  if (!plan || !plan.applies) return { applies: false, holds, warnings, flags };
  const sched = ownershipSchedule({ acquisitionDate, settlementDate: plan.settlement_date, builderPct: plan.builder_rate_pct, rates });
  for (const g of sched.gaps) holds.push(g.startsWith('assessment_rate_unknown') ? 'assessment_rate_unknown' : g);
  if (acquisitionDate && acquisitionBasis && acquisitionBasis !== 'transfer') {
    warnings.push(`builder acquisition date ${acquisitionDate} comes from ${acquisitionBasis === 'county_deed' ? 'the county appraisal roll (deed date)' : acquisitionBasis}; confirm it against the recorded deed`);
  }
  const prior = sched.periods.filter((p) => p.fiscal_year < Number(plan.fiscal_year));
  if (prior.length) holds.push('prior_year_builder_days');
  // Developer days billed to the builder in the settlement year (plan starts earlier than ownership).
  if (acquisitionDate && plan.builder_period_start && ymdToUtc(acquisitionDate) > ymdToUtc(plan.builder_period_start)) {
    const devThrough = addDays(acquisitionDate, -1);
    const lastPlanDay = plan.builder_period_end;
    const end = ymdToUtc(devThrough) < ymdToUtc(lastPlanDay) ? devThrough : lastPlanDay;
    const days = daysBetweenInclusive(plan.builder_period_start, end);
    const annual = Number(plan.annual_assessment_cents);
    flags.push({ kind: 'developer_period_billed_to_builder', from: plan.builder_period_start, through: end, days,
      cents: Math.round(annual * Number(plan.builder_rate_pct) * days / (100 * Number(plan.days_in_year))),
      note: 'days before the builder owned the lot; never charged to the builder; the developer-period liability is reviewed separately' });
    holds.push('builder_charged_before_acquisition');
  }
  // Developer period before the builder acquired the lot, in the acquisition year (informational).
  if (acquisitionDate) {
    const yb = yearBounds(acquisitionDate);
    if (ymdToUtc(acquisitionDate) > ymdToUtc(yb.start)) flags.push({ kind: 'developer_period', from: yb.start, through: addDays(acquisitionDate, -1), days: daysBetweenInclusive(yb.start, addDays(acquisitionDate, -1)),
      note: 'owned by the developer (declarant); its assessment liability is not the builder\'s and is reviewed separately' });
  }
  const remitted = packetRemittances.filter((r) => Number(r.amount_cents) > 0);
  if (remitted.length) holds.push('title_already_remitted');
  const unique = [...new Set(holds)];
  return { applies: true, schedule: sched, settlement_year_cents: (sched.periods.find((p) => p.fiscal_year === Number(plan.fiscal_year)) || {}).cents ?? null,
    prior_year_cents: prior.reduce((a, p) => a + (p.cents || 0), 0), prior_years: prior,
    holds: unique, warnings, flags, packet_remittances: remitted };
}

const HOLD_TEXT = {
  prior_year_builder_days: 'the builder owned the lot in an earlier assessment year; those days must be reconciled with what the legacy books billed before anything posts',
  builder_charged_before_acquisition: 'the calculation bills the builder for days before it acquired the lot (developer period); those days are flagged separately, never charged to the builder',
  builder_acquisition_date_unknown: "the builder's recorded acquisition date is not on file",
  assessment_rate_unknown: 'the annual assessment for a year in the builder period is not on file',
  title_already_remitted: 'a closing packet on file shows the title company already paid the Association at this closing; reconcile the packet before any new charge',
};

// Loaders. Each throws on a real read error (a broken query is never "nothing").
async function loadRates(supabase, communityId, currentAnnualCents, currentYear) {
  const rates = {};
  if (currentAnnualCents != null && currentYear) rates[currentYear] = Number(currentAnnualCents);
  const { data, error } = await supabase.from('community_assessment_rate_history').select('fiscal_year, annual_amount_cents').eq('community_id', communityId).eq('owner_class', 'homeowner');
  if (error) {
    if (/community_assessment_rate_history/.test(error.message || '')) return rates;   // table missing (465 not applied)
    throw new Error(error.message);
  }
  for (const r of data || []) rates[Number(r.fiscal_year)] = Number(r.annual_amount_cents);
  return rates;
}
async function loadPacketRemittances(supabase, communityId, propertyId) {
  const { data, error } = await supabase.from('library_documents').select('id, extraction_notes').eq('community_id', communityId).eq('category', 'scanned_mail')
    .like('extraction_notes', '%"kind":"closing_packet"%').like('extraction_notes', `%"property_id":"${propertyId}"%`).limit(20);
  if (error) throw new Error(error.message);
  const out = [];
  for (const d of data || []) {
    let n = {}; try { n = JSON.parse(d.extraction_notes || '{}'); } catch (_) { n = {}; }
    for (const c of n.checks || []) if (c.classification === 'ASSOCIATION_PAYMENT' || /association|hoa/i.test(String(c.payee || '')) && !/bedrock/i.test(String(c.payee || ''))) {
      out.push({ document_id: d.id, closing_date: n.closing_date || null, check_number: c.check_number, amount_cents: c.amount_cents, payee: c.payee, memo: c.memo });
    }
  }
  return out;
}

// Full review against the database for one plan.
async function reviewForPlan(supabase, { plan, sellerTenureId }) {
  if (!plan || !plan.applies) return { applies: false, holds: [], warnings: [], flags: [] };
  const { data: t, error } = await supabase.from('ownership_tenures').select('start_date, start_date_basis, origin, community_id, property_id').eq('id', sellerTenureId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!t) throw new Error('seller tenure not found');
  const basis = t.origin === 'transfer' ? 'transfer' : t.start_date_basis;
  const usable = t.start_date && ['county_deed', 'transfer', 'deed', 'closing'].includes(basis);
  const rates = await loadRates(supabase, t.community_id, plan.annual_assessment_cents, plan.fiscal_year);
  const remits = await loadPacketRemittances(supabase, t.community_id, t.property_id);
  const r = reviewPlan({ plan, acquisitionDate: usable ? t.start_date : null, acquisitionBasis: basis, rates, packetRemittances: remits });
  return { ...r, acquisition_date: usable ? t.start_date : null, acquisition_basis: basis || null, hold_text: r.holds.map((h) => HOLD_TEXT[h] || h) };
}

module.exports = { ownershipSchedule, reviewPlan, reviewForPlan, loadRates, loadPacketRemittances, yearBounds, HOLD_TEXT };
