// ============================================================================
// lib/manager/shadow.js  (Issue #27 Phase 1) — "What Amanda would do" read model
// ----------------------------------------------------------------------------
// Read-only. Bounded queries. A failed source is reported as unavailable, never
// as "nothing to do" (same rule as /api/today section_errors, Issue #6).
// ============================================================================
const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const PRI = { critical: 0, high: 1, normal: 2, low: 3 };
const CLS = { BLOCK: 0, REVIEW: 1, EXECUTE: 2 };

function sweepSchedule(env = process.env) {
  const hours = String(env.MANAGER_SWEEP_HOURS || '8,15').split(',').map((h) => Number(h.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  const list = String(env.SCHEDULER_ENABLED || '').trim();
  const scheduled = String(env.SCHEDULER_DISABLED || '').toLowerCase() !== 'true'
    && (list === 'all' || list === '*' || list.split(',').map((s) => s.trim()).includes('manager_sweep'))
    && String(env.AMANDA_MANAGER || '').toLowerCase() !== 'off';
  return { hours: [...new Set(hours)].sort((a, b) => a - b), business_days_only: true, scheduled };
}

async function buildShadow(supabase, { communityId = null, now = Date.now(), env = process.env } = {}) {
  const out = { phase: 1, model_calls: 0, actions_executed: 0, schedule: sweepSchedule(env), section_errors: {} };
  const since = new Date(now - 24 * 3600000).toISOString();
  const scope = (qb) => (communityId ? qb.eq('community_id', communityId) : qb);
  const run = async (name, p) => { const { data, error } = await p; if (error) { out.section_errors[name] = error.message; return null; } return data || []; };

  const [open, resolved, wakes, pending, lastRun] = await Promise.all([
    run('objectives', scope(supabase.from('objectives')
      .select('id, title, autonomy_class, priority, blocked_reason, next_action, next_action_due, domain, subject_key, community_id, last_activity_at, wake_reason, communities:community_id(name)')
      .eq('accountable_persona', 'amanda').not('subject_key', 'is', null).in('status', OPEN).order('last_activity_at', { ascending: false }).limit(100))),
    run('resolved', scope(supabase.from('objectives').select('id').eq('accountable_persona', 'amanda').not('subject_key', 'is', null).eq('status', 'resolved').gte('closed_at', since).limit(500))),
    run('wakes', scope(supabase.from('manager_wakes').select('outcome').eq('status', 'consumed').gte('consumed_at', since).limit(1000))),
    run('pending', scope(supabase.from('manager_wakes').select('id').eq('status', 'pending').limit(1000))),
    run('last_sweep', supabase.from('cron_runs').select('started_at, finished_at, ok, summary, error').eq('job_name', 'manager_sweep').order('started_at', { ascending: false }).limit(1)),
  ]);

  out.available = !out.section_errors.objectives;
  const items = (open || []).map((o) => ({
    id: o.id, title: o.title, autonomy_class: o.autonomy_class, priority: o.priority, blocked_reason: o.blocked_reason, next_action: o.next_action,
    next_action_due: o.next_action_due, domain: o.domain, community: (o.communities && o.communities.name) || null, last_activity_at: o.last_activity_at, wake_reason: o.wake_reason,
  })).sort((a, b) => (CLS[a.autonomy_class] ?? 9) - (CLS[b.autonomy_class] ?? 9) || (PRI[a.priority] ?? 9) - (PRI[b.priority] ?? 9));
  out.needs_people = items.filter((i) => i.autonomy_class === 'REVIEW');
  out.blocked = items.filter((i) => i.autonomy_class === 'BLOCK');
  const tally = {}; for (const w of wakes || []) tally[w.outcome || 'unknown'] = (tally[w.outcome || 'unknown'] || 0) + 1;
  out.last_24h = { routine_would_continue: tally.execute_candidate || 0, resolved: resolved ? resolved.length : null, wakes_processed: wakes ? wakes.length : null, by_outcome: tally };
  out.pending_wakes = pending ? pending.length : null;
  out.last_sweep = lastRun && lastRun[0] ? lastRun[0] : null;
  return out;
}

module.exports = { buildShadow, sweepSchedule };
