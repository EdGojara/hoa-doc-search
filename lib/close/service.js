// ============================================================================
// lib/close/service.js  (Ed 2026-10-09: month-end close, PR A)
// ----------------------------------------------------------------------------
// The month-end close workflow over the migration 502 functions:
//   run       gather the books -> evaluate the checklist -> record the run
//             (refused if the books changed while it ran)
//   override  owner only: a written reason against one BLOCK, bound to the
//             evidence that BLOCK saw
//   accept    admin/owner: accept the WARNINGs on the latest run
//   close     admin/owner: closes the month on the latest run, re-verifying the
//             books' fingerprint; months close in order
//   reopen    admin/owner: written reason; newest closed month first
// Authority is enforced twice: by the API (requireOwner / requireAdmin) and by
// the database functions (role + reason checks). The checklist is deterministic.
// ============================================================================
const { evaluateClose, ENGINE_VERSION } = require('./controls');
const { gatherCloseInput } = require('./gather');
const { fetchAll } = require('../db/fetch_all');

const must = (r, what) => { if (r.error) { const e = new Error(`${what}: ${r.error.message}`); e.code = r.error.code; throw e; } return r.data; };
const rpc = async (supabase, name, args) => {
  const r = await supabase.rpc(name, args);
  if (r.error) {
    const m = r.error.message || String(r.error);
    const e = new Error(m.replace(/^[a-z_]+: /, ''));
    const k = /^([a-z_]+):/.exec(m);
    e.code = k ? k[1] : (r.error.code || 'close_error');
    e.refusal = /refused|period_closed|stale_run|books_changed|reason|only the owner|not a WARNING|not BLOCK|run the checklist|not closed|newer checklist|actor required|name the warnings/i.test(m);
    throw e;
  }
  return r.data;
};

async function listPeriods(supabase, cid) {
  const periods = await fetchAll(supabase, 'accounting_periods', {
    select: 'id, fiscal_year, period_number, period_type, period_start, period_end, status', filters: { community_id: cid }, orderBy: 'period_end', ascending: false });
  const closes = await fetchAll(supabase, 'period_closes', {
    select: 'period_id, status, close_label, closed_at, closed_by, reopen_count, latest_run_id', filters: { community_id: cid } });
  const byP = Object.fromEntries(closes.map((c) => [c.period_id, c]));
  const throughR = await supabase.rpc('close_closed_through', { p_community: cid });
  const closedThrough = throughR.error ? null : (throughR.data ? String(throughR.data).slice(0, 10) : null);
  const com = must(await supabase.from('communities').select('gl_cutover_date').eq('id', cid).single(), 'communities');
  return {
    closed_through: closedThrough,
    gl_cutover_date: com.gl_cutover_date || null,
    periods: periods.filter((p) => (p.period_type || 'monthly') === 'monthly').map((p) => {
      const c = byP[p.id] || null;
      const priorSystem = !!(com.gl_cutover_date && String(p.period_end) < String(com.gl_cutover_date));
      return { ...p, close_status: c ? c.status : (['closed', 'locked'].includes(p.status) ? 'closed' : 'open'), close_label: c && c.close_label,
        closed_at: c && c.closed_at, closed_by: c && c.closed_by, reopen_count: c ? c.reopen_count : 0,
        locked_by_later_close: !!(closedThrough && String(p.period_end) <= closedThrough && !['closed', 'locked'].includes(p.status)),
        prior_system: priorSystem };
    }),
  };
}

async function status(supabase, cid, periodId) {
  const period = must(await supabase.from('accounting_periods').select('id, fiscal_year, period_number, period_start, period_end, status').eq('id', periodId).eq('community_id', cid).single(), 'accounting_periods');
  const rec = must(await supabase.from('period_closes').select('*').eq('period_id', periodId).maybeSingle(), 'period_closes');
  let run = null;
  if (rec && rec.latest_run_id) run = must(await supabase.from('period_close_runs').select('*').eq('id', rec.latest_run_id).single(), 'period_close_runs');
  const events = await fetchAll(supabase, 'period_close_events', { select: 'id, seq, run_id, event, control_code, evidence_hash, actor, actor_role, reason, detail, created_at', filters: { period_id: periodId }, orderBy: 'seq' });
  const lastReopen = events.filter((e) => e.event === 'reopened').map((e) => e.created_at).sort().pop() || null;
  const cycle = events.filter((e) => !lastReopen || e.created_at > lastReopen);
  const overrides = cycle.filter((e) => e.event === 'block_overridden');
  const accepted = new Set(cycle.filter((e) => e.event === 'warnings_accepted' && run && e.run_id === run.id).flatMap((e) => (e.detail && e.detail.control_codes) || []));
  const results = run ? run.results.map((r) => {
    const ov = r.status === 'BLOCK' ? overrides.filter((o) => o.control_code === r.code && o.evidence_hash === r.evidence_hash).pop() : null;
    return { ...r, override: ov ? { actor: ov.actor, reason: ov.reason, at: ov.created_at } : null, accepted: r.status === 'WARNING' ? accepted.has(r.code) : null };
  }) : [];
  return {
    period, record: rec, run: run ? { id: run.id, run_at: run.run_at, run_by: run.run_by, engine_version: run.engine_version, fingerprint: run.fingerprint, summary: run.summary, status_after: run.status_after } : null,
    results, events,
    can_close: !!(run && rec && rec.status === 'ready_to_close' && results.filter((r) => r.status === 'WARNING' && !r.accepted).length === 0),
  };
}

async function runChecklist(supabase, cid, periodId, actor) {
  const input = await gatherCloseInput(supabase, cid, periodId);
  if (['closed', 'locked'].includes(input.period.status)) throw Object.assign(new Error('This month is closed; reopen it before running the checklist again.'), { code: 'period_closed', refusal: true });
  const ev = evaluateClose(input);
  const facts = { ...input.facts };
  const recorded = await rpc(supabase, 'close_record_run', {
    p_community: cid, p_period: periodId, p_actor: actor.name, p_actor_user_id: actor.user_id || null, p_engine_version: ENGINE_VERSION,
    p_fingerprint: input.facts.fingerprint, p_ledger_facts: facts, p_results: ev.results, p_summary: ev.summary,
  });
  return { ...recorded, summary: ev.summary };
}

const overrideBlock = (supabase, cid, periodId, { run_id, control_code, reason }, actor) => rpc(supabase, 'close_override_block', {
  p_community: cid, p_period: periodId, p_run: run_id, p_control_code: control_code, p_reason: reason,
  p_actor: actor.name, p_actor_user_id: actor.user_id || null, p_actor_role: actor.role });

const acceptWarnings = (supabase, cid, periodId, { run_id, control_codes, note }, actor) => rpc(supabase, 'close_accept_warnings', {
  p_community: cid, p_period: periodId, p_run: run_id, p_control_codes: control_codes, p_note: note || null,
  p_actor: actor.name, p_actor_user_id: actor.user_id || null, p_actor_role: actor.role });

const closePeriod = (supabase, cid, periodId, { run_id }, actor) => rpc(supabase, 'close_period', {
  p_community: cid, p_period: periodId, p_run: run_id, p_actor: actor.name, p_actor_user_id: actor.user_id || null, p_actor_role: actor.role });

const reopenPeriod = (supabase, cid, periodId, { reason }, actor) => rpc(supabase, 'reopen_period', {
  p_community: cid, p_period: periodId, p_reason: reason, p_actor: actor.name, p_actor_user_id: actor.user_id || null, p_actor_role: actor.role });

const addEvidence = (supabase, cid, periodId, { requirement_id, document_ref, note }, actor) => rpc(supabase, 'close_add_evidence', {
  p_community: cid, p_period: periodId, p_requirement: requirement_id, p_document_ref: document_ref, p_note: note || null, p_actor: actor.name });

module.exports = { listPeriods, status, runChecklist, overrideBlock, acceptWarnings, closePeriod, reopenPeriod, addEvidence };
