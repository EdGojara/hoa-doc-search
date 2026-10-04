// ============================================================================
// lib/manager/state.js  (Issue #27 Phase 1) — Amanda-owned objective state
// ----------------------------------------------------------------------------
// Applies a deterministic classification (lib/manager/subjects.js) to the
// existing operator spine (objectives + objective_events, migration 399).
// One OPEN objective per subject (uq_objectives_open_subject); the state hash
// is the dirty-check, so an unchanged subject writes NOTHING (no update, no
// event). Writes only objectives / objective_events. No model, no business
// action, no email.
// ============================================================================
const { subjectKey, stateHash, dueCondition } = require('./subjects');

const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const ACTOR = 'amanda';
const nowIso = () => new Date().toISOString();

async function q(p) { const { data, error } = await p; if (error) throw error; return data; }

async function openFor(supabase, key) {
  const rows = await q(supabase.from('objectives').select('*').eq('subject_key', key).in('status', OPEN).limit(1));
  return rows && rows.length ? rows[0] : null;
}
async function event(supabase, objectiveId, kind, summary) {
  await q(supabase.from('objective_events').insert({ objective_id: objectiveId, actor: ACTOR, kind, summary: String(summary || '').slice(0, 1000) }));
}

const classOf = (c) => ({ action: c.action, autonomy_class: c.autonomy_class || null, priority: c.priority || null, blocked_reason: c.blocked_reason || null });

// apply(supabase, kind, id, classification, { wakeReason, now })
// -> { outcome, objective_id, changed }
async function apply(supabase, kind, id, c, { wakeReason = null, now = Date.now(), lookaheadHours = 24 } = {}) {
  const key = subjectKey(kind, id);
  let existing = await openFor(supabase, key);

  if (c.action === 'clear') {
    if (!existing) return { outcome: c.outcome === 'resolved' ? 'no_action' : c.outcome, objective_id: null, changed: false };
    const wasBlocked = existing.autonomy_class === 'BLOCK';
    await q(supabase.from('objectives').update({
      status: 'resolved', closed_at: nowIso(), closed_reason: c.reason || 'cleared', autonomy_class: c.autonomy_class || existing.autonomy_class,
      blocked_reason: null, depends_on: null, wake_reason: wakeReason, state_hash: null, updated_at: nowIso(), last_activity_at: nowIso(),
    }).eq('id', existing.id));
    await event(supabase, existing.id, 'closed', `${wasBlocked ? 'Dependency satisfied. ' : ''}Resolved: ${c.reason || 'cleared'}`);
    return { outcome: 'resolved', objective_id: existing.id, changed: true };
  }

  const due = dueCondition(c.next_action_due || null, now, lookaheadHours);
  const hash = stateHash({ subject: c.basis, classification: classOf(c), due, status: 'open' });
  const fields = {
    title: c.title, objective_type: c.objective_type, owner_kind: c.owner_kind, owner_key: c.owner_key, accountable_persona: ACTOR, owner_persona: ACTOR,
    domain: c.domain, priority: c.priority, autonomy_class: c.autonomy_class, blocked_reason: c.blocked_reason || null, depends_on: c.depends_on || null,
    subject_key: key, subject_refs: c.subject_refs || null, needs_reasoning: false, next_action: c.next_action || null,
    next_action_due: c.next_action_due || null, community_id: c.community_id || null, state_hash: hash,
  };

  if (!existing) {
    const ins = await supabase.from('objectives').insert({ ...fields, status: 'open', goal: c.reason || null, wake_reason: wakeReason, last_activity_at: nowIso() }).select('id').single();
    if (ins.error) {
      // lost a race to the open-subject unique index: reattach to the winner
      if (String(ins.error.code) === '23505') existing = await openFor(supabase, key);
      if (!existing) throw ins.error;
    } else {
      await event(supabase, ins.data.id, 'opened', `${c.autonomy_class}: ${c.title}${c.blocked_reason ? ` (blocked: ${c.blocked_reason})` : ''}`);
      return { outcome: c.outcome, objective_id: ins.data.id, changed: true };
    }
  }

  if (existing.state_hash === hash) return { outcome: 'unchanged', objective_id: existing.id, changed: false };
  const unblocked = existing.autonomy_class === 'BLOCK' && c.autonomy_class !== 'BLOCK';
  await q(supabase.from('objectives').update({ ...fields, status: existing.status, wake_reason: wakeReason, updated_at: nowIso(), last_activity_at: nowIso() }).eq('id', existing.id));
  const summary = unblocked ? `Dependency satisfied; now ${c.autonomy_class}: ${c.title}`
    : existing.autonomy_class !== c.autonomy_class ? `${existing.autonomy_class || 'unclassified'} -> ${c.autonomy_class}: ${c.title}`
    : due ? `${due === 'overdue' ? 'Overdue' : 'Due within a day'}: ${c.title}`
    : `Updated (${c.reason || 'state changed'}): ${c.title}`;
  await event(supabase, existing.id, existing.subject_key ? 'status_change' : 'reattached', summary);
  return { outcome: c.outcome, objective_id: existing.id, changed: true };
}

// Due/overdue marking for open objectives opened ELSEWHERE (no subject_key).
// Subject objectives carry the due condition in apply()'s hash and are
// re-evaluated through their subject instead, so the two never fight over
// state_hash. One event per change of due condition; unchanged -> no writes.
async function markDue(supabase, o, { now = Date.now(), lookaheadHours = 24 } = {}) {
  if (o.subject_key) return { changed: false, skipped: 'subject' };
  const due = dueCondition(o.next_action_due, now, lookaheadHours);
  if (!due) return { changed: false };
  const hash = stateHash({ subject: o.subject_key ? 'subject' : null, classification: { autonomy_class: o.autonomy_class || null, priority: o.priority || null }, due, status: o.status, ref: o.next_action_due });
  if (o.state_hash === hash) return { changed: false };
  await q(supabase.from('objectives').update({ state_hash: hash, wake_reason: due === 'overdue' ? 'next_action_overdue' : 'next_action_due_soon', updated_at: nowIso() }).eq('id', o.id));
  await event(supabase, o.id, 'note', `${due === 'overdue' ? 'Overdue' : 'Due within a day'}: ${o.next_action || o.title}`);
  return { changed: true, due };
}

module.exports = { apply, markDue, openFor, OPEN };
