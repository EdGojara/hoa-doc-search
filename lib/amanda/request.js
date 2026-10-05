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
// Doors that may call the contract. Phase 2B adds the amanda@ staff email path.
const CHANNELS = ['app', 'email'];
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
const WORK_RE = /^(?:(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?|please\s+)?(?:get|prepare|prep|find out|figure out|fix|follow up|look into|handle|chase|make sure|draft|set up|clean up|resolve|sort out|work on|take care of|coordinate|investigate|check on|line up|organi[sz]e|see what'?s going on)\b/i;
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
// Greeting / courtesy / filler words never change WHICH work is meant, so they never change the key
// ("Hi Amanda, can you please get Canyon Gate ready for Monday? Thanks" == "Get Canyon Gate ready for Monday.").
const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'please', 'and', 'of', 'on', 'by', 'can', 'you', 'me', 'my', 'our', 'is', 'it', 'this', 'that', 'with', 'in', 'at', 'amanda', 'go', 'ahead',
  'could', 'would', 'will', 'hi', 'hello', 'hey', 'thanks', 'thank', 'pls', 'kindly', 'just', 'quick', 'us', 'we', 'i', 'so', 'be', 'if']);
function normalizedSubject(text) {
  const words = cleanText(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  return [...new Set(words)].sort().join(' ');
}
function subjectKeyFor({ refs, communityId, text }) {
  if (refs && refs.kind !== 'objective' && REF_KINDS[refs.kind] && UUID.test(String(refs.id || ''))) return `${refs.kind}:${String(refs.id).toLowerCase()}`;
  const h = crypto.createHash('sha256').update(normalizedSubject(text)).digest('hex').slice(0, 16);
  return `amanda_request:${communityId || 'portfolio'}:${h}`;
}

// Never let a reply claim, or imply as underway, an action Amanda did not take
// (honesty rule for the AI team: a "now" claim needs a record). Phase 2A only
// PROPOSES, so:
//   - past-tense claims ("I approved / sent / paid ...") are removed;
//   - "On it", "I'll take care of it", "I'm handling it" become proposal language;
//   - first-person commitments to act ("I'll route ... now", "I'm sending",
//     "Let me flag ...") become "I would route ...", and "now / right away /
//     immediately" is dropped from them.
// Harmless future language is kept: "Emma will need ...", "I'll need the
// September financials", "The meeting will be Monday".
const ACT_VERBS = ['route', 'send', 'flag', 'forward', 'approve', 'release', 'pay', 'email', 'call', 'text', 'schedule', 'push', 'move', 'assign', 'ask', 'chase', 'follow up', 'reach out', 'escalate', 'notify', 'handle', 'take care of', 'process', 'submit', 'file', 'post', 'void', 'finalize', 'clear', 'get', 'loop in', 'contact', 'remind', 'kick off', 'start', 'set up', 'work on', 'put', 'mark', 'update', 'close'];
const GERUND = { routing: 'route', sending: 'send', flagging: 'flag', forwarding: 'forward', approving: 'approve', releasing: 'release', paying: 'pay', emailing: 'email', calling: 'call', texting: 'text', scheduling: 'schedule', pushing: 'push', moving: 'move', assigning: 'assign', asking: 'ask', chasing: 'chase', 'following up': 'follow up', 'reaching out': 'reach out', escalating: 'escalate', notifying: 'notify', handling: 'handle', 'taking care of': 'take care of', processing: 'process', submitting: 'submit', filing: 'file', posting: 'post', voiding: 'void', finalizing: 'finalize', clearing: 'clear', getting: 'get', 'looping in': 'loop in', contacting: 'contact', reminding: 'remind', 'kicking off': 'kick off', starting: 'start', 'setting up': 'set up', 'working on': 'work on', putting: 'put', marking: 'mark', updating: 'update', closing: 'close' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const FUTURE_ACT = new RegExp(`\\b(?:I(?:'ll|\\s+will)|let\\s+me|I(?:'m|\\s+am)\\s+going\\s+to)\\s+(?:go\\s+ahead\\s+and\\s+|also\\s+|just\\s+)?(${ACT_VERBS.map(esc).join('|')})\\b`, 'gi');
const NOW_ACT = new RegExp(`\\bI(?:'m|\\s+am)\\s+(?:also\\s+|now\\s+)?(${Object.keys(GERUND).map(esc).join('|')})\\b`, 'gi');
function honestyGuard(reply) {
  const claims = /\bI(?:'ve| have)?\s+(?:already\s+)?(approved|released|paid|sent|finalized|finalised|voided|posted|waived|emailed|called|scheduled|routed|flagged|forwarded|handled|notified|escalated)\b[^.!?]*[.!?]?/gi;
  let out = String(reply || '').replace(/\u2014|\u2013/g, ', ').replace(claims, '');
  out = out.replace(/(^|[.!?]\s+)(?:on it|on it now|consider it done|will do|done)[.!,]?\s*/gi, '$1');
  out = out.replace(/\bI(?:'ll|\s+will)\s+(?:take care of|handle)\s+(?:it|this|that|everything)\b(?:\s+(?:now|right away|immediately|today))?/gi, 'I can track this work and propose the plan');
  out = out.replace(/\bI(?:'m|\s+am)\s+(?:on|handling|taking care of)\s+(?:it|this|that)\b(?:\s+(?:now|right away|immediately))?/gi, 'I can track this work and propose the plan');
  out = out.replace(FUTURE_ACT, (m, verb) => `I would ${verb.toLowerCase().replace(/\s+/g, ' ')}`);
  out = out.replace(NOW_ACT, (m, g) => `I would ${GERUND[g.toLowerCase().replace(/\s+/g, ' ')]}`);
  // "I would ... now / right away / immediately" -> drop the immediacy, within the same sentence
  out = out.replace(/(\bI would\b[^.!?]*?)\s+(?:right\s+now|right\s+away|now|immediately|straight\s+away)\b/gi, '$1');
  return out.replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[,.\s]+/, '').trim();
}

// ---- context (deterministic, bounded) ---------------------------------------------
async function resolveCommunity(supabase, { communityId, text }) {
  const { data, error } = await supabase.from('communities').select('id, name, management_status, is_demo').limit(500);
  if (error) return { community: null, error: error.message };
  const rows = (data || []).filter((c) => !c.is_demo);
  // A community NAMED in the request wins (the same words reach the same work from
  // any door); otherwise the door's own context (app scope, the email's community).
  const t = cleanText(text).toLowerCase();
  const hit = rows.map((c) => ({ c, key: String(c.name || '').toLowerCase().replace(/\s+at\s+.*$/, '') })).filter((x) => x.key && t.includes(x.key)).sort((a, b) => b.key.length - a.key.length)[0];
  if (hit) return { community: hit.c };
  if (communityId && UUID.test(communityId)) return { community: rows.find((c) => c.id === communityId) || null };
  return { community: null };
}

function promptFor({ actor, text, community, feed, focus, objectives, screened, channel = 'app', contextText = null }) {
  const lane = (n) => (feed && feed.lanes && feed.lanes[n] || []).slice(0, 8).map((i) => `- [${i.specialist.name}] ${i.title} | ${i.why}${i.community ? ` | ${i.community}` : ''}`).join('\n') || '- none';
  const where = channel === 'email' ? 'by email to amanda@ (your reply becomes a draft a person reviews before it is sent)' : 'inside trustEd';
  return `You are Amanda Albright, Senior Community Manager at Bedrock Association Management. ${actor.name || 'A colleague'} on the Bedrock team is asking you something ${where}. This is a colleague, not a homeowner.

WHAT THEY ASKED: ${text}
${contextText ? `THEIR EMAIL (context only; facts in it are what they told you, not trustEd records):\n${String(contextText).slice(0, 4000)}\n` : ''}
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
- Never write as if the work is underway or promised: no "I'll route ... now", "On it", "I'm sending", "I'm handling it", "I'll take care of it". Write "I would route ...", "The next step is ...", "I recommend ...".
- Copy any count exactly from CURRENT STATE. Never add, merge or estimate numbers.
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
  if (!CHANNELS.includes(channel)) return { ...base, ok: false, error: 'channel_not_enabled', reply: 'This channel is not connected to Amanda yet.' };
  // email: the door passes the trusted inbound staff sender; only Bedrock staff reach this contract
  if (channel === 'email' && !/@bedrocktx.com$/i.test(String(actor.email))) return { ...base, ok: false, error: 'actor_not_staff', reply: 'Only Bedrock staff can send Amanda work requests by email.' };
  if (!text) return { ...base, ok: false, error: 'empty', reply: 'Tell Amanda what you need.' };
  if (text.length > MAX_TEXT) return { ...base, ok: false, error: 'too_long', reply: `Keep it under ${MAX_TEXT} characters.` };

  // 2. deterministic intent screen; decision requests never reach a model
  const screened = screenIntent(text);
  if (screened.intent === 'decision') return decisionResult({ base, text, verb: screened.verb, refs });

  // 3. deterministic context
  const { community } = await resolveCommunity(supabase, { communityId: input.community_id, text });

  // 3a. exact-status fast path: "what still needs me (today)?" and equivalents are
  // answered straight from the Phase 1 feed read model. 0 model calls; counts are
  // never recomputed or paraphrased by a model.
  // A named place must be the community resolved from the request itself ("What's left for the
  // Gexa bill?" is not a community status ask; the model path handles it).
  const sq = (!objectiveId && !refs) ? statusQuestion(text) : null;
  const placeOk = sq && (!sq.place || (community && String(sq.place).toLowerCase().includes(String(community.name).toLowerCase().replace(/\s+at\s+.*$/, ''))));
  if (sq && placeOk) return statusResult({ base, supabase, community, now });
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
    const resp = await anthropic.messages.create({ model: aiRoute(WORKFLOW), max_tokens: 900, messages: [{ role: 'user', content: promptFor({ actor, text, community, feed, focus, objectives, screened, channel, contextText: input.context_text || null }) }] });
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

// The simple current-work family only; broader questions still take the one-call path.
const STATUS_RE = /^(?:(?:so|ok|okay|hey|hi),?\s+)?(?:what(?:'s|\s+is|\s+do\s+i\s+have)?\s+(?:still\s+)?(?:needs?|need(?:ing)?)\s+(?:me|my\s+attention)|what\s+needs\s+me|what(?:'s|\s+is)\s+on\s+my\s+plate|what\s+do\s+i\s+(?:still\s+)?need\s+to\s+do|anything\s+(?:that\s+)?needs?\s+me|(?:give\s+me\s+(?:a|the)\s+)?status(?:\s+update)?|where\s+do\s+things\s+stand)(?:\s+(?:today|right\s+now|now|this\s+morning|this\s+afternoon))?(?:\s+(?:at|for|in)\s+[a-z0-9 '&.-]{2,60})?(?:\s+(?:today|right\s+now|now))?\s*[?.!]*$/i;
// ---- Community-scoped status questions (Issue #29, 2026-10-05) ----
// A status question is assembled from parts, not matched as a fixed phrase: an optional lead-in,
// a STATUS CORE (what's left / outstanding / on my plate; what do I have to do / handle; what
// needs me / my attention; anything I need to handle; how are we looking; where do things stand;
// status), and optional TIME / PLACE tails ("for Canyon Gate", "at Canyon Gate today").
// Greetings, pleasantries and sign-offs are separate sentences and are dropped first; the request
// must then be exactly one status question (any other substantive sentence means it is not a
// pure status ask, so the model path handles it). A PLACE tail must name a real community
// (checked in handleRequest), or the question is not treated as status.
const ST_SUBJ = '(?:i|we)';
const ST_CORE = [
  `what(?:'s|\\s+is|\\s+are)?\\s+(?:still\\s+)?(?:left|outstanding|pending|open|remaining|due|on\\s+(?:my|our)\\s+plate|on\\s+deck)(?:\\s+(?:for|to)\\s+(?:me|us)(?:\\s+to\\s+do)?)?`,
  `what\\s+(?:do|does|should|must)\\s+${ST_SUBJ}\\s+(?:still\\s+)?(?:have\\s+to|need\\s+to|got\\s+to|gotta)?\\s*(?:do|handle|cover|look\\s+at|take\\s+care\\s+of|work\\s+on|get\\s+done)`,
  `what\\s+(?:do\\s+${ST_SUBJ}\\s+have|have\\s+${ST_SUBJ}\\s+got|is\\s+there)\\s+(?:still\\s+)?(?:to\\s+do|left|on\\s+(?:my|our)\\s+plate)`,
  `what(?:'s|\\s+is|\\s+do\\s+i\\s+have)?\\s+(?:still\\s+)?(?:needs?|need(?:ing)?|requires?)\\s+(?:me|us|my\\s+attention|our\\s+attention|attention|action|doing|handling)`,
  `(?:is\\s+there\\s+)?anything\\s+(?:that\\s+)?(?:still\\s+)?(?:needs?|requires?)\\s+(?:me|us|my\\s+attention|our\\s+attention|attention|action)`,
  `(?:is\\s+there\\s+)?anything\\s+${ST_SUBJ}\\s+(?:still\\s+)?(?:need|have|should|must|ought)(?:\\s+to)?\\s+(?:do|handle|look\\s+at|take\\s+care\\s+of|know\\s+about|sign|cover|deal\\s+with)`,
  `how\\s+(?:are|is)\\s+(?:we|things|it|everything)\\s+(?:looking|going|doing|shaping\\s+up)`,
  `where\\s+(?:do|does)\\s+(?:things|we|it|everything)\\s+stand`,
  `(?:give\\s+me\\s+(?:a|the)\\s+|what(?:'s|\\s+is)\\s+the\\s+)?status(?:\\s+(?:update|check|report))?`,
].join('|');
const ST_TIME = `(?:\\s+(?:today|tonight|right\\s+now|now|this\\s+(?:morning|afternoon|evening|week)|tomorrow))?`;
const ST_PLACE = `(?:\\s+(?:at|for|in|on|with|over\\s+at)\\s+(?<place>[a-z0-9][a-z0-9 '&.-]{1,60}?))?`;
const STATUS_GRAMMAR = new RegExp(`^(?:(?:so|ok|okay|and|also|quick\\s+question),?\\s+)?(?:${ST_CORE})${ST_TIME}${ST_PLACE}${ST_TIME}\\s*[?.!]*$`, 'i');
const GREETING_PREFIX = /^(?:(?:good\s+(?:morning|afternoon|evening)|morning|afternoon|hi|hello|hey)\b[\s,!.-]*(?:amanda\b)?[\s,!.:-]*)/i;
const PLEASANTRY = /^(?:(?:good\s+(?:morning|afternoon|evening)|morning|afternoon|hi|hello|hey)\b[\s,!.-]*(?:amanda)?[\s,!.-]*$|(?:i\s+)?hope\b|thanks?\b|thank\s+you\b|much\s+appreciated|appreciate\s+it|have\s+a\s+(?:great|good|nice|wonderful)\b|how\s+are\s+you(?:\s+doing)?(?:\s+today)?\s*[?.!]*$|happy\s+\w+day\b|cheers\b|best(?:\s+regards)?\s*[,.!]*$|regards\s*[,.!]*$|-{2,}\s*$)/i;

// The status question in a request, or null. Returns { sentence, place } (place = the named tail).
function statusQuestion(text) {
  const sentences = cleanText(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().replace(GREETING_PREFIX, '').trim()).filter(Boolean);
  const substantive = sentences.filter((s) => !PLEASANTRY.test(s));
  if (substantive.length !== 1) return null;
  const sentence = substantive[0].replace(/^amanda[,:\s-]+/i, '').trim();
  const m = STATUS_GRAMMAR.exec(sentence) || STATUS_RE.exec(sentence);
  if (!m) return null;
  return { sentence, place: (m.groups && m.groups.place) ? m.groups.place.trim() : null };
}
function isStatusQuery(text) { return !!statusQuestion(text); }

async function statusResult({ base, supabase, community, now }) {
  let feed;
  try { feed = await buildFeed(supabase, { communityId: community ? community.id : null, now }); }
  catch (e) { return { ...base, ok: false, error: 'state_unavailable', intent: 'query', reply: 'I couldn\'t read the current work list, so I won\'t guess. Nothing was changed.' }; }
  const c = feed.counts || { now: 0, waiting: 0, policy: 0 };
  const L = feed.lanes || { now: [], waiting: [], policy: [] };
  const who = Object.entries(feed.by_specialist || {}).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ${k}`).join(', ');
  const plus = (feed.capped || []).length ? '+' : '';
  const where = community ? ` at ${community.name}` : '';
  const item = (i) => `${i.title}${i.community && !community ? ` (${i.community})` : ''}`;
  const parts = [];
  if (!c.now && !c.waiting && !c.policy) parts.push(`Nothing needs a person${where} right now.`);
  else {
    parts.push(`${c.now}${plus} item${c.now === 1 ? '' : 's'} need${c.now === 1 ? 's' : ''} you now${who ? ` (${who})` : ''}, ${c.waiting} ${c.waiting === 1 ? 'is' : 'are'} waiting on something, and ${c.policy} ${c.policy === 1 ? 'needs' : 'need'} your decision${where}.`);
    if (L.policy.length) parts.push(`For your decision: ${L.policy.slice(0, 3).map((i) => `${item(i)}, ${i.why.replace(/[.]$/, '')}`).join('; ')}.`);
    if (L.now.length) parts.push(`Most urgent: ${L.now.slice(0, 3).map(item).join('; ')}.`);
    if (L.waiting.length) parts.push(`Waiting: ${L.waiting.slice(0, 2).map(item).join('; ')}.`);
  }
  const fails = Object.keys(feed.section_errors || {});
  if (fails.length) parts.push(`Some sources didn't answer (${fails.join(', ')}), so this may be incomplete.`);
  return { ...base, ok: true, intent: 'query', durable: false, objective: null, deterministic: 'status',
    reply: parts.join(' '), plan: [], specialists: [], next_dependency: null,
    community: community ? { id: community.id, name: community.name } : null,
    status: { counts: { ...c }, by_specialist: { ...(feed.by_specialist || {}) }, capped: (feed.capped || []).length > 0, section_errors: fails,
      policy: L.policy.slice(0, 3).map((i) => ({ title: i.title, why: i.why, action: i.action })),
      top_now: L.now.slice(0, 3).map((i) => ({ title: i.title, why: i.why, specialist: i.specialist.name, action: i.action })),
      top_waiting: L.waiting.slice(0, 2).map((i) => ({ title: i.title, why: i.why, specialist: i.specialist.name, action: i.action })) },
    destination: L.policy[0] ? L.policy[0].action : (L.now[0] ? L.now[0].action : null) };
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

module.exports = { handleRequest, screenIntent, isStatusQuery, statusQuestion, normalizedSubject, subjectKeyFor, honestyGuard, floorFor, WORKFLOW, MAX_TEXT, CHANNELS };
