// ============================================================================
// lib/manager/sweep.js  (Issue #27 Phase 1) — the bounded manager sweep
// ----------------------------------------------------------------------------
// Scheduler-controlled (job `manager_sweep`, off unless in SCHEDULER_ENABLED),
// default twice per business day. Database candidate discovery FIRST; with no
// candidates the run ends immediately. Phase 1 makes ZERO model calls and takes
// ZERO business actions: it only writes Amanda's objective state (objectives /
// objective_events) and marks wakes consumed.
//
// Order, all sharing one candidate budget (MANAGER_MAX_CANDIDATES, default 40):
//   1. pending wakes (AP invoice / AP exception)          -> evaluate current row
//   2. BLOCKED objectives whose dependency is satisfied   -> re-evaluate once
//   3. open objectives with next_action_due soon/overdue  -> one note per change
//   4. board packets with a meeting inside the lead time, not final
//   5. re-check open subject objectives (oldest activity first) so finished
//      work resolves instead of going stale in the shadow view
// Unchanged state writes nothing (state hash), so repeated sweeps are silent.
// ============================================================================
const { KINDS, parseSubjectKey } = require('./subjects');
const { apply, markDue, OPEN } = require('./state');

const DEFAULTS = { maxCandidates: 40, lookaheadHours: 24, boardLeadDays: 7, urgentDays: 3 };
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
function config(env = process.env) {
  return {
    maxCandidates: num(env.MANAGER_MAX_CANDIDATES, DEFAULTS.maxCandidates),
    lookaheadHours: num(env.MANAGER_DUE_LOOKAHEAD_HOURS, DEFAULTS.lookaheadHours),
    boardLeadDays: num(env.MANAGER_BOARD_LEAD_DAYS, DEFAULTS.boardLeadDays),
    urgentDays: num(env.MANAGER_BOARD_URGENT_DAYS, DEFAULTS.urgentDays),
  };
}

async function q(p) { const { data, error } = await p; if (error) throw error; return data || []; }
async function loadSubject(supabase, kind, id) {
  const k = KINDS[kind];
  const rows = await q(supabase.from(k.table).select(k.columns).eq('id', id).limit(1));
  return rows[0] || null;
}
function evaluate(kind, row, now, cfg) { return kind === 'board_packet' ? KINDS[kind].evaluate(row, now, { urgentDays: cfg.urgentDays }) : KINDS[kind].evaluate(row); }

// Is a recorded dependency met? Whitelisted conditions only (no free-form SQL).
async function dependencyMet(supabase, dep) {
  if (dep && dep.table === 'ap_intake_exceptions' && dep.condition === 'not_pending') {
    const rows = await q(supabase.from('ap_intake_exceptions').select('status').eq('id', dep.id).limit(1));
    return !rows[0] || rows[0].status !== 'pending';
  }
  if (dep && dep.table === 'board_packets' && dep.condition === 'final') {
    const rows = await q(supabase.from('board_packets').select('status').eq('id', dep.id).limit(1));
    return !rows[0] || ['final', 'distributed', 'archived'].includes(rows[0].status);
  }
  return false; // unknown condition: never guessed true
}

async function runSweep({ supabase, now = Date.now(), env = process.env } = {}) {
  const cfg = config(env);
  const s = { ok: true, model_calls: 0, actions_executed: 0, candidates: 0, wakes: 0, execute_candidates: 0, no_action: 0, created: 0, updated: 0, resolved: 0, unchanged: 0, unblocked: 0, due_marked: 0, failed: 0, bounded: false, deferred: 0 };
  if (String(env.AMANDA_MANAGER || '').trim().toLowerCase() === 'off') return { ...s, fired: false, skipped: 'AMANDA_MANAGER=off' };
  let budget = cfg.maxCandidates;
  const take = (n) => { const k = Math.max(0, Math.min(n, budget)); budget -= k; return k; };
  const tally = (r) => { if (!r) return; if (r.outcome === 'execute_candidate') s.execute_candidates += 1; else if (r.outcome === 'no_action' || r.outcome === 'source_missing') s.no_action += 1; else if (r.outcome === 'unchanged' || r.changed === false) s.unchanged += 1; else if (r.outcome === 'resolved') s.resolved += 1; else if (r.created) s.created += 1; else s.updated += 1; };
  const seen = new Set();

  // 1. pending wakes
  const wakeCap = budget;
  const wakes = wakeCap ? await q(supabase.from('manager_wakes').select('id, kind, source_id, wake_reason').eq('status', 'pending').order('created_at', { ascending: true }).limit(wakeCap + 1)) : [];
  if (wakes.length > wakeCap) { s.bounded = true; s.deferred += wakes.length - wakeCap; }
  take(Math.min(wakes.length, wakeCap));
  for (const w of wakes.slice(0, wakeCap)) {
    s.candidates += 1; s.wakes += 1;
    try {
      const row = await loadSubject(supabase, w.kind, w.source_id);
      let r = { outcome: 'source_missing', objective_id: null };
      if (row) {
        const before = await q(supabase.from('objectives').select('id').eq('subject_key', `${w.kind}:${w.source_id}`).in('status', OPEN).limit(1));
        r = await apply(supabase, w.kind, w.source_id, evaluate(w.kind, row, now, cfg), { wakeReason: w.wake_reason, now, lookaheadHours: cfg.lookaheadHours });
        r.created = !before.length && r.changed && r.outcome !== 'resolved';
        seen.add(`${w.kind}:${w.source_id}`);
      }
      tally(r);
      await q(supabase.from('manager_wakes').update({ status: 'consumed', outcome: r.outcome, objective_id: r.objective_id || null, consumed_at: new Date(now).toISOString() }).eq('id', w.id));
    } catch (e) {
      s.failed += 1;
      console.warn('[manager.sweep] wake failed', JSON.stringify({ wake: w.id, error: e.message }));
      await supabase.from('manager_wakes').update({ status: 'failed', error: String(e.message).slice(0, 500), consumed_at: new Date(now).toISOString() }).eq('id', w.id);
    }
  }

  // 2. BLOCKED objectives whose dependency is now satisfied
  if (budget > 0) {
    const blocked = await q(supabase.from('objectives').select('*').eq('autonomy_class', 'BLOCK').in('status', OPEN).order('last_activity_at', { ascending: true }).limit(budget + 1));
    for (const o of blocked) {
      if (seen.has(o.subject_key)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      const deps = Array.isArray(o.depends_on) ? o.depends_on : [];
      if (!deps.length) continue;
      take(1); s.candidates += 1;
      try {
        let met = true; for (const d of deps) if (!(await dependencyMet(supabase, d))) { met = false; break; }
        if (!met) { s.unchanged += 1; continue; }
        const sk = parseSubjectKey(o.subject_key); if (!sk) continue;
        const row = await loadSubject(supabase, sk.kind, sk.id);
        const c = row ? evaluate(sk.kind, row, now, cfg) : { action: 'clear', outcome: 'resolved', reason: 'source record no longer exists' };
        const r = await apply(supabase, sk.kind, sk.id, c, { wakeReason: 'dependency_satisfied', now, lookaheadHours: cfg.lookaheadHours });
        if (r.changed) s.unblocked += 1;
        tally(r); seen.add(o.subject_key);
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] unblock failed', JSON.stringify({ objective: o.id, error: e.message })); }
    }
  }

  // 3. next_action_due soon / overdue
  if (budget > 0) {
    const horizon = new Date(now + cfg.lookaheadHours * 3600000).toISOString();
    const due = await q(supabase.from('objectives').select('*').in('status', OPEN).not('next_action_due', 'is', null).lte('next_action_due', horizon).order('next_action_due', { ascending: true }).limit(budget + 1));
    for (const o of due) {
      if (o.subject_key && seen.has(o.subject_key)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      take(1); s.candidates += 1;
      try {
        const sk = parseSubjectKey(o.subject_key);
        if (sk) {
          const row = await loadSubject(supabase, sk.kind, sk.id);
          const c = row ? evaluate(sk.kind, row, now, cfg) : { action: 'clear', outcome: 'resolved', reason: 'source record no longer exists' };
          const r = await apply(supabase, sk.kind, sk.id, c, { wakeReason: 'next_action_due', now, lookaheadHours: cfg.lookaheadHours });
          tally(r); seen.add(o.subject_key);
        } else {
          const r = await markDue(supabase, o, { now, lookaheadHours: cfg.lookaheadHours });
          if (r.changed) s.due_marked += 1; else s.unchanged += 1;
        }
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] due check failed', JSON.stringify({ objective: o.id, error: e.message })); }
    }
  }

  // 4. board packets with a meeting inside the lead time that are not final
  if (budget > 0) {
    const today = new Date(now).toISOString().slice(0, 10);
    const until = new Date(now + cfg.boardLeadDays * 86400000).toISOString().slice(0, 10);
    const packets = await q(supabase.from('board_packets').select(KINDS.board_packet.columns).in('status', ['draft', 'in_review']).gte('meeting_date', today).lte('meeting_date', until).order('meeting_date', { ascending: true }).limit(budget + 1));
    for (const p of packets) {
      if (seen.has(`board_packet:${p.id}`)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      take(1); s.candidates += 1;
      try {
        const before = await q(supabase.from('objectives').select('id').eq('subject_key', `board_packet:${p.id}`).in('status', OPEN).limit(1));
        const r = await apply(supabase, 'board_packet', p.id, evaluate('board_packet', p, now, cfg), { wakeReason: 'board_packet_deadline', now, lookaheadHours: cfg.lookaheadHours });
        r.created = !before.length && r.changed && r.outcome !== 'resolved';
        tally(r); seen.add(`board_packet:${p.id}`);
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] board packet failed', JSON.stringify({ packet: p.id, error: e.message })); }
    }
  }

  // 5. re-check open subject objectives so finished work resolves
  if (budget > 0) {
    const open = await q(supabase.from('objectives').select('*').in('status', OPEN).not('subject_key', 'is', null).order('last_activity_at', { ascending: true }).limit(budget + 1));
    for (const o of open) {
      if (seen.has(o.subject_key)) continue;
      if (budget <= 0) { s.bounded = true; s.deferred += 1; continue; }
      const sk = parseSubjectKey(o.subject_key); if (!sk) continue;
      take(1); s.candidates += 1;
      try {
        const row = await loadSubject(supabase, sk.kind, sk.id);
        const c = row ? evaluate(sk.kind, row, now, cfg) : { action: 'clear', outcome: 'resolved', reason: 'source record no longer exists' };
        tally(await apply(supabase, sk.kind, sk.id, c, { wakeReason: 'sweep_recheck', now, lookaheadHours: cfg.lookaheadHours }));
        seen.add(o.subject_key);
      } catch (e) { s.failed += 1; console.warn('[manager.sweep] recheck failed', JSON.stringify({ objective: o.id, error: e.message })); }
    }
  }

  // a per-item failure is recorded on that wake/objective; the run itself completed (ok stays true)
  return s;
}

module.exports = { runSweep, config, dependencyMet, DEFAULTS };
