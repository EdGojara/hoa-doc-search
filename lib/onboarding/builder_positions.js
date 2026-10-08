// ============================================================================
// lib/onboarding/builder_positions.js  (GitHub #96, Ed 2026-10-08) — PURE
// ----------------------------------------------------------------------------
// Builder assessment positions at a conversion baseline, and the community's
// deferred-assessment release schedule, for a community with a builder rule
// (transfer_proration_builders) and assessment rates (community_assessment_rates).
// Called by conversion_plan.js; nothing here reads or writes the database.
//
// For each lot whose current owner tenure is a configured builder (Still Creek:
// Lennar), the builder's assessment year runs from Jan 1 (or the date a recorded
// transfer gave it the lot; never the onboarding load date) through the
// conversion as-of date at the builder rate:
//   base = round(annual x pct x days / (100 x days_in_year))
// and what the legacy books billed it for that period decides the accounting:
//   nothing billed        BASELINE: a charge of base (Dr 1300 / Cr income); no
//                         historical charge is fabricated.
//   ONE identified annual NORMALIZATION (5302 Sleepy Fox, $495.00 on 1/1/2026):
//   charge (Jan 1, the    the legacy charge brought to the builder rate. In a
//   annual assessment,    deferring community the legacy charge was recognized
//   full homeowner or     one month at a time (released on the 1st), so:
//   builder rate)           recognized = round(billed x months released / 12)
//                           Dr income  (recognized - base)
//                           Dr 2205    (billed - recognized: the lot's deferral)
//                           Cr 1300    (billed - base)
//   anything else         UNRESOLVED (5450 Still Meadow, $90.18 on 5/13): no
//                         coverage, no entry; a reconciling item a person resolves.
// Every resolved lot gets a builder_assessment_coverage row (source conversion)
// through the as-of date; the ledger rows ride in their own cutover-dated batch
// and the entry in the cutover-dated re-posts (the cutoff trial balance must
// equal the source exactly).
//
// THE 2205 RELEASE SCHEDULE: the year's annual billing (lots billed the full
// annual assessment on Jan 1) released 1/12 a month from Jan 1; what remains
// after the as-of month, minus the normalized lots' deferral, is released
// straight-line over the remaining months (Still Creek 6/30/2026: $79,447.50 -
// $247.50 = $79,200.00, Jul-Dec, $13,200.00/month). Whatever else sits in 2205
// at the cutoff (Still Creek: $2.00 left from 2025) is NOT folded into it: it is
// a reconciling item for later resolution.
// ============================================================================

const d10 = (v) => (v ? String(v).slice(0, 10) : null);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The same whole-word test as SQL transfer_proration_name_has (migration 500).
const nameHas = (name, word) => { const w = words(word); return w !== '' && ` ${words(name)} `.includes(` ${w} `); };
const isAssessment = (r) => r.charge_category === 'assessment' || (r.charge_category == null && /assessment/i.test(r.description || ''));
const money = (c) => (Number(c) / 100).toFixed(2);
// Exact integer proration, rounded half away from zero: the same number as the coverage table's
// CHECK round(annual x pct x days / (100 x days_in_year)) on numeric (no float drift at a half cent).
const divRound = (num, den) => (num >= 0 ? Math.floor((2 * num + den) / (2 * den)) : -Math.floor((-2 * num + den) / (2 * den)));
const prorate = (annual, pct, days, diy) => divRound(annual * Math.round(pct * 100) * days, 10000 * diy);

function daysBetween(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }

/**
 * @param p.cutoff      'YYYY-MM-DD' conversion as-of date
 * @param p.cutover     'YYYY-MM-DD'
 * @param p.code        batch code
 * @param p.builder     { rates: { homeowner, builder }, builders: [{id, company_name}], owners: [{tenure_id, full_name}],
 *                        legacy_rows: [{ id, property_id, tenure_id, vantaca_account_id, transaction_date, description, txn_type, charge_category, amount_cents }] }
 * @param p.properties  [{ id, vantaca_account_id, trusted_account_number, street_address }]
 * @param p.tenures     [{ id, property_id, kind, start_date, end_date, origin }]
 * @param p.resolveAcct (number) => account | null
 * @param p.tbOf        (number) => source TB cents at the cutoff (debit +)
 */
function buildBuilderPositions({ cutoff, cutover, code, builder, properties = [], tenures = [], resolveAcct, tbOf }) {
  const out = { applies: false, rows: [], unresolved: [], je: null, schedule: null, reconciling_items: [], controls: [], notes: [] };
  if (!builder || !(builder.builders || []).length) return out;
  out.applies = true;
  const ho = builder.rates && builder.rates.homeowner; const bl = builder.rates && builder.rates.builder;
  if (!ho || !bl) { out.controls.push({ code: 'preflight.builder_rates_configured', label: 'The community has a homeowner and a builder assessment rate', failures: [{ problem: 'rates missing' }], blocked: true }); return out; }
  const y = Number(cutoff.slice(0, 4)); const jan1 = `${y}-01-01`; const dec31 = `${y}-12-31`;
  const diy = daysBetween(jan1, dec31) + 1;
  const annual = Number(ho.annual_amount_cents);
  const pct = bl.pct_of_homeowner_rate != null ? Number(bl.pct_of_homeowner_rate) : Math.round(Number(bl.annual_amount_cents) * 10000 / annual) / 100;
  const builderFull = bl.pct_of_homeowner_rate != null ? prorate(annual, pct, 1, 1) : Number(bl.annual_amount_cents);
  const incomeNo = ho.income_account_number || '4000'; const deferNo = ho.deferral_account_number || null; const arNo = '1300';
  const monthsReleased = Number(cutoff.slice(5, 7));   // released on the 1st: Jan..as-of month
  const income = resolveAcct(incomeNo); const ar = resolveAcct(arNo); const defer = deferNo ? resolveAcct(deferNo) : null;
  const acctProblems = [];
  if (!income) acctProblems.push({ account: incomeNo, problem: 'income account not found' });
  if (!ar) acctProblems.push({ account: arNo, problem: 'AR account not found' });
  if (deferNo && !defer) acctProblems.push({ account: deferNo, problem: 'deferral account not found' });

  const openTenure = new Map();
  for (const t of tenures) if ((t.kind || 'owner') === 'owner' && !t.end_date) { if (openTenure.has(t.property_id)) openTenure.set(t.property_id, 'MANY'); else openTenure.set(t.property_id, t); }
  const ownersOf = new Map(); for (const o of builder.owners || []) { if (!ownersOf.has(o.tenure_id)) ownersOf.set(o.tenure_id, []); ownersOf.get(o.tenure_id).push(o.full_name); }
  const lines = []; let ln = 0; const addLine = (acct, cents, property_id, memo) => { if (!cents) return; lines.push({ line_number: ++ln, account_number: acct.account_number, account_id: acct.id, fund_id: acct.fund_id || null, debit_cents: cents > 0 ? cents : 0, credit_cents: cents < 0 ? -cents : 0, property_id: property_id || null, vendor_id: null, memo }); };
  let normalizedDeferral = 0;

  for (const p of [...properties].sort((a, b) => String(a.street_address || '').localeCompare(String(b.street_address || '')))) {
    const t = openTenure.get(p.id); if (!t || t === 'MANY') continue;
    const names = ownersOf.get(t.id) || [];
    const hits = names.map((n) => (builder.builders || []).filter((b) => nameHas(n, b.company_name)).map((b) => b.id));
    if (!hits.some((h) => h.length)) continue;                                    // not a builder lot
    const lot = { property_id: p.id, street_address: p.street_address, tenure_id: t.id, account_number: p.trusted_account_number || null, vantaca_account_id: p.vantaca_account_id || null, owners: names };
    const ids = [...new Set(hits.flat())];
    if (hits.some((h) => !h.length) || ids.length !== 1) { out.unresolved.push({ ...lot, reason: hits.some((h) => !h.length) ? 'the owner record mixes the builder with other owners' : 'more than one builder', rows: [] }); continue; }
    const bStart = t.origin === 'transfer' && d10(t.start_date) > jan1 ? d10(t.start_date) : jan1;
    if (bStart > cutoff) continue;                                                 // the builder's year starts after the baseline: the accrual covers it
    const days = daysBetween(bStart, cutoff) + 1;
    const base = prorate(annual, pct, days, diy);
    const legacy = (builder.legacy_rows || []).filter((r) => (r.tenure_id === t.id || (!r.tenure_id && r.vantaca_account_id && r.vantaca_account_id === p.vantaca_account_id))
      && d10(r.transaction_date) >= jan1 && d10(r.transaction_date) <= cutoff && isAssessment(r));
    const identified = legacy.length === 1 && d10(legacy[0].transaction_date) === jan1 && legacy[0].txn_type === 'charge'
      && (legacy[0].charge_category === 'assessment' || /annual.*assessment/i.test(legacy[0].description || '')) && !/special/i.test(legacy[0].description || '')
      && [annual, builderFull].includes(Number(legacy[0].amount_cents));
    const common = { ...lot, builder_company_id: ids[0], fiscal_year: y, covered_from: bStart, covered_through: cutoff, days, days_in_year: diy,
      annual_assessment_cents: annual, builder_rate_pct: pct, base_amount_cents: base,
      rate_source: { rates: 'community_assessment_rates', homeowner_rate_id: ho.id || null, builder_rate_id: bl.id || null, annual_cents: annual, builder_rate_pct: pct } };
    if (!legacy.length) {
      out.rows.push({ ...common, kind: 'baseline', annual_billed_cents: null, ledger_amount_cents: base, txn_type: 'charge', legacy_evidence: null,
        description: `Builder assessment ${y} at ${pct}% of $${money(annual)}: ${days}/${diy} days (${bStart} to ${cutoff}), conversion ${code}` });
      addLine(ar, base, p.id, `Builder assessment through ${cutoff} (${p.street_address})`);
      addLine(income, -base, null, `Builder assessment ${y} earned through ${cutoff} (${p.street_address})`);
    } else if (identified) {
      const billed = Number(legacy[0].amount_cents);
      const recognized = deferNo ? divRound(billed * monthsReleased, 12) : billed;
      const deferred = billed - recognized;
      out.rows.push({ ...common, kind: 'normalization', annual_billed_cents: billed, ledger_amount_cents: base - billed, txn_type: base - billed < 0 ? 'adjustment' : 'charge',
        legacy_evidence: { description: legacy[0].description, date: d10(legacy[0].transaction_date), amount_cents: billed, vantaca_account_id: p.vantaca_account_id, legacy_row_id: legacy[0].id, note: 'evidence only; the legacy batch is reverted at EXECUTE' },
        recognized_cents: recognized, deferred_cents: deferred,
        description: `Builder-rate normalization ${y}: ${days}/${diy} days at ${pct}% of $${money(annual)} (${bStart} to ${cutoff}) replaces the $${money(billed)} annual assessment, conversion ${code}` });
      addLine(income, recognized - base, null, `Builder-rate normalization: income recognized on the $${money(billed)} annual assessment reduced to the builder rate (${p.street_address})`);
      if (deferred) { addLine(defer, deferred, null, `Builder-rate normalization: the lot's unreleased deferral removed (${p.street_address})`); normalizedDeferral += deferred; }
      addLine(ar, base - billed, p.id, `Builder-rate normalization of the $${money(billed)} annual assessment (${p.street_address})`);
    } else {
      out.unresolved.push({ ...lot, reason: 'the builder\'s assessment activity for the year does not show clearly what it was billed', rows: legacy.map((r) => ({ id: r.id, date: d10(r.transaction_date), description: r.description, amount_cents: Number(r.amount_cents) })) });
    }
  }
  if (lines.length) {
    const dr = lines.reduce((s, l) => s + l.debit_cents, 0); const cr = lines.reduce((s, l) => s + l.credit_cents, 0);
    out.je = { reference: `${code}-BUILDER`, kind: 'builder_coverage', original_je_id: null, posting_date: cutover, source_module: 'manual', source_reference: `${code}:builder`,
      description: `Conversion ${cutover}: builder assessments at the builder rate through ${cutoff} (${out.rows.filter((r) => r.kind === 'baseline').length} baseline, ${out.rows.filter((r) => r.kind === 'normalization').length} normalized)`,
      lines, total_debits_cents: dr, total_credits_cents: cr };
  }
  out.controls.push({ code: 'preflight.builder_entry_balances', label: 'The builder entry balances and every account it posts to exists', failures: [...acctProblems, ...(out.je && out.je.total_debits_cents !== out.je.total_credits_cents ? [{ problem: 'unbalanced', debits: out.je.total_debits_cents, credits: out.je.total_credits_cents }] : [])], blocked: true });
  out.controls.push({ code: 'preflight.builder_positions_resolved', label: 'Every builder lot\'s assessment position through the baseline is resolved (an unresolved lot gets no coverage; it is carried as a reconciling item)',
    failures: out.unresolved.map((u) => ({ lot: u.street_address, property_id: u.property_id, problem: u.reason, rows: u.rows })) });
  for (const u of out.unresolved) out.reconciling_items.push({ kind: 'builder_position_unresolved', item_key: u.property_id, property_id: u.property_id, account_number: u.account_number, amount_cents: u.rows.reduce((s, r) => s + r.amount_cents, 0),
    detail: { lot: u.street_address, reason: u.reason, rows: u.rows, owners: u.owners } });

  // ------------------------------------------------- the deferral release schedule
  if (deferNo && defer && monthsReleased < 12) {
    const billedLots = (builder.annual_rows || []).filter((r) => d10(r.transaction_date) === jan1 && r.txn_type === 'charge' && Number(r.amount_cents) === annual && /annual.*assessment/i.test(r.description || ''));
    const yearBilling = billedLots.length * annual;
    const remaining = yearBilling - divRound(yearBilling * monthsReleased, 12);
    const total = remaining - normalizedDeferral;
    const tb2205 = -Number(tbOf(deferNo) || 0);   // a liability: credit balance
    const residue = tb2205 - normalizedDeferral - total;
    const term = 12 - monthsReleased;
    if (total > 0) {
      out.schedule = { schedule_type: 'deferred_revenue', balance_account_number: deferNo, recognition_account_id: income && income.id, recognition_account_number: incomeNo,
        recognize_amount_cents: total, start_month: `${cutover.slice(0, 7)}-01`, term_months: term, monthly_amount_cents: divRound(total, term),
        period_start: cutover, period_end: dec31, recognition_method: 'straight_line_monthly', schedule_basis: 'calculated', source_type: 'conversion_balance',
        description: `${y} annual assessments: unearned balance at ${cutoff} recognized ${cutover.slice(0, 7)} through ${dec31.slice(0, 7)} (conversion ${code})`,
        explanation: `${billedLots.length} lots billed $${money(annual)} on ${jan1} = $${money(yearBilling)}; released 1/12 monthly through ${cutoff} leaves $${money(remaining)}; less $${money(normalizedDeferral)} removed by builder-rate normalization = $${money(total)}.`,
        basis: { billed_lots: billedLots.length, year_billing_cents: yearBilling, months_released: monthsReleased, remaining_cents: remaining, normalized_deferral_cents: normalizedDeferral, tb_2205_cents: tb2205, residue_cents: residue } };
    }
    out.controls.push({ code: 'preflight.deferral_schedule_reconciles', label: `${deferNo} after the conversion equals the release schedule exactly; anything else in ${deferNo} is a separate reconciling item`,
      failures: residue !== 0 ? [{ account: deferNo, tb_cents: tb2205, normalized_deferral_cents: normalizedDeferral, schedule_cents: total, residue_cents: residue, problem: `$${money(residue)} in ${deferNo} is not part of the ${y} release schedule; carried as a reconciling item` }] : [] });
    if (residue !== 0) out.reconciling_items.push({ kind: 'deferral_residue', item_key: deferNo, property_id: null, account_number: deferNo, amount_cents: residue,
      detail: { account: deferNo, tb_cents: tb2205, schedule_cents: total, normalized_deferral_cents: normalizedDeferral, note: `not released with the ${y} schedule; resolve separately` } });
  }
  return out;
}

module.exports = { buildBuilderPositions, nameHas };
