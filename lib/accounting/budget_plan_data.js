// ============================================================================
// lib/accounting/budget_plan_data.js — everything the monthly plan screen reads.
// ----------------------------------------------------------------------------
// Budget Phase 2 (Ed 2026-09-25). Read-only: the budget's lines with their
// months, phasing and components; the Phase 1 report category of each line;
// the prior-year approved budget months and prior-year actual months per
// account (the two "copy the shape" sources); live projects and contract
// sources that components may link to. Every query checks its error: a broken
// read must never look like "no data".
// ============================================================================

const { fetchAllQuery } = require('../db/fetch_all');
const { COUNTED_JE_STATUSES, countsInGl } = require('./je_status');
const { loadReportMapping } = require('./report_categories');

const must = (r, what) => { if (r.error) { const e = new Error(`${what}: ${r.error.message}`); e.cause = r.error; throw e; } return r.data; };

// Monthly actuals (natural sign) per account for one calendar year.
async function monthlyActualsByAccount(supabase, community_id, year, accounts) {
  const out = {}; const normal = {};
  for (const a of accounts) { out[a.id] = Array(12).fill(0); normal[a.id] = a.normal_balance || 'debit'; }
  const ids = accounts.map((a) => a.id);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const rows = await fetchAllQuery(() => supabase.from('journal_entry_lines')
      .select('id, account_id, debit_cents, credit_cents, journal_entries!inner(posting_date, status, void_reversal_je_id)')
      .in('account_id', batch)
      .in('journal_entries.status', COUNTED_JE_STATUSES)
      .gte('journal_entries.posting_date', `${year}-01-01`)
      .lte('journal_entries.posting_date', `${year}-12-31`), { orderBy: 'id' });
    for (const r of rows || []) {
      if (!countsInGl(r.journal_entries)) continue;
      const m = parseInt(String(r.journal_entries.posting_date).slice(5, 7), 10) - 1;
      if (!(m >= 0 && m <= 11)) continue;
      const d = Number(r.debit_cents) || 0, c = Number(r.credit_cents) || 0;
      out[r.account_id][m] += normal[r.account_id] === 'credit' ? c - d : d - c;
    }
  }
  return out;
}

// Contract sources a line may be phased from. A documented schedule is only
// claimed when the source actually carries one.
function contractSourcesFrom(vendorContracts, amenities) {
  const out = [];
  for (const c of vendorContracts || []) {
    const ex = c.extracted_data || {};
    const sched = Array.isArray(ex.payment_schedule) ? ex.payment_schedule : (Array.isArray(ex.monthly_schedule) ? ex.monthly_schedule : null);
    out.push({
      ref: 'vendor_contract:' + c.id, vendor_contract_id: c.id, source_label: `${c.vendor_name_raw || 'Vendor'} contract`,
      vendor_name: c.vendor_name_raw || null, service: c.service_category || null,
      annual_cents: Math.round((Number(c.annualized_amount) || 0) * 100),
      effective_date: c.effective_date || null, end_date: c.end_date || null,
      escalator_pct: c.escalator_kind && c.escalator_kind !== 'none' && c.escalator_pct != null ? Number(c.escalator_pct) : 0,
      documented_schedule: sched && sched.every((r) => Number(r.month) >= 1 && Number(r.month) <= 12) ? sched.map((r) => ({ month: Number(r.month), amount_cents: Math.round(Number(r.amount_cents) || 0) })) : null,
    });
  }
  for (const a of amenities || []) {
    if (!a.management_annual_cost_cents && !(Array.isArray(a.management_monthly_schedule) && a.management_monthly_schedule.length)) continue;
    out.push({
      ref: 'amenity:' + a.id, amenity_id: a.id, source_label: `${a.management_vendor_name || 'Management'} contract (${a.name})`,
      vendor_name: a.management_vendor_name || null, service: 'amenity_management',
      annual_cents: Number(a.management_annual_cost_cents) || 0,
      effective_date: a.management_contract_start_date || null, end_date: a.management_contract_end_date || null, escalator_pct: 0,
      documented_schedule: Array.isArray(a.management_monthly_schedule) && a.management_monthly_schedule.length ? a.management_monthly_schedule.map((r) => ({ month: Number(r.month), amount_cents: Math.round(Number(r.amount_cents) || 0) })) : null,
    });
  }
  return out;
}

async function loadBudgetPlan(supabase, budget_id) {
  const budget = must(await supabase.from('community_budgets').select('*').eq('id', budget_id).maybeSingle(), 'budget');
  if (!budget) return null;
  const cid = budget.community_id; const fy = budget.fiscal_year;
  const [lines, comps, coa, funds, mapping, prevBudget, projects, vcs, amen] = await Promise.all([
    supabase.from('budget_line_items').select('id, account_id, fund_id, annual_amount_cents, monthly_amounts_cents, notes, description, phasing_method, phasing_settings, schedule_basis')
      .eq('budget_id', budget_id).order('id').limit(5000),
    supabase.from('budget_line_components').select('*').eq('budget_id', budget_id).order('display_order').limit(5000),
    supabase.from('chart_of_accounts').select('id, account_number, account_name, account_type, normal_balance, fund_id').eq('community_id', cid).limit(5000),
    supabase.from('account_funds').select('id, fund_code, fund_name').eq('community_id', cid).limit(100),
    loadReportMapping(supabase, cid),
    supabase.from('community_budgets').select('id, fiscal_year, status').eq('community_id', cid).eq('fiscal_year', fy - 1).in('status', ['approved', 'active']).maybeSingle(),
    supabase.from('vendor_projects').select('id, title, vendor_name, stage, estimated_cost_cents, approved_cost_cents, funding_source, target_date, started_at, budget_account_id')
      .eq('community_id', cid).not('stage', 'in', '(closed,cancelled)').order('title').limit(500),
    supabase.from('vendor_contracts').select('id, vendor_name_raw, service_category, annualized_amount, effective_date, end_date, escalator_kind, escalator_pct, extracted_data, status')
      .eq('community_id', cid).in('status', ['active', 'expiring']).limit(500),
    supabase.from('amenities').select('id, name, management_vendor_name, management_annual_cost_cents, management_monthly_schedule, management_contract_start_date, management_contract_end_date')
      .eq('community_id', cid).limit(500),
  ]);
  const L = must(lines, 'budget lines'), C = must(comps, 'components'), A = must(coa, 'chart of accounts'), F = must(funds, 'funds');
  const P = must(prevBudget, 'prior budget'), PJ = must(projects, 'projects'), VC = must(vcs, 'contracts'), AM = must(amen, 'amenities');
  const acct = new Map(A.map((a) => [a.id, a])); const fund = new Map(F.map((f) => [f.id, f]));
  let priorBudgetMonths = {};
  if (P) {
    const pl = must(await supabase.from('budget_line_items').select('account_id, monthly_amounts_cents').eq('budget_id', P.id).limit(5000), 'prior budget lines');
    for (const r of pl) priorBudgetMonths[r.account_id] = (r.monthly_amounts_cents || []).map(Number);
  }
  const lineAccts = [...new Set(L.map((l) => l.account_id))].map((id) => acct.get(id)).filter(Boolean);
  const priorActual = await monthlyActualsByAccount(supabase, cid, fy - 1, lineAccts);
  const compsByLine = {}; for (const c of C) (compsByLine[c.budget_line_id] = compsByLine[c.budget_line_id] || []).push(c);
  const out = L.map((l) => {
    const a = acct.get(l.account_id) || {}; const f = fund.get(l.fund_id || a.fund_id) || {};
    const m = mapping.byAccount.get(l.account_id);
    return {
      ...l, monthly_amounts_cents: (l.monthly_amounts_cents || []).map(Number), annual_amount_cents: Number(l.annual_amount_cents),
      account_number: a.account_number, account_name: a.account_name, account_type: a.account_type, fund_code: f.fund_code || null,
      category: m ? m.top.report_label || m.top.name : null, subcategory: m && m.sub ? (m.sub.report_label || m.sub.name) : null,
      category_order: m ? m.top.display_order : 9999, subcategory_order: m && m.sub ? m.sub.display_order : 9999,
      components: (compsByLine[l.id] || []).map((c) => ({ ...c, monthly_amounts_cents: (c.monthly_amounts_cents || []).map(Number), annual_amount_cents: Number(c.annual_amount_cents) })),
      prior_budget_months: priorBudgetMonths[l.account_id] || null,
      prior_actual_months: priorActual[l.account_id] || null,
    };
  }).sort((x, y) => (x.account_type === y.account_type ? 0 : x.account_type === 'revenue' ? -1 : 1) || x.category_order - y.category_order || x.subcategory_order - y.subcategory_order || String(x.account_number).localeCompare(String(y.account_number)));
  return {
    budget, editable: budget.status === 'draft', has_categories: mapping.has_mapping,
    prior_budget_year: P ? P.fiscal_year : null, prior_actual_year: fy - 1,
    lines: out, projects: PJ, contract_sources: contractSourcesFrom(VC, AM),
  };
}

module.exports = { loadBudgetPlan, monthlyActualsByAccount, contractSourcesFrom };
