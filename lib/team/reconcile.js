// ============================================================================
// lib/team/reconcile.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The re-entrant reconciliation loop — the operator's heartbeat. An objective is
// a durable thing Trusted is responsible for resolving. Events arrive (often out
// of order), state changes, and the loop re-asks: "given everything I know now,
// is this resolved? if not, what — if anything — should happen next?" It answers
// with one verdict: NO_ACTION | WAIT | REQUEST_INFORMATION | PROPOSE_ACTION |
// ESCALATE | CLOSE, and records the full rationale.
//
// DARK: nothing is executed. PROPOSE_ACTION stores what Trusted WOULD do so it
// can be compared to what the human does (the exception-rate metric).
//
// COST + NO-LOOP GUARDS (first-class, per Ed):
//   - idempotent: one decision per (objective, triggering event); re-runs skip.
//   - dirty-check: NO model call unless there is genuinely new evidence/state.
//   - cheap verdicts: "waiting, nothing new" resolves deterministically.
//   - min re-judge interval per objective; hard cap on reconsiders -> escalate.
//   - drive tick capped; fail-safe -> ESCALATE (never a runaway loop).
// ============================================================================

const O = require('./objectives');

const MIN_REJUDGE_MS = 10 * 60 * 1000;   // don't re-judge the same objective within 10 min unless new evidence
const MAX_DECISIONS = 25;                // backstop: after this many reconsiders, force a human
const DRIVE_TICK_MAX = 25;               // objectives touched per drive run
const VERDICTS = ['NO_ACTION', 'WAIT', 'REQUEST_INFORMATION', 'PROPOSE_ACTION', 'ESCALATE', 'CLOSE'];

function _missing(err) { const m = `${err && err.message || ''} ${err && err.code || ''}`; return /could not find|does not exist|42P01|PGRST20[45]|schema cache/i.test(m); }

async function _lastDecision(supabase, objectiveId) {
  const { data } = await supabase.from('objective_decisions').select('*').eq('objective_id', objectiveId).order('created_at', { ascending: false }).limit(1);
  return data && data.length ? data[0] : null;
}
async function _decisionCount(supabase, objectiveId) {
  const { count } = await supabase.from('objective_decisions').select('id', { count: 'exact', head: true }).eq('objective_id', objectiveId);
  return count || 0;
}
async function _decisionExistsFor(supabase, objectiveId, triggeringRef) {
  if (!triggeringRef || triggeringRef === 'drive_tick' || triggeringRef === 'manual') return false;
  const { data } = await supabase.from('objective_decisions').select('id').eq('objective_id', objectiveId).eq('triggering_event_ref', triggeringRef).limit(1);
  return !!(data && data.length);
}
async function _newEvidenceSince(supabase, objectiveId, sinceIso) {
  if (!sinceIso) return true;
  const { data } = await supabase.from('objective_events').select('id')
    .eq('objective_id', objectiveId).gt('at', sinceIso).in('kind', ['message_in', 'reattached', 'status_change', 'note']).limit(1);
  return !!(data && data.length);
}

async function recordDecision(supabase, objectiveId, d) {
  try {
    const row = {
      objective_id: objectiveId, community_id: d.communityId || null,
      triggering_event_ref: d.triggeringEventRef || 'manual',
      verdict: VERDICTS.includes(d.verdict) ? d.verdict : 'ESCALATE',
      confidence: d.confidence || null, reason: d.reason || null,
      evidence: d.evidence || {}, rules_consulted: d.rulesConsulted || [],
      proposed_capability: d.proposedCapability || null, proposed_action_detail: d.proposedActionDetail || null,
      authorization_boundary: !!d.authorizationBoundary, authorization_reason: d.authorizationReason || null,
      executed: false, decided_by: d.decidedBy || null,
    };
    const { data, error } = await supabase.from('objective_decisions').insert(row).select('*').single();
    if (error) { if (_missing(error)) return null; throw error; }
    return data;
  } catch (e) { console.warn('[reconcile] recordDecision failed:', e.message); return null; }
}

// The judgment layer. Bounded by construction: reserved/irreversible or
// harm/legal or low-confidence always ESCALATE and never propose-to-execute.
// Injected for tests. Fail-safe: any problem -> ESCALATE to a human.
const CAPABILITIES = `Available capabilities the operator may PROPOSE (dark — never executed here):
- draft_reply: draft a message to the resident/board (safe, human reviews before send)
- draft_vendor_outreach: draft a service request to the community's vendor (safe, human reviews)
- request_document: ask the resident/party for a missing document or photo (safe)
- log_note: record an internal note on the objective (safe)
RESERVED capabilities (must ALWAYS be ESCALATE, never PROPOSE_ACTION): waive/adjust a balance, approve/deny an ACC request, generate or send a §209 / certified / fine letter, file or refer a foreclosure or lawsuit, move or commit money, release a lien, delete a sealed record.`;

async function defaultJudge(objective, events, { triggeringSummary } = {}) {
  const recent = (events || []).slice(-12).map((e) => `- [${e.actor || 'system'}] ${e.summary || e.kind}`).join('\n');
  const system = `You are the reconciliation judgment layer for Trusted, an AI operator for HOA management. You are given ONE objective's current state and history and must return a single verdict about what should happen next. You are bounded: you propose, you never execute. Anything reserved (see the list), any sign of imminent harm, any legal significance, or genuine uncertainty must be ESCALATE — not PROPOSE_ACTION. Prefer the cheapest correct verdict: if nothing needs to happen, say NO_ACTION or WAIT.

${CAPABILITIES}

Return ONLY compact JSON:
{"verdict":"NO_ACTION|WAIT|REQUEST_INFORMATION|PROPOSE_ACTION|ESCALATE|CLOSE","confidence":"high|medium|low","reason":"one sentence","rules_consulted":["..."],"proposed_capability":"one of the safe capability names or null","proposed_action_detail":"what you would do, or null","authorization_boundary":true|false,"authorization_reason":"why a human must authorize, or null"}`;
  const user = `OBJECTIVE\nGoal: ${objective.goal || objective.title}\nType: ${objective.objective_type}\nStatus: ${objective.status}\nCurrent planned next step: ${objective.next_action || '(none)'}\n\nHISTORY (most recent last):\n${recent || '(none)'}\n\nWHAT TRIGGERED THIS EVALUATION: ${triggeringSummary || 'a periodic review'}\n\nGiven everything known now, is this objective resolved? If not, what should happen next?`;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 500, system, messages: [{ role: 'user', content: user }] });
    const txt = (resp.content || []).map((b) => b.text || '').join('');
    const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    if (!VERDICTS.includes(j.verdict)) j.verdict = 'ESCALATE';
    // Belt-and-suspenders: a reserved capability can never be PROPOSE_ACTION.
    if (j.verdict === 'PROPOSE_ACTION' && j.authorization_boundary) j.verdict = 'ESCALATE';
    return j;
  } catch (e) {
    return { verdict: 'ESCALATE', confidence: 'low', reason: `judgment unavailable (${e.message}); routed to a human`, rules_consulted: [], proposed_capability: null, proposed_action_detail: null, authorization_boundary: true, authorization_reason: 'fail-safe' };
  }
}

// Reconcile ONE objective. Cost-guarded: skips the model unless there's genuinely
// something new. Records a decision (dark). Never executes.
async function reconcileObjective(supabase, objective, { triggeringEventRef = 'manual', triggeringSummary, force = false, judge = defaultJudge } = {}) {
  if (!supabase || !objective || !objective.id) return null;
  const objId = objective.id;
  try {
    // 1) idempotency — a specific inbound event is judged once.
    if (await _decisionExistsFor(supabase, objId, triggeringEventRef)) return { skipped: 'already_decided', objectiveId: objId };

    const last = await _lastDecision(supabase, objId);

    // 2) backstop — stop churning, hand to a human.
    const count = await _decisionCount(supabase, objId);
    if (count >= MAX_DECISIONS) {
      if (last && last.verdict === 'ESCALATE') return { skipped: 'capped_escalated', objectiveId: objId };
      const d = await recordDecision(supabase, objId, { communityId: objective.community_id, triggeringEventRef, verdict: 'ESCALATE', confidence: 'low', reason: `reconsidered ${count} times without resolution; a human should take this`, authorizationBoundary: true, authorizationReason: 'reconsider cap', decidedBy: objective.owner_persona });
      return { decision: d, objectiveId: objId };
    }

    // 3) dirty-check — do NOT spend a model call if nothing changed.
    if (!force && last) {
      const withinCooloff = (Date.now() - new Date(last.created_at).getTime()) < MIN_REJUDGE_MS;
      const dirty = await _newEvidenceSince(supabase, objId, last.created_at);
      if (!dirty && (withinCooloff || triggeringEventRef === 'drive_tick')) {
        return { skipped: 'no_change', objectiveId: objId, lastVerdict: last.verdict };
      }
    }

    // 4) cheap deterministic verdict — waiting with nothing new needs no model.
    if (['waiting_resident', 'waiting_third_party'].includes(objective.status) && last && !(await _newEvidenceSince(supabase, objId, last.created_at)) && triggeringEventRef !== 'manual') {
      const d = await recordDecision(supabase, objId, { communityId: objective.community_id, triggeringEventRef, verdict: 'WAIT', confidence: 'high', reason: `still ${objective.status}, no new evidence`, decidedBy: objective.owner_persona });
      return { decision: d, objectiveId: objId, cheap: true };
    }

    // 5) the judgment call (the only place we spend a model call).
    const events = await O.objectiveEvents(supabase, objId);
    const j = await judge(objective, events, { triggeringSummary });
    const d = await recordDecision(supabase, objId, {
      communityId: objective.community_id, triggeringEventRef,
      verdict: j.verdict, confidence: j.confidence, reason: j.reason,
      evidence: { history_len: events.length, status: objective.status },
      rulesConsulted: j.rules_consulted || [], proposedCapability: j.proposed_capability || null,
      proposedActionDetail: j.proposed_action_detail || null,
      authorizationBoundary: !!j.authorization_boundary, authorizationReason: j.authorization_reason || null,
      decidedBy: objective.owner_persona,
    });
    // Bookkeeping only (dark): record the proposed next step; do NOT change status or execute.
    if (j.proposed_action_detail) { try { await O.advanceObjective(supabase, objId, { nextAction: j.proposed_action_detail, actor: objective.owner_persona || 'system' }); } catch (_) {} }
    return { decision: d, objectiveId: objId };
  } catch (e) { console.warn('[reconcile] reconcileObjective failed:', e.message); return null; }
}

// An inbound event: attach to the right objective(s) or open one, then reconcile
// the affected objectives. Attachment is the hard part — low confidence must NOT
// guess; it stays unresolved for a human rather than contaminate the wrong case.
async function reconcileForEvent(supabase, event = {}, { judge = defaultJudge } = {}) {
  const { messageId, communityId, senderEmail, contactId, propertyId, subject, summary } = event;
  const affected = [];
  try {
    const open = await O.findOpenObjectiveFor(supabase, { residentEmail: senderEmail, contactId, propertyId });
    let attachConfidence = null;
    if (open) attachConfidence = senderEmail ? 'high' : (contactId ? 'medium' : 'low');

    if (open && attachConfidence !== 'low') {
      await O.appendEvent(supabase, open.id, { actor: 'resident', kind: 'message_in', summary: summary || subject || 'new message', refMessageId: messageId });
      affected.push(open);
    } else if (!open) {
      // No existing objective — open one (bounded: only when we have a community).
      if (communityId) {
        const created = await O.openObjective(supabase, { communityId, title: subject || 'Homeowner issue', goal: summary || subject || 'Resolve homeowner issue', ownerPersona: 'claire', residentEmail: senderEmail, contactId, propertyId, sourceMessageId: messageId });
        if (created) affected.push(created);
      }
    } else {
      // open found but low confidence -> do NOT attach; leave for a human.
      return { attached: [], unresolved: true, reason: 'ambiguous match — held for a human rather than risk the wrong case' };
    }

    const decisions = [];
    for (const o of affected) {
      const r = await reconcileObjective(supabase, o, { triggeringEventRef: messageId || 'manual', triggeringSummary: summary || subject, judge });
      if (r) decisions.push(r);
    }
    return { attached: affected.map((o) => o.id), decisions };
  } catch (e) { console.warn('[reconcile] reconcileForEvent failed:', e.message); return { attached: [], error: e.message }; }
}

// The drive tick: revisit stalled objectives (due/quiet) and reconsider them.
// Capped and cost-guarded — most will short-circuit on the dirty-check.
async function driveTick(supabase, { communityId, judge = defaultJudge, max = DRIVE_TICK_MAX } = {}) {
  try {
    const stalled = (await O.findStalled(supabase, { communityId })).slice(0, max);
    const out = { considered: stalled.length, decided: 0, skipped: 0, results: [] };
    for (const o of stalled) {
      const r = await reconcileObjective(supabase, o, { triggeringEventRef: 'drive_tick', triggeringSummary: 'periodic review of a stalled objective', judge });
      if (r && r.decision) out.decided++; else out.skipped++;
      if (r) out.results.push(r);
    }
    return out;
  } catch (e) { console.warn('[reconcile] driveTick failed:', e.message); return { considered: 0, decided: 0, skipped: 0, error: e.message }; }
}

module.exports = { reconcileObjective, reconcileForEvent, driveTick, defaultJudge, recordDecision, VERDICTS, MAX_DECISIONS, MIN_REJUDGE_MS, DRIVE_TICK_MAX };
