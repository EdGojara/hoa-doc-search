// ============================================================================
// lib/projects/board_view.js  (Ed 2026-07-27)
// ----------------------------------------------------------------------------
// Turns a vendor_projects row into the board-accountability view: budget vs
// LIVE actual spend (read from the AP subledger, never stored), a schedule
// health signal, and the milestones. One shared computation so the staff screen
// and the board screen can never disagree.
//
// Actual spend is vendor-scoped (invoices from the project's vendor at this
// community since it started) — an HONEST, defined figure, labelled as such.
// Precise per-invoice-to-project attribution is the next step (link ap_invoices
// to a project); until then we never claim more precision than we have.
// ============================================================================

const money = (c) => (c == null ? null : (c < 0 ? '-' : '') + '$' + (Math.abs(Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Central-time "today" as YYYY-MM-DD (no Date.now trap in shared code — callers
// pass todayISO; default is computed once here from the runtime).
function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const a = Date.parse(fromISO + 'T00:00:00Z'), b = Date.parse(toISO + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

const DONE_STAGES = new Set(['complete', 'completed', 'closed', 'done', 'work_complete', 'cancelled']);

// Schedule health from target date + progress + stage. Returns one of
// complete | behind | at_risk | stalled | on_track | no_target.
function projectHealth(p, todayISO) {
  if (p.completed_at || DONE_STAGES.has(String(p.stage || '').toLowerCase())) return 'complete';
  const pct = Number(p.percent_complete) || 0;
  const dToTarget = p.target_date ? daysBetween(String(p.target_date).slice(0, 10), todayISO) : null;
  if (dToTarget != null && dToTarget < 0) return 'behind';                 // past its deadline
  if (dToTarget != null && dToTarget <= 14 && pct < 80) return 'at_risk';  // deadline close, not near done
  // Stuck waiting on a decision/approval for weeks with no movement.
  const stageAgeDays = p.stage_since ? daysBetween(todayISO, String(p.stage_since).slice(0, 10)) : null;
  const waiting = /decid|approv|await|hold|scope/i.test(`${p.stage || ''} ${p.next_action || ''}`);
  if (waiting && stageAgeDays != null && stageAgeDays >= 21) return 'stalled';
  return dToTarget == null ? 'no_target' : 'on_track';
}

// Live actual spend: total invoiced by this project's vendor at this community
// since the project started. Vendor-scoped (labelled as such). Returns cents or
// null when we can't attribute (no vendor linked).
async function actualSpentCents(supabase, p) {
  if (!p.vendor_id || !p.community_id) return null;
  try {
    let q = supabase.from('ap_invoices')
      .select('total_cents, status, invoice_date')
      .eq('vendor_id', p.vendor_id).eq('community_id', p.community_id).limit(2000);
    const { data, error } = await q;
    if (error || !data) return null;
    const startISO = p.started_at ? String(p.started_at).slice(0, 10) : null;
    let cents = 0;
    for (const inv of data) {
      if (String(inv.status || '').toLowerCase() === 'void') continue;
      if (startISO && inv.invoice_date && String(inv.invoice_date).slice(0, 10) < startISO) continue;
      cents += Number(inv.total_cents) || 0;
    }
    return cents;
  } catch (_) { return null; }
}

// Assemble the board-ready object for one project. `milestones` is the project's
// rows (may be []). `todayISO` is 'YYYY-MM-DD' Central.
async function boardProjectView(supabase, p, milestones, todayISO) {
  const budgetCents = (p.approved_cost_cents != null ? p.approved_cost_cents : p.estimated_cost_cents);
  const actualCents = await actualSpentCents(supabase, p);
  const varianceCents = (budgetCents != null && actualCents != null) ? (Number(budgetCents) - Number(actualCents)) : null;
  const health = projectHealth(p, todayISO);
  const ms = (milestones || []).slice().sort((a, b) => (a.sort_order - b.sort_order) || String(a.due_date || '').localeCompare(String(b.due_date || '')));
  const doneCount = ms.filter((m) => m.status === 'done').length;
  const nextMs = ms.find((m) => m.status !== 'done');
  return {
    id: p.id,
    title: p.title,
    category: p.category || null,
    vendor: p.vendor_name || null,
    stage: p.stage || null,
    health,
    percent_complete: p.percent_complete != null ? Number(p.percent_complete) : (ms.length ? Math.round((doneCount / ms.length) * 100) : null),
    target_date: p.target_date ? String(p.target_date).slice(0, 10) : null,
    started_at: p.started_at ? String(p.started_at).slice(0, 10) : null,
    next_action: p.next_action_note || p.next_action || null,
    next_action_owner: p.next_action_owner || null,
    funding_source: p.funding_source || null,
    budget_cents: budgetCents != null ? Number(budgetCents) : null,
    budget_display: money(budgetCents),
    actual_cents: actualCents,
    actual_display: money(actualCents),
    actual_basis: actualCents != null ? `invoiced by ${p.vendor_name || 'the vendor'}${p.started_at ? ' since start' : ''}` : null,
    variance_cents: varianceCents,
    variance_display: money(varianceCents),
    over_budget: (varianceCents != null && varianceCents < 0),
    milestones: ms.map((m) => ({ id: m.id, title: m.title, due_date: m.due_date ? String(m.due_date).slice(0, 10) : null, status: m.status, owner: m.owner || null, overdue: !!(m.due_date && m.status !== 'done' && daysBetween(String(m.due_date).slice(0, 10), todayISO) < 0) })),
    milestones_done: doneCount,
    milestones_total: ms.length,
    next_milestone: nextMs ? { title: nextMs.title, due_date: nextMs.due_date ? String(nextMs.due_date).slice(0, 10) : null, owner: nextMs.owner || null } : null,
    updated_at: p.updated_at || null,
  };
}

module.exports = { boardProjectView, projectHealth, actualSpentCents, money, daysBetween };
