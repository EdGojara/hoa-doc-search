// ============================================================================
// lib/accounting/budget_roll_forward.js  (Ed 2026-09-02)
// ----------------------------------------------------------------------------
// Build next year's proposed budget FROM the prior year's adopted budget, the
// way a manager actually starts one: carry every line forward as the starting
// plan (a budget is a deliberate plan, not an auto-inflated guess), then surface
// where the numbers argue for a change so the manager decides, line by line:
//
//   * RUN-RATE. For each expense line, compare this year's actuals-to-date
//     against this year's budget (budgetVsActual). Where the line is tracking
//     materially over or under, attach a note so it gets a second look before
//     adoption. That is Ed's "do not just apply a flat percentage, check how it
//     is actually tracking."
//   * RESERVES. If the community's active reserve study has a funding plan for
//     the target year, note the recommended contribution against the carried
//     amount. The reserve contribution is the line boards most often under-fund
//     by accident.
//
// It never overwrites an existing budget for the target year (an approved one is
// sealed); it returns a conflict so the caller decides. The result is a DRAFT.
// record_ownership: mixed — the delivered budget is the association's, the
// supporting run-rate analysis is Bedrock workpaper. (community_budgets is a
// single-class association_record table; the analysis lives only in the notes.)
// ============================================================================
const { budgetVsActual } = require('./financial_statements');

const MATERIAL_VARIANCE = 0.15; // 15% YTD over/under budget → flag the line
const dollars = (cents) => '$' + (Math.round(Number(cents || 0)) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function rollForwardBudget(supabase, { communityId, fromYear, toYear, basis = 'flat', inflationPct = 0, createdByUserId = null }) {
  if (!communityId) { const e = new Error('community_id_required'); e.code = 'invalid_input'; throw e; }
  fromYear = Number(fromYear); toYear = Number(toYear);
  if (!fromYear || !toYear || toYear <= fromYear) { const e = new Error('from/to fiscal_year invalid'); e.code = 'invalid_input'; throw e; }
  if (!['flat', 'inflation'].includes(basis)) basis = 'flat';
  const factor = basis === 'inflation' ? (1 + (Number(inflationPct) || 0) / 100) : 1;

  // Source budget + its lines (with account type for expense/revenue handling).
  const { data: src, error: srcErr } = await supabase.from('community_budgets')
    .select('id, fiscal_year, status').eq('community_id', communityId).eq('fiscal_year', fromYear).maybeSingle();
  if (srcErr) throw srcErr;
  if (!src) { const e = new Error(`no FY${fromYear} budget to roll forward for this community`); e.code = 'invalid_input'; throw e; }

  const { data: lines, error: lErr } = await supabase.from('budget_line_items')
    .select('account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes, chart_of_accounts:account_id(account_number, account_name, account_type)')
    .eq('budget_id', src.id);
  if (lErr) throw lErr;
  if (!lines || !lines.length) { const e = new Error(`FY${fromYear} budget has no line items`); e.code = 'invalid_input'; throw e; }

  // Don't clobber an existing target-year budget (an approved one is sealed).
  const { data: existing } = await supabase.from('community_budgets')
    .select('id, status').eq('community_id', communityId).eq('fiscal_year', toYear).maybeSingle();
  if (existing) return { conflict: true, existing_budget_id: existing.id, existing_status: existing.status };

  // Best-effort run-rate (this year's actuals vs budget), keyed by account number.
  // budgetVsActual needs a period_end; use today when rolling the current year
  // forward, else the source year's close.
  const nowYear = new Date().getUTCFullYear();
  const periodEnd = fromYear >= nowYear ? new Date().toISOString().slice(0, 10) : `${fromYear}-12-31`;
  const actualByAcct = new Map();
  try {
    const bva = await budgetVsActual({ community_id: communityId, period_end: periodEnd });
    for (const r of (bva.rows || [])) actualByAcct.set(r.account_number, r);
  } catch (e) { console.warn('[budget_roll_forward] run-rate unavailable:', e.message); }

  // Best-effort reserve-study recommendation for the target year.
  let reserveRec = null;
  try {
    const { data: fp } = await supabase.from('reserve_funding_plan')
      .select('recommended_contribution_cents, total_contribution_cents')
      .eq('community_id', communityId).eq('fiscal_year', toYear).maybeSingle();
    reserveRec = fp || null;
  } catch (e) { console.warn('[budget_roll_forward] reserve plan unavailable:', e.message); }

  // Create the target-year DRAFT.
  const { data: nb, error: nbErr } = await supabase.from('community_budgets').insert({
    community_id: communityId, fiscal_year: toYear, status: 'draft',
    notes: `Rolled forward from FY${fromYear}${basis === 'inflation' ? ` with ${inflationPct}% applied to expenses` : ' (lines carried forward)'}. Draft for review.`,
    approved_at: null, approved_by_user_id: null,
  }).select('id').single();
  if (nbErr) throw nbErr;

  const flags = [];
  const rows = lines.map((li) => {
    const coa = li.chart_of_accounts || {};
    const isExpense = coa.account_type === 'expense';
    const f = (basis === 'inflation' && isExpense) ? factor : 1;
    const monthly = (Array.isArray(li.monthly_amounts_cents) ? li.monthly_amounts_cents : []).map((c) => Math.round((Number(c) || 0) * f));
    while (monthly.length < 12) monthly.push(0);
    const annual = monthly.slice(0, 12).reduce((s, c) => s + c, 0);

    const noteParts = [];
    // Run-rate flag on expense lines tracking materially off budget YTD.
    if (isExpense) {
      const a = actualByAcct.get(coa.account_number);
      if (a && Math.abs(Number(a.ytd_budget_cents || 0)) > 0) {
        const vb = Number(a.ytd_budget_cents), va = Number(a.ytd_actual_cents || 0);
        const dev = (va - vb) / Math.abs(vb);
        if (Math.abs(dev) >= MATERIAL_VARIANCE) {
          const dir = dev > 0 ? 'over' : 'under';
          noteParts.push(`FY${fromYear} tracking ${Math.round(Math.abs(dev) * 100)}% ${dir} budget YTD (actual ${dollars(va)} vs budget ${dollars(vb)} through the period). Review the FY${toYear} figure.`);
          flags.push({ account_number: coa.account_number, account_name: coa.account_name, type: 'run_rate', direction: dir, deviation_pct: Math.round(Math.abs(dev) * 100) });
        }
      }
    }
    // Reserve-contribution alignment.
    if (/reserve contribution/i.test(coa.account_name || '') && reserveRec && reserveRec.recommended_contribution_cents != null) {
      const rec = Number(reserveRec.recommended_contribution_cents);
      const carried = Math.abs(annual);
      if (Math.abs(rec - carried) > 100) {
        noteParts.push(`Reserve study recommends ${dollars(rec)} for FY${toYear}; carried-forward is ${dollars(carried)}. Align before adoption.`);
        flags.push({ account_number: coa.account_number, account_name: coa.account_name, type: 'reserve_alignment', recommended_cents: rec, carried_cents: carried });
      }
    }

    return {
      budget_id: nb.id,
      account_id: li.account_id,
      fund_id: li.fund_id || null,
      annual_amount_cents: annual,
      monthly_amounts_cents: monthly.slice(0, 12),
      notes: noteParts.join(' ') || null,
    };
  });

  const { error: insErr } = await supabase.from('budget_line_items').insert(rows);
  if (insErr) { // roll back the empty draft so we don't leave an orphan
    await supabase.from('community_budgets').delete().eq('id', nb.id);
    throw insErr;
  }

  return {
    budget_id: nb.id,
    from_budget_id: src.id,
    from_year: fromYear,
    to_year: toYear,
    basis,
    inflation_pct: basis === 'inflation' ? Number(inflationPct) || 0 : 0,
    line_count: rows.length,
    flags,
    flag_count: flags.length,
    run_rate_available: actualByAcct.size > 0,
    reserve_plan_available: !!reserveRec,
  };
}

module.exports = { rollForwardBudget };
