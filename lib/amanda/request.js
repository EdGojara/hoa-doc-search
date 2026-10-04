// ============================================================================
// lib/amanda/request.js  (Issue #29 Phase 2A) — the shared Amanda request contract
// ----------------------------------------------------------------------------
// handleRequest({ channel, actor, text, community_id?, refs?, objective_id? }, deps)
//
// One contract every Amanda door will call (Phase 2A wires only the in-app
// composer on Today). Text in, PROPOSALS out. Nothing here executes a domain
// action: no approve / reject / finalize / release / pay / send / fine.
//
// Intent (returned on every result):
//   query    "What still needs me today?"  -> answer from current state.
//            Reads only. Never creates an objective.
//   work     "Get Canyon Gate ready for Monday." -> attach to the matching open
//            objective or open ONE bounded Amanda objective (#27 spine, one open
//            objective per subject_key), log the request + Amanda's proposal to
//            its timeline, return plan / specialists / next dependency.
//   decision "Approve this bill." -> conversation is never authority. Returns
//            what is being asked, that it is not allowed from here, the floor
//            that applies and the exact controlled destination. Deterministic:
//            NO model call, no objective, no action.
//
// Cost: deterministic validation, intent screening and context first; at most
// ONE routed model call per request (workflow team.amanda_request, attributed
// by the router's per-call telemetry); zero retries; zero calls for invalid
// input or decision requests. No background work.
// Actor comes from the signed-in session (the API passes it); a body-supplied
// name is never used. Staff context only: the board portal does not use this.
// ============================================================================
const crypto = require('crypto');
const { route: aiRoute } = require('../ai/router');
const { buildFeed, buildItem, DEST } = require('../feed/build');

const WORKFLOW = 'team.amanda_request';
const MAX_TEXT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const SPECIALISTS = { emma: 'payables', annie: 'ACC / architectural review', paige: 'board operations', miranda: 'compliance / violations', kat: 'accounting', reese: 'vendors and projects', claire: 'homeowner service (Claire talks to homeowners; Amanda does not from here)' };
const DOMAINS = ['ap', 'legal', 'violations', 'acc', 'board', 'accounting', 'communications', 'ops'];
const TYPE_FOR_DOMAIN = { ap: 'ap', board: 'board', acc: 'arc', violations: 'drv' };
const REF_KINDS = { ap_invoice: 'ap_invoice', acc_decision: 'acc_decision', ap_exception: 'ap_exception', objective: 'objective', board_packet: 'board_packet' };

// ---- deterministic intent screen ------------------------------------------------
const DECISION_VERBS = 'approve|reject|deny|release|pay|void|finalize|finalise|waive|dismiss|post|unhold|refund|charge|fine|send';
const DECISION_RE = new RegExp(`^(?:please\\s+)?(?:go ahead and\\s+)?(${DECISION_VERBS})\\b|\\b(?:can you|could you|please|go ahead and)\\s+(${DECISION_VERBS})\\b|\\bmark\\b.*\\bpaid\\b|\\bput\\b.*\\bon hold\\b|\\btake\\b.*\\boff hold\\b`, 'i');
const WORK_RE = /^(?:please\s+)?(?:get|prepare|prep|find out|figure out|fix|follow up|look into|handle|chase|make sure|draft|set up|clean up|resolve|sort out|work on|take care of|coordinate|investigate|check on|line up|organi[sz]e|see what'?s going on)\b/i;
const QUERY_RE = /\?\s*$|^(?:what|why|how|when|where|which|who|is|are|was|were|do|does|did|can i|could i|should|will|would|has|have|summari[sz]e|show|list|tell me|give me|status)\b/i;

function cleanText(text) {
  return String(text == null ? '' : text).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().replace(/^amanda[,:\s-]+/i, '').trim();
}
function screenIntent(text) {
  const t = cleanText(text);
  // "send me / show me / give me ..." asks Amanda for information, not for an action
  const d = /\b(?:send|show|give|tell)\s+me\b/i.test(t) ? null : DECISION_RE.exec(t);
  if (d) return { intent: 'decision', verb: (d[1] || d[2] || (/paid/i.test(t) ? 'mark paid' : /off hold/i.test(t) ? 'release hold' : 'hold')).toLowerCase(), confident: true };
  if (WORK_RE.test(t)) return { intent: 'work', confident: true };
  if (QUERY_RE.test(t)) return { intent: 'query', confident: true };
  return { intent: null, confident: false };
}

// The floor that applies to a requested action, by verb and record kind (plain words).
function floorFor(verb, kind) {
  const v = String(verb || '');
  if (kind === 'ap_invoice' || /pay|release|void|mark paid|hold|unhold|approve/.test(v)) {
    if (/release|pay|mark paid/.test(v)) return 'Only Ed releases payments, in Payables, with the usual checks.';
    if (/void/.test(v)) return 'Voiding a bill is done in Payables by a person, with the bill in front of them.';
    if (/hold/.test(v)) return 'Holds are managed in Payables; there is no release-hold control yet (tracked in #33).';
    return 'Bills are approved in Payables by a person: staff approve, Ed releases payment.';
  }
  if (kind === 'acc_decision' || /finali[sz]e/.test(v)) return 'ACC decisions are finalized by a person in ACC review; the letter goes to the homeowner only from there.';
  if (/fine|waive|refund|charge/.test(v)) return 'Fines, waivers and charges are board or Ed decisions and are never made from a conversation.';
  if (/send/.test(v)) return 'Messages go out from their own screen after a person reviews the draft.';
  return 'This needs a person on the screen where it lives, with its usual checks.';
}
function destinationFor(refs) {
  if (!refs || !refs.id || !UUID.test(refs.id)) return null;
  if (refs.kind === 'ap_invoice') return DEST.invoice(refs.id);
  if (refs.kind === 'acc_decision') return DEST.decision(refs.id);
  if (refs.kind === 'ap_exception') return DEST.exception(refs.id);
  if (refs.kind === 'board_packet') return DEST.packets();
  if (refs.kind === 'objective') return DEST.objectives();
  return null;
}

// Deterministic subject identity so a repeated work request reattaches instead of duplicating.
const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'please', 'and', 'of', 'on', 'by', 'can', 'you', 'me', 'my', 'our', 'is', 'it', 'this', 'that', 'with', 'in', 'at', 'amanda', 'go', 'ahead']);
function normalizedSubject(text) {
  const words = cleanText(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  return [...new Set(words)].sort().join(' ');
}
function subjectKeyFor({ refs, communityId, text }) {
  if (refs && refs.kind !== 'objective' && REF_KINDS[refs.kind] && UUID.test(String(refs.id || ''))) return `${refs.kind}:${String(refs.id).toLowerCase()}`;
  const h = crypto.createHash('sha256').update(normalizedSubject(text)).digest('hex').slice(0, 16);
  return `amanda_request:${communityId || 'portfolio'}:${h}`;
}

// Never let a reply claim an action Amanda did not take (honesty rule for the AI team).
function honestyGuard(reply) {
  const claims = /\bI(?:'ve| have)?\s+(?:already\s+)?(approved|released|paid|sent|finalized|finalised|voided|posted|waived|emailed|called|scheduled)\b[^.!?]*[.!?]?/gi;
  const out = String(reply || '').replace(claims, '').replace(/—|–/g, ', ').replace(/\s{2,}/g, ' ').trim();
  return out;
}

// ---- context (deterministic, bounded) ---------------------------------------------
async function resolveCommunity(supabase, { communityId, text }) {
  const { data, error } = await supabase.from('communities').select('id, name, management_status, is_demo').limit(500);
  if (error) return { community: null, error: error.message };
  const rows = (data || []).filter((c) => !c.is_demo);
  if (communityId && UUID.test(communityId)) return { community: rows.find((c) => c.id === communityId) || null };
  const t = cleanText(text).toLowerCase();
  const hit = rows.map((c) => ({ c, key: String(c.name || '').toLowerCase().replace(/\s+at\s+.*$/, '') })).filter((x) => x.key && t.includes(x.key)).sort((a, b) => b.key.length - a.key.length)[0];
  return { community: hit ? hit.c : null };
}

function promptFor({ actor, text, community, feed, focus, objectives, screened }) {
  const lane = (n) => (feed && feed.lanes && feed.lanes[n] || []).slice(0, 8).map((i) => `- [${i.specialist.name}] ${i.title} | ${i.why}${i.community ? ` | ${i.community}` : ''}`).join('\n') || '- none';
  return `You are Amanda Albright, Senior Community Manager at Bedrock Association Management. ${actor.name || 'A colleague'} on the Bedrock team is asking you something inside trustEd. This is a colleague, not a homeowner.

WHAT THEY ASKED: ${text}
${community ? `COMMUNITY: ${community.name}\n` : ''}${screened.intent ? `SCREENED INTENT: ${screened.intent}\n` : ''}
CURRENT STATE (from trustEd records; the only facts you may use):
Summary: ${feed ? feed.summary : 'unavailable'}
Needs a person now:
${lane('now')}
Waiting on something:
${lane('waiting')}
For Ed's decision:
${lane('policy')}
${focus ? `\nTHE RECORD THEY ARE LOOKING AT: ${focus.title}${focus.status ? ` (status: ${focus.status})` : ''}\n${(focus.facts || []).map((f) => `- ${f}`).join('\n')}\nHistory: ${(focus.timeline || []).slice(-6).map((e) => e.text).join(' | ')}\n` : ''}${objectives.length ? `\nYOUR OPEN WORK AT THIS COMMUNITY:\n${objectives.map((o) => `- ${o.title}${o.next_action ? ` (next: ${o.next_action})` : ''}`).join('\n')}\n` : ''}
SPECIALISTS YOU CAN ROUTE TO: ${Object.entries(SPECIALISTS).map(([k, v]) => `${k} (${v})`).join('; ')}.

RULES:
- Classify the request: "query" (a question, answer it), or "work" (they want something done, propose how). Never "decision".
- You PROPOSE. You have not done anything and cannot act from here. Never say you approved, paid, sent, scheduled, emailed or called anything.
- Use only the facts above. If something you need is missing, say exactly what.
- You never decide an ACC application, waive or reduce a fine, adjust a balance or release a payment. Say who decides (the reviewer, the board, or Ed).
- Claire, not you, talks to homeowners. Do not draft homeowner messages here.
- Plain sentences, short. No em-dashes, use commas. No GL account numbers.

RETURN STRICT JSON, no code fences:
{"intent":"query|work","reply":"<2-6 sentences to ${actor.name ? actor.name.split(' ')[0] : 'them'}>","plan":["<step>", "..."],"specialists":["<keys from the list>"],"next_dependency":"<what is needed first, or null>","title":"<short title if work, else null>","domain":"<one of ${DOMAINS.join('|')} or null>"}`;
}

function parseModel(raw) {
  try {
    const j = JSON.parse(String(raw || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim());
    return j && typeof j === 'object' ? j : null;
  } catch (_) { return null; }
}

// ---- the contract -----------------------------------------------------------------
async function handleRequest(input = {}, deps = {}) {
  const { supabase, anthropic, now = Date.now() } = deps;
  const channel = input.channel || 'app';
  const actor = input.actor || null;
  const text = cleanText(input.text);
  const refs = input.refs && REF_KINDS[input.refs.kind] && UUID.test(String(input.refs.id || '')) ? { kind: input.refs.kind, id: String(input.refs.id).toLowerCase() } : null;
  const objectiveId = input.objective_id && UUID.test(String(input.objective_id)) ? String(input.objective_id).toLowerCase() : null;
  const base = { channel, workflow: WORKFLOW, model_calls: 0, actions_executed: 0, durable: false, objective: null };

  // 1. deterministic validation: no model call
  if (!actor || !actor.email) return { ...base, ok: false, error: 'actor_required', reply: 'Sign in to message Amanda.' };
  if (!['app'].includes(channel)) return { ...base, ok: false, error: 'channel_not_enabled', reply: 'This channel is not connected to Amanda yet.' };
  if (!text) return { ...base, ok: false, error: 'empty', reply: 'Tell Amanda what you need.' };
  if (text.length > MAX_TEXT) return { ...base, ok: false, error: 'too_long', reply: `Keep it under ${MAX_TEXT} characters.` };

  // 2. deterministic intent screen; decision requests never reach a model
  const screened = screenIntent(text);
  if (screened.intent === 'decision') return decisionResult({ base, text, verb: screened.verb, refs });

  // 3. deterministic context
  const { community } = await resolveCommunity(supabase, { communityId: input.community_id, text });
  let feed = null;
  try { feed = await buildFeed(supabase, { communityId: community ? community.id : null, now }); } catch (e) { feed = null; }
  let focus = null;
  if (objectiveId) { try { focus = await buildItem(supabase, `objective:${objectiveId}`); } catch (_) { focus = null; } }
  else if (refs) { try { focus = await buildItem(supabase, `${refs.kind}:${refs.id}`); } catch (_) { focus = null; } }
  let objectives = [];
  if (community) {
    const { data } = await supabase.from('objectives').select('id, title, next_action').eq('community_id', community.id).eq('accountable_persona', 'amanda').in('status', OPEN).limit(10);
    objectives = data || [];
  }

  // 4. ONE model call, no retries
  let parsed = null; let raw = null;
  if (!anthropic) return { ...base, ok: false, error: 'model_unavailable', intent: screened.intent || 'query', reply: 'Amanda can\'t answer right now. Nothing was changed.' };
  try {
    base.model_calls = 1;
    const resp = await anthropic.messages.create({ model: aiRoute(WORKFLOW), max_tokens: 900, messages: [{ role: 'user', content: promptFor({ actor, text, community, feed, focus, objectives, screened }) }] });
    raw = (resp.content || []).map((c) => c.text || '').join('');
    parsed = parseModel(raw);
  } catch (e) {
    console.warn('[amanda.request] model call failed:', e.message);
    return { ...base, ok: false, error: 'model_failed', intent: screened.intent || 'query', reply: 'Amanda couldn\'t answer just now. Nothing was changed.' };
  }
  if (!parsed) return { ...base, ok: false, error: 'unparseable', intent: screened.intent || 'query', reply: 'Amanda\'s answer didn\'t come back in a usable form. Nothing was changed.', raw_extracted: raw };

  let intent = screened.confident ? screened.intent : (['query', 'work'].includes(parsed.intent) ? parsed.intent : 'query');
  if (parsed.intent === 'decision') return { ...decisionResult({ base, text, verb: null, refs }), model_calls: base.model_calls };
  const reply = honestyGuard(parsed.reply || '');
  const plan = (Array.isArray(parsed.plan) ? parsed.plan : []).map((s) => honestyGuard(String(s))).filter(Boolean).slice(0, 6);
  const specialists = (Array.isArray(parsed.specialists) ? parsed.specialists : []).map((s) => String(s).toLowerCase()).filter((s) => SPECIALISTS[s]).slice(0, 4);
  const nextDep = parsed.next_dependency ? honestyGuard(String(parsed.next_dependency)).slice(0, 300) : null;
  const out = { ...base, ok: true, intent, reply, plan, specialists, next_dependency: nextDep, community: community ? { id: community.id, name: community.name } : null, refs, destination: destinationFor(refs) };

  // 5. work -> attach to or open exactly one objective, log request + proposal.
  // Work is only ACCEPTED when something durable is tracking it. If no objective can
  // be attached or opened, the request fails loudly: no plan is presented as accepted.
  if (intent === 'work') {
    const domain = DOMAINS.includes(parsed.domain) ? parsed.domain : (refs && refs.kind === 'acc_decision' ? 'acc' : refs && /^ap_/.test(refs.kind) ? 'ap' : 'ops');
    const subjectKey = objectiveId ? null : subjectKeyFor({ refs, communityId: community ? community.id : null, text });
    const warnings = [];
    const tracked = await attachOrOpen(supabase, { objectiveId, subjectKey, community, domain, title: String(parsed.title || text).slice(0, 140), nextAction: plan[0] || nextDep || null, refs, warnings });
    if (!tracked.obj) {
      console.warn('[amanda.request] work not tracked', JSON.stringify({ actor: actor.email, reason: tracked.reason, objective_id: objectiveId, subject_key: subjectKey }));
      return { ...base, ok: false, error: 'tracking_failed', intent: 'work', durable: false, objective: null, tracking_reason: tracked.reason,
        reply: 'I could not track this work, so I have not accepted it. Nothing else was changed.', plan: [], specialists: [], next_dependency: null,
        community: out.community, refs, destination: out.destination };
    }
    const obj = tracked.obj;
    const w1 = await logEvent(supabase, obj.id, actor.email, 'message_in', `${channel} request: ${text}`);
    const w2 = await logEvent(supabase, obj.id, 'amanda', 'message_out', `Proposed: ${reply}${plan.length ? ` Plan: ${plan.join(' / ')}` : ''}`);
    for (const w of [w1, w2]) if (w) warnings.push(w);
    out.durable = true;
    out.objective = { id: obj.id, title: obj.title, created: obj.created, subject_key: obj.subject_key };
    if (warnings.length) out.audit_warnings = warnings;
  }
  return out;
}

function decisionResult({ base, text, verb, refs }) {
  const v = verb || 'act';
  const destination = destinationFor(refs);
  const floor = floorFor(v, refs && refs.kind);
  const where = destination ? `Open it with Take action (${destination.where}).` : 'Open the record from the Amanda Operations list (Take action) and act there.';
  return { ...base, ok: true, intent: 'decision', durable: false,
    action_request: { verb: v, target: refs, allowed_here: false, reason: 'Conversation is not authority to act. Phase 2A proposes only.', floor, destination },
    reply: `I can't ${v} anything from a conversation. ${floor} ${where}`.replace(/\s+/g, ' ').trim(), plan: [], specialists: [], next_dependency: null, refs, destination };
}

// -> { obj, reason }. obj is null when nothing can track the work; reason says why.
async function attachOrOpen(supabase, { objectiveId, subjectKey, community, domain, title, nextAction, refs, warnings = [] }) {
  const pick = 'id, title, subject_key, status';
  if (objectiveId) {
    const { data, error } = await supabase.from('objectives').select(pick).eq('id', objectiveId).in('status', OPEN).limit(1);
    if (error) return { obj: null, reason: `objective lookup failed: ${error.message}` };
    return data && data[0] ? { obj: { ...data[0], created: false } } : { obj: null, reason: 'the objective named is closed or not found' };
  }
  const find = async () => { const { data, error } = await supabase.from('objectives').select(pick).eq('subject_key', subjectKey).in('status', OPEN).limit(1); if (error) throw error; return data && data[0] ? data[0] : null; };
  let existing;
  try { existing = await find(); } catch (e) { return { obj: null, reason: `objective lookup failed: ${e.message}` }; }
  if (existing) return { obj: { ...existing, created: false } };
  const row = { title, objective_type: TYPE_FOR_DOMAIN[domain] || 'other', owner_kind: 'amanda', owner_key: null, accountable_persona: 'amanda', owner_persona: 'amanda',
    domain, priority: 'normal', autonomy_class: 'REVIEW', subject_key: subjectKey, subject_refs: refs || null, needs_reasoning: false,
    next_action: nextAction, community_id: community ? community.id : null, status: 'open', wake_reason: 'human_request', last_activity_at: new Date().toISOString() };
  const ins = await supabase.from('objectives').insert(row).select(pick).single();
  if (ins.error) {
    if (String(ins.error.code) === '23505') {
      let again = null;
      try { again = await find(); } catch (_) { again = null; }
      return again ? { obj: { ...again, created: false } } : { obj: null, reason: 'a matching objective was opened at the same moment but could not be read back' };
    }
    console.warn('[amanda.request] objective insert failed:', ins.error.message);
    return { obj: null, reason: `could not open the objective: ${ins.error.message}` };
  }
  if (!ins.data || !ins.data.id) return { obj: null, reason: 'the objective insert returned no record' };
  const w = await logEvent(supabase, ins.data.id, 'amanda', 'opened', `REVIEW: ${title}`);
  if (w) warnings.push(w);
  return { obj: { ...ins.data, created: true } };
}

// Returns null on success, or an audit warning string (never swallowed silently).
async function logEvent(supabase, objectiveId, actor, kind, summary) {
  const { error } = await supabase.from('objective_events').insert({ objective_id: objectiveId, actor, kind, summary: String(summary || '').slice(0, 1000) });
  const touch = await supabase.from('objectives').update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', objectiveId);
  if (error) {
    console.warn('[amanda.request] objective event failed', JSON.stringify({ objective_id: objectiveId, kind, error: error.message }));
    return `The ${kind.replace('_', ' ')} entry was not recorded on the work's history (${error.message}).`;
  }
  if (touch && touch.error) console.warn('[amanda.request] objective activity stamp failed', JSON.stringify({ objective_id: objectiveId, error: touch.error.message }));
  return null;
}

module.exports = { handleRequest, screenIntent, normalizedSubject, subjectKeyFor, honestyGuard, floorFor, WORKFLOW, MAX_TEXT };
