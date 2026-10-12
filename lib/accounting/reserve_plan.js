// Reserve plan inputs (Ed 2026-10-11). The calculation itself lives in
// public/js/reserve_plan_core.js so the budget editor and the proposed-budget
// statement / PDF run the same code; this module only loads what it needs.
'use strict';

const core = require('../../public/js/reserve_plan_core');

// Planned capital projects for (community, fiscal year). Before migration 512 the
// GL account / timing / review columns do not exist: projects are read without
// them (columns_ready false) and cannot be saved with a GL account yet.
async function loadReservePlanProjects(supabase, { community_id, fiscal_year }) {
  const base = (cols) => supabase.from('reserve_budget_items').select(cols)
    .eq('community_id', community_id).eq('fiscal_year', Number(fiscal_year))
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true }).limit(500);
  let r = await base('id, project_name, category, planned_amount_cents, note, sort_order, account_id, planned_month, review_status');
  let columns_ready = true;
  if (r.error && /account_id|planned_month|review_status|does not exist|schema cache/i.test(r.error.message || '')) {
    columns_ready = false;
    r = await base('id, project_name, category, planned_amount_cents, note, sort_order');
  }
  if (r.error) throw new Error(`reserve_budget_items: ${r.error.message}`);
  const projects = (r.data || []).map((p) => ({ ...p, account_id: p.account_id || null, planned_month: p.planned_month || null, review_status: p.review_status || 'planned' }));
  // Once any project carries a GL account the year's plan is project-based: the saved
  // reserve expense lines are derived from the projects, not independent amounts.
  return { projects, columns_ready, plan_saved: projects.some((p) => p.account_id) };
}

module.exports = { loadReservePlanProjects, computeReservePlan: core.computeReservePlan, transferIntoReserve: core.transferIntoReserve, monthLabel: core.monthLabel };
