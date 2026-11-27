// ============================================================================
// lib/amanda/dispatch.js  (Ed 2026-11-27: conversational assignments get carried out)
// ----------------------------------------------------------------------------
// "When I instruct Amanda to do something during a conversation, I expect her to
// carry it out or assign it to the appropriate teammate and oversee completion. A
// work item sitting in a queue is not completion."
//
// handleRequest (lib/amanda/request.js) opens the objective; this routes it AT ONCE
// (same request, no polling) to an EXISTING runner, records what happened on the
// objective's history, and sets its status honestly. Lanes, all existing code:
//
//   email     "email / write to / let X know / reply to ..."  -> lib/amanda/email_ask
//             (Tessa's request runner + Amanda's drafter): draft STAGED in Amanda's
//             outbox for review. Questions come back instead of guesses.
//   vendor    a service request with a recognizable trade, at a known community
//             -> operator_actions.draft_vendor_outreach (safe: queues a needs_review
//             draft to the vendor this community actually uses; a human sends it).
//   none      no automatic runner: assigned to the teammate on Today with the gap
//             stated, and Amanda says so. Never presented as done.
//
// NOTHING here sends, pays, posts, approves or decides. Decision verbs never reach
// this file (handleRequest refuses them deterministically; approvals stay in the
// Owner Authorization Service, in-app). Completion is reconciled on read
// (reconcile below): a staged draft that was SENT resolves the objective; a
// discarded one reopens it for Amanda.
// ============================================================================

const EMAIL_RE = /\b(e-?mail|write (?:to|a note|an? (?:email|message))|send (?:a |an )?(?:note|message|email|reply)|reply to|respond to|let\s+\w+(?:\s+\w+)?\s+know|follow up with|reach out to|tell\s+\w+(?:\s+\w+)?\s+(?:that|about))\b/i;
const VENDOR_RE = /\b(bid|bids|quote|quotes|estimate|repair|fix|service call|send (?:someone|a vendor|a tech|a plumber|an electrician)|get (?:someone|a vendor) out|have (?:the |a )?\w+ (?:come|look))\b/i;

/** PURE: which lane a request belongs in. */
function laneFor(text, { community } = {}) {
  const t = String(text || '');
  if (EMAIL_RE.test(t)) return 'email';
  if (community && VENDOR_RE.test(t)) {
    const { inferServiceCategory } = require('../team/operator_actions');
    if (inferServiceCategory(t)) return 'vendor';
  }
  return 'none';
}

async function note(supabase, objectiveId, actor, kind, summary) {
  const { error } = await supabase.from('objective_events').insert({ objective_id: objectiveId, actor, kind, summary: String(summary || '').slice(0, 1000) });
  if (error) console.warn('[amanda.dispatch] objective event failed', JSON.stringify({ objective_id: objectiveId, kind, error: error.message }));
  return !error;
}
async function setState(supabase, objectiveId, patch) {
  const { error } = await supabase.from('objectives').update({ ...patch, updated_at: new Date().toISOString(), last_activity_at: new Date().toISOString() }).eq('id', objectiveId);
  if (error) console.warn('[amanda.dispatch] objective update failed', JSON.stringify({ objective_id: objectiveId, error: error.message }));
  return !error;
}
async function stampDispatch(supabase, objective, dispatch) {
  const { data, error } = await supabase.from('objectives').select('subject_refs').eq('id', objective.id).maybeSingle();
  if (error) { console.warn('[amanda.dispatch] refs read failed', error.message); return; }
  const refs = (data && data.subject_refs && typeof data.subject_refs === 'object') ? data.subject_refs : {};
  await setState(supabase, objective.id, { subject_refs: { ...refs, dispatch } });
}

/**
 * Route a newly opened objective to the runner that can do it. Never throws; returns
 * { lane, status, summary, draft_id?, teammate } for Amanda to say honestly.
 */
async function dispatchObjective(supabase, { objective, text, actor, community, teammate }, deps = {}) {
  const lane = laneFor(text, { community });
  const who = teammate || 'amanda';
  try {
    if (lane === 'email') {
      const stage = deps.stageEmailRequest || require('./email_ask').stageEmailRequest;
      const r = await stage(supabase, text, { createdBy: actor.email, createdByName: actor.name || actor.email });
      if (r.staged && r.draft && r.draft.id) {
        const to = (r.to || []).map((p) => p.name || p.email).join(', ');
        await note(supabase, objective.id, 'amanda', 'message_out', `Drafted "${r.draft.subject}" to ${to}; staged in Amanda's outbox for review (draft ${r.draft.id}). Nothing sent.`);
        await stampDispatch(supabase, objective, { lane, draft_id: r.draft.id, at: new Date().toISOString() });
        await setState(supabase, objective.id, { status: 'waiting_human', next_action: `Review and send the drafted email to ${to} (Amanda's outbox).` });
        return { lane, status: 'draft_staged', teammate: 'amanda', draft_id: r.draft.id, summary: `The email to ${to} is drafted and waiting in my outbox for your review. Nothing has been sent.` };
      }
      const q = (r.questions || []).map((x) => (typeof x === 'string' ? x : x.question || JSON.stringify(x))).join(' ');
      await note(supabase, objective.id, 'amanda', 'note', `Email not drafted: ${r.reply}${q ? ` Questions: ${q}` : ''}`);
      await setState(supabase, objective.id, { status: 'waiting_human', next_action: q ? `Answer: ${q}`.slice(0, 300) : r.reply });
      return { lane, status: 'needs_answer', teammate: 'amanda', summary: q ? `${r.reply} ${q}` : r.reply };
    }
    if (lane === 'vendor') {
      const OA = require('../team/operator_actions');
      const run = deps.runAction || OA.runAction;
      const res = await run(OA.draft_vendor_outreach, { issue: text, communityName: community.name }, { supabase, communityId: community.id, persona: 'amanda' }, { autonomy: 'execute' });
      const r = res && res.result ? res.result : res;
      if (r && r.status === 'queued' && r.draft_id) {
        await note(supabase, objective.id, 'amanda', 'message_out', `Drafted a ${r.category} service request to ${r.vendor} (${r.source}); held for review (draft ${r.draft_id}). Nothing sent.`);
        await stampDispatch(supabase, objective, { lane, draft_id: r.draft_id, at: new Date().toISOString() });
        await setState(supabase, objective.id, { status: 'waiting_human', next_action: `Review and send the service request to ${r.vendor}.` });
        return { lane, status: 'draft_staged', teammate: 'amanda', draft_id: r.draft_id, summary: `I drafted the request to ${r.vendor}, the ${r.category} vendor ${community.name} uses. It is waiting for your review; nothing has been sent.` };
      }
      const reason = (r && (r.reason || r.error)) || 'no vendor draft was produced';
      await note(supabase, objective.id, 'amanda', 'note', `Vendor request not drafted: ${reason}`);
      await setState(supabase, objective.id, { status: 'waiting_human', next_action: `Pick the vendor: ${reason}`.slice(0, 300) });
      return { lane, status: 'needs_person', teammate: 'amanda', summary: `I could not pick the vendor on my own: ${reason}.` };
    }
    // No automatic runner for this kind of work yet.
    await note(supabase, objective.id, 'amanda', 'note', `Assigned to ${who}. No automatic step exists for this yet, so a person completes it; Amanda follows it on Today.`);
    return { lane, status: 'assigned', teammate: who, summary: `I've put it with ${who === 'amanda' ? 'me' : who} and I'm tracking it, but nobody on the team can carry this kind of task out automatically yet, so it needs a person.` };
  } catch (e) {
    console.error('[amanda.dispatch] failed', JSON.stringify({ objective_id: objective.id, lane, error: e.message }));
    await note(supabase, objective.id, 'amanda', 'note', `Dispatch failed (${lane}): ${String(e.message).slice(0, 300)}`);
    return { lane, status: 'failed', teammate: who, summary: 'I tracked it, but the step to carry it out failed, so nothing was prepared yet.' };
  }
}

/**
 * Completion, reconciled on read (no polling): objectives this dispatcher staged a draft
 * for are resolved once the draft was SENT, and reopened if it was DISCARDED.
 * Returns { resolved: [titles], reopened: [titles] }.
 */
async function reconcile(supabase, { limit = 50 } = {}) {
  const out = { resolved: [], reopened: [] };
  const { data: objs, error } = await supabase.from('objectives').select('id, title, subject_refs').eq('accountable_persona', 'amanda').eq('status', 'waiting_human')
    .not('subject_refs->dispatch->>draft_id', 'is', null).order('updated_at', { ascending: false }).limit(limit);
  if (error) { console.warn('[amanda.dispatch] reconcile read failed', error.message); return { ...out, error: error.message }; }
  const ids = (objs || []).map((o) => o.subject_refs.dispatch.draft_id).filter(Boolean);
  if (!ids.length) return out;
  const { data: drafts, error: dErr } = await supabase.from('outbound_email_drafts').select('id, status, sent_at').in('id', ids);
  if (dErr) { console.warn('[amanda.dispatch] reconcile drafts failed', dErr.message); return { ...out, error: dErr.message }; }
  const byId = Object.fromEntries((drafts || []).map((d) => [d.id, d]));
  const O = require('../team/objectives');
  for (const o of objs) {
    const d = byId[o.subject_refs.dispatch.draft_id];
    if (!d) continue;
    if (d.status === 'sent') {
      // eslint-disable-next-line no-await-in-loop
      await O.closeObjective(supabase, o.id, { reason: `Done: the prepared email was sent${d.sent_at ? ` ${String(d.sent_at).slice(0, 10)}` : ''}.`, actor: 'amanda' });
      out.resolved.push(o.title);
    } else if (d.status === 'discarded') {
      // eslint-disable-next-line no-await-in-loop
      await note(supabase, o.id, 'amanda', 'note', 'The prepared draft was discarded; reopened for Amanda.');
      // eslint-disable-next-line no-await-in-loop
      await setState(supabase, o.id, { status: 'open', next_action: 'Draft was discarded; ask Ed how he wants this handled.' });
      out.reopened.push(o.title);
    }
  }
  return out;
}

module.exports = { laneFor, dispatchObjective, reconcile };
