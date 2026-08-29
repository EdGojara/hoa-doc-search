// ============================================================================
// lib/team/objectives.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The operator spine in code. An objective is a unit of work-to-an-outcome the
// team OWNS and drives — not a one-shot reply. This module is the deterministic
// infrastructure the agents reason over: open an objective, reattach new mail to
// the right one, log the timeline, set the next action, find what's gone stale,
// and close when the outcome is reached. The persona supplies the judgment
// (what the next action should be); this supplies the memory and the boundaries.
//
// Degrades gracefully before migration 399 (returns nulls / empty) so nothing in
// the reply path breaks if the spine isn't deployed yet.
// ============================================================================

const OPEN_STATUSES = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const MGMT = '00000000-0000-0000-0000-000000000001';

function _missing(err) {
  const m = `${err && err.message || ''} ${err && err.code || ''}`;
  return /could not find|does not exist|42P01|PGRST20[45]|schema cache/i.test(m);
}

// The open objective a new inbound belongs to, if any — reattachment. Keys on
// the sender's email first (most reliable across threads), then the resolved
// contact, then the property. Returns the most recently active open objective.
async function findOpenObjectiveFor(supabase, { residentEmail, contactId, propertyId } = {}) {
  if (!supabase) return null;
  const tryQuery = async (col, val) => {
    if (!val) return null;
    let q = supabase.from('objectives').select('*').in('status', OPEN_STATUSES)
      .order('last_activity_at', { ascending: false }).limit(1);
    q = col === 'resident_email' ? q.ilike(col, val) : q.eq(col, val);
    const { data, error } = await q;
    if (error) { if (_missing(error)) return { _noTable: true }; throw error; }
    return data && data.length ? data[0] : null;
  };
  try {
    for (const [col, val] of [['resident_email', residentEmail], ['resident_contact_id', contactId], ['resident_property_id', propertyId]]) {
      const r = await tryQuery(col, val);
      if (r && r._noTable) return null;
      if (r) return r;
    }
    return null;
  } catch (e) { console.warn('[objectives] findOpen failed:', e.message); return null; }
}

async function appendEvent(supabase, objectiveId, { actor, kind, summary, refMessageId } = {}) {
  if (!supabase || !objectiveId) return;
  try {
    await supabase.from('objective_events').insert({
      objective_id: objectiveId, actor: actor || 'system', kind: kind || 'note',
      summary: summary || null, ref_message_id: refMessageId || null,
    });
    await supabase.from('objectives').update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', objectiveId);
  } catch (e) { if (!_missing(e)) console.warn('[objectives] appendEvent failed:', e.message); }
}

// Open a new objective. Records an 'opened' event. Returns the row (or null).
async function openObjective(supabase, {
  communityId, title, goal, objectiveType = 'homeowner_issue', ownerPersona,
  residentEmail, contactId, propertyId, conversationId, nextAction, nextActionDue, sourceMessageId, status = 'open',
} = {}) {
  if (!supabase || !title) return null;
  try {
    const row = {
      management_company_id: MGMT, community_id: communityId || null,
      title, goal: goal || null, objective_type: objectiveType, owner_persona: ownerPersona || null, status,
      resident_email: residentEmail || null, resident_contact_id: contactId || null, resident_property_id: propertyId || null,
      conversation_ids: conversationId ? [conversationId] : [],
      next_action: nextAction || null, next_action_due: nextActionDue || null,
      source_message_id: sourceMessageId || null, last_activity_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('objectives').insert(row).select('*').single();
    if (error) { if (_missing(error)) return null; throw error; }
    await appendEvent(supabase, data.id, { actor: ownerPersona || 'system', kind: 'opened', summary: goal || title, refMessageId: sourceMessageId });
    return data;
  } catch (e) { console.warn('[objectives] open failed:', e.message); return null; }
}

// Update the working fields (status / next action) and log it.
async function advanceObjective(supabase, objectiveId, { status, nextAction, nextActionDue, actor, note } = {}) {
  if (!supabase || !objectiveId) return null;
  try {
    const patch = { updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString() };
    if (status) patch.status = status;
    if (nextAction !== undefined) patch.next_action = nextAction;
    if (nextActionDue !== undefined) patch.next_action_due = nextActionDue;
    const { data, error } = await supabase.from('objectives').update(patch).eq('id', objectiveId).select('*').single();
    if (error) { if (_missing(error)) return null; throw error; }
    if (status) await appendEvent(supabase, objectiveId, { actor: actor || 'system', kind: 'status_change', summary: `status -> ${status}${note ? ': ' + note : ''}` });
    if (nextAction) await appendEvent(supabase, objectiveId, { actor: actor || 'system', kind: 'next_action', summary: nextAction });
    return data;
  } catch (e) { console.warn('[objectives] advance failed:', e.message); return null; }
}

async function closeObjective(supabase, objectiveId, { reason, actor } = {}) {
  if (!supabase || !objectiveId) return null;
  try {
    const { data, error } = await supabase.from('objectives')
      .update({ status: 'resolved', closed_at: new Date().toISOString(), closed_reason: reason || null, updated_at: new Date().toISOString() })
      .eq('id', objectiveId).select('*').single();
    if (error) { if (_missing(error)) return null; throw error; }
    await appendEvent(supabase, objectiveId, { actor: actor || 'system', kind: 'closed', summary: reason || 'resolved' });
    return data;
  } catch (e) { console.warn('[objectives] close failed:', e.message); return null; }
}

// The timeline for one objective (append-only history).
async function objectiveEvents(supabase, objectiveId, limit = 50) {
  if (!supabase || !objectiveId) return [];
  try {
    const { data, error } = await supabase.from('objective_events').select('*').eq('objective_id', objectiveId).order('at', { ascending: true }).limit(limit);
    if (error) return [];
    return data || [];
  } catch (_) { return []; }
}

// The anti-ghosting query: open objectives whose next action is due/overdue, or
// that have gone quiet past `staleHours` — the ones the drive loop must revisit
// so nothing sits silent the way human staff let it.
async function findStalled(supabase, { staleHours = 72, communityId } = {}) {
  if (!supabase) return [];
  try {
    let q = supabase.from('objectives').select('*').in('status', OPEN_STATUSES).order('last_activity_at', { ascending: true }).limit(200);
    if (communityId) q = q.eq('community_id', communityId);
    const { data, error } = await q;
    if (error) { if (_missing(error)) return []; throw error; }
    const now = Date.now();
    const staleMs = staleHours * 3600 * 1000;
    return (data || []).filter((o) => {
      const dueOver = o.next_action_due && new Date(o.next_action_due).getTime() < now;
      const quiet = o.last_activity_at && (now - new Date(o.last_activity_at).getTime()) > staleMs;
      return dueOver || quiet;
    });
  } catch (e) { console.warn('[objectives] findStalled failed:', e.message); return []; }
}

// A compact state block for injecting an open objective into a drafter's context,
// so a reply reflects the CASE, not just the message.
function objectiveContextBlock(objective, events = []) {
  if (!objective) return '';
  const recent = events.slice(-8).map((e) => `- [${e.actor || 'system'}] ${e.summary || e.kind}`).join('\n');
  return `OPEN OBJECTIVE / CASE THIS MESSAGE BELONGS TO (you are actively working this to an outcome, not answering in a vacuum):\n`
    + `Goal: ${objective.goal || objective.title}\n`
    + `Status: ${objective.status}${objective.next_action ? ` | Planned next step: ${objective.next_action}` : ''}\n`
    + (recent ? `Recent history:\n${recent}\n` : '');
}

module.exports = {
  OPEN_STATUSES, findOpenObjectiveFor, openObjective, advanceObjective, closeObjective,
  appendEvent, objectiveEvents, findStalled, objectiveContextBlock,
};
