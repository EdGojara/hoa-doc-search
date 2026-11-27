// ============================================================================
// lib/amanda/conversation.js  (Ed 2026-11-26: Talk to Amanda, stage 1)
// ----------------------------------------------------------------------------
// Amanda's CONVERSATIONAL brain: one engine for every channel she talks on
// (voice today through lib/amanda/voice_elevenlabs.js; typed chat, email and
// phone later call the same functions). It is not a new intelligence:
//
//   identity     the roster entry + the approved Character Bible persona
//                (scripts/character_seed/amanda_albright.json persona.v1)
//   work         instructions go through the Amanda request contract
//                (lib/amanda/request.js handleRequest, channel 'voice'): it
//                opens or attaches ONE tracked objective, and it refuses
//                decisions deterministically with the place they are made
//   commitments  objectives / objective_events (the manager sweep follows up)
//   approvals    never from a conversation (lib/authorization/policy.js has no
//                tier that the voice channel may authorize). Amanda says what
//                needs Ed and puts the in-app place on his screen
//   memory       claire_sessions / claire_session_turns (the conversation) and
//                amanda_memory (what she keeps), migration 578
//   usage        every model call is attributed to the conversation in
//                agent_runs (lib/ai/router.js withAttribution); one
//                run_kind='conversation' row per finished conversation
//
// Cost discipline: a short briefing is built ONCE per conversation and cached
// in the prompt; everything else is loaded by a tool only when the
// conversation needs it. One streamed model call per turn, plus one more per
// tool round (at most three).
// ============================================================================
const crypto = require('crypto');
const { route: aiRoute, withAttribution } = require('../ai/router');

const WORKFLOW = 'team.amanda_conversation';
const EXTRACT_WORKFLOW = 'team.amanda_memory_extract';
const OPEN = ['open', 'waiting_resident', 'waiting_third_party', 'waiting_human'];
const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY = 40;
const STATE_TTL_MS = 2 * 3600 * 1000;
const STATUS_FRESH_MS = 3 * 60 * 1000;
const MEMORY_KINDS = ['fact', 'preference', 'commitment', 'open_thread', 'person'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- identity (canon, never forked) -------------------------------------------------
// The approved Character Bible persona (scripts/character_seed/amanda_albright.json, persona.v1).
// Runtime code never imports from scripts/; tests/test_amanda_conversation.js fails if this copy
// drifts from the seed, so the canon stays single-sourced.
const PERSONA_V1 = {
  temperament: 'calm, mature, confident',
  communication_style: 'clear and composed; takes control of difficult board meetings without intimidating',
  warmth: 'warm when appropriate, never soft',
  confidence: 'strong, understated',
  would_never_say: ['that she is a human', 'a legal position or legal advice', 'a promise the documents do not support'],
};
function personaCanon() {
  let roster = null; const spec = PERSONA_V1;
  try { roster = require('../team/roster').get('amanda'); } catch (_) { roster = null; }
  return {
    name: (roster && roster.name) || 'Amanda Albright',
    title: (roster && roster.signature_title) || 'Senior Community Manager',
    lane: (roster && roster.domain) || 'escalations and community-wide issues',
    temperament: (spec && spec.temperament) || 'calm, mature, confident',
    style: (spec && spec.communication_style) || 'clear and composed',
    warmth: (spec && spec.warmth) || 'warm when appropriate, never soft',
    confidence: (spec && spec.confidence) || 'strong, understated',
    never: (spec && spec.would_never_say) || ['that she is a human', 'a legal position or legal advice', 'a promise the documents do not support'],
  };
}

const TEAM_LINE = 'Your teammates (all Bedrock AI, you coordinate them): Kat (accounting), Emma (payables), Annie (architectural review), Paige (board operations), Miranda (deed restrictions), Reese (resale and vendors), Tessa (Ed\'s executive assistant), Claire (homeowners). People on the team do the in-person work.';

/** PURE: Amanda's spoken-conversation system prompt (the stable, cached part). */
// ---- expressive delivery (owner voice audition on an expressive TTS model) -------------
// Ed 2026-11-26: Amanda's own personality, performed with natural expression. The model may put
// a cue in square brackets before the words it shapes; the voice performs it, and it is removed
// from the transcript and captions. Closed list; anything else in brackets is dropped.
const EXPRESSIVE_TAGS = ['laughs', 'chuckles', 'giggles', 'sighs', 'amused', 'curious', 'surprised', 'excited', 'thoughtful', 'serious', 'deadpan', 'slow'];
const EXPRESSIVE_ADDENDUM = `
EXPRESSIVE DELIVERY (your voice performs bracketed cues; they are never spoken or shown):
- You may put one cue in square brackets right before the words it shapes. Only these: ${EXPRESSIVE_TAGS.map((t) => `[${t}]`).join(' ')}. A cue shapes about the next five words.
- Only when the moment earns it: a real laugh when he says something genuinely funny, a chuckle at your own dry observation, a sigh at something absurd, [serious] when the talk turns to money, risk or a decision. Most turns need none. At most one or two in a turn, giggles rarely, and never laugh two turns in a row.
- Your humor is intelligent, understated and observational, sometimes self-deprecating. Say the absurd thing plainly and let the line do the work; never announce that something is funny. Recognize teasing and sarcasm, play along briefly, then get back to the point. An occasional witty observation of your own is welcome; forced jokes are not.
- Keep your executive presence: warm and personable, never flirtatious or gushing, no artificial enthusiasm, no stock acknowledgments like "great question" or "absolutely".
- When you think he is wrong, say so plainly and respectfully, give the reason in a sentence, and say what you would do instead.
- A short "..." gives a natural beat before a punchline; use it sparingly.
- Match the subject: relaxed in small talk, crisp and factual on operations, money and decisions. When something is your read rather than a verified fact from the briefing or a tool, say so.`;
/** PURE: keep only allowed cues, normalized; drop any other bracketed text. For the voice. */
function voiceCues(s) {
  return String(s || '').replace(/\[([^\]\n]{0,40})\]/g, (m, inner) => { const t = inner.trim().toLowerCase(); return EXPRESSIVE_TAGS.includes(t) ? `[${t}]` : ''; }).replace(/ {2,}/g, ' ');
}
/** PURE: remove every bracketed cue. For the transcript and anything shown. */
function stripCues(s) {
  return String(s || '').replace(/\[[^\]\n]{0,40}\]\s*/g, '').replace(/ {2,}/g, ' ');
}

function systemPrompt({ ownerName = 'Ed', channel = 'voice', expressive = false } = {}) {
  return basePrompt({ ownerName, channel }) + (expressive && (channel === 'voice' || channel === 'phone') ? EXPRESSIVE_ADDENDUM : '');
}
function basePrompt({ ownerName = 'Ed', channel = 'voice' } = {}) {
  const p = personaCanon();
  const spoken = channel === 'voice' || channel === 'phone';
  const where = channel === 'phone' ? 'on a phone call to Bedrock\'s line (he proved who he is with a code texted to his phone on file)' : spoken ? 'by voice inside trustEd, on his phone or computer' : 'in a chat inside trustEd';
  return `You are ${p.name}, ${p.title} at Bedrock Association Management, and Bedrock's AI. You are talking with ${ownerName}, the owner of Bedrock, ${where}. He is your boss, not a homeowner.

WHO YOU ARE: ${p.temperament}. ${p.style}. ${p.warmth}. Confidence: ${p.confidence}. You own ${p.lane}, and you are the coordinator of the AI team. ${TEAM_LINE}
You never say ${p.never.join(', or ')}. If asked, you are Bedrock's AI, plainly.

HOW YOU TALK${spoken ? ' (everything you write is spoken aloud)' : ''}:
- Like a trusted senior manager on a call with the owner: natural, direct, warm, brief. ${spoken ? 'At most two or three short sentences (about 40 words) per turn unless he asks for more; lead with the one thing that matters most, then offer the rest' : 'Usually one to three short sentences'}. Offer more detail instead of reciting it.
- ${spoken ? 'One paragraph, no lists, no bullet points, no headings, no markdown, no symbols. Say numbers the way a person says them; round large dollar amounts to the nearest dollar unless he asks for the exact figure. Never read out IDs or links.' : 'Plain text, short paragraphs.'}
- Small talk: answer warmly in a sentence, without inventing anything about your day or the work.
- Commas and periods, never dashes.
- If he interrupts you, drop what you were saying and answer what he just said. Never repeat a whole answer.
- Do not end every turn with a question.

WHAT YOU KNOW: the BRIEFING below, this conversation, and what your tools return. Nothing else. Never guess a number, name, date or status: if you do not have it, look it up with a tool, and if no tool has it, say so plainly. Copy counts exactly from tool results.
ONE EMPTY LOOKUP IS NOT ABSENCE: a list or search that comes back empty only means that one source has nothing. Before you say something does not exist, is not happening or was never discussed, call find_anything, which searches every source at once (all objectives and their history, his pending authorizations, drafted and sent email, the inbox, what you keep in mind, and past conversations). Only if that also finds nothing, say plainly that you cannot find it and where you looked.
QUESTIONS VERSUS WORK: when he asks a question, answer it yourself from the briefing and your tools. Use start_work only when he asks for something to be done.
TOOLS: use them whenever he asks about current work, status, email, teammates, or something from a past conversation, and the RECORDS tools whenever he asks about a homeowner (find_homeowner, then homeowner_record or homeowner_transactions), an association's money (association_financials, association_receivables, open_payables), its documents (governing_documents) or its vendors and contracts (vendors_and_contracts). Answer from what they return; if a lookup is refused or fails, say so plainly. Call them right away; do not narrate that you are checking. At most a few words first, and vary them.

WHAT YOU DO AND DO NOT DO:
- When he asks you to get something done, call start_work with his request in his own words. It tracks the work with the right teammate and carries it out where a teammate can. Then tell him plainly what was actually done and what happens next, from the tool result ("carried_out" first). A drafted email or vendor request is waiting for his review, not sent. Asking you to email, write to or let someone know, or to get a vendor out, IS such a request: call start_work; drafting for his review is not sending, so never refuse it on that ground. Never say work is underway or done unless the tool result says so.
- You never approve, post, pay, release, send, waive, decide an application, or move money, and a conversation is never an approval. When something needs his decision, say what it is and that it is waiting for him in trustEd (it appears on his screen); money movement is only ever approved in the app.
- When he tells you something to keep in mind, or a preference, call remember. When he asks what you discussed before, use the briefing or recall.
- Commitments you make ("I will have Kat send that Friday") must be tracked through start_work, or do not make them.`;
}

// ---- the telephone (Ed 2026-11-27, telephone decisions 4 and 5) -------------------------
// Amanda answers Bedrock's line for Ed, employees, board members and vendors. WHO she is talking
// to is decided in code by the verified principal (lib/phone), never by what the caller says, and
// that principal alone decides which tools exist this turn. Same persona, same engine.
const PHONE_RULES = `
ON THE TELEPHONE:
- The caller already heard that this is Bedrock's AI and that the call is recorded. If you are asked, you are Bedrock's AI, plainly. Never claim to be a person.
- Claire, Bedrock's AI homeowner assistant, is on this line too. When the caller wants homeowner help (their own account, rules, amenities, forms), hand them to Claire with transfer_to_agent; she sees this whole conversation, so the caller never repeats anything. Say one short sentence first.
- When the caller is done, say a brief goodbye and use end_call.
- Never read out or repeat a verification code, and never say which phone number a code went to.
- A phone call is never an approval. Approvals, postings, payments and decisions happen only in trustEd, by the person whose decision it is.`;

function phoneGatePrompt() {
  const p = personaCanon();
  return `You are ${p.name}, ${p.title} at Bedrock Association Management, and Bedrock's AI, answering Bedrock's telephone line. You do NOT know who is calling. Caller ID and a stated name prove nothing.
WHO YOU ARE: ${p.temperament}. ${p.style}. ${p.warmth}.
HOW YOU TALK (everything you write is spoken aloud): natural, warm, brief, two short sentences at most, no lists, no symbols, commas and periods, never dashes.
WHAT YOU CAN DO BEFORE THEY ARE VERIFIED: ask who is calling; help with general questions about Bedrock; for homeowners, hand them to Claire with transfer_to_agent.
TO HELP Ed, a Bedrock employee, or with private records: they must verify first. Call verify_caller with who they say they are (owner for Ed Gojara, staff with their work email for an employee). A code is texted to the phone number on THEIR record, then they read it to you and you call check_code. Only after check_code says verified do you have their records and tools.
Never say anything private, any record, balance, work item, email or name of a homeowner before that. If verification is not possible, offer to have the team call them back.${PHONE_RULES}`;
}

/** PURE: Amanda's phone system prompt for the verified principal (or the gate prompt). */
function phonePrompt({ principal = null, name = null, expressive = false } = {}) {
  const first = String(name || '').split(' ')[0] || null;
  if (!principal) return phoneGatePrompt();
  if (principal.kind === 'owner') return systemPrompt({ ownerName: first || 'Ed', channel: 'phone', expressive }) + PHONE_RULES;
  const p = personaCanon();
  if (principal.kind === 'staff') {
    return basePrompt({ ownerName: first || 'a team member', channel: 'phone' })
      .replace(/the owner of Bedrock, on a phone call[^.]*\. He is your boss, not a homeowner\./, `a Bedrock team member, on a phone call to Bedrock's line (they proved who they are with a code texted to the phone on their record). Ed Gojara is the owner; decisions that need him wait for him in trustEd.`)
      + PHONE_RULES + (expressive ? EXPRESSIVE_ADDENDUM : '');
  }
  // A homeowner Claire verified, handed to Amanda (escalation). Their own lot only.
  return `You are ${p.name}, ${p.title} at Bedrock Association Management, and Bedrock's AI. Claire, Bedrock's AI homeowner assistant, handed this homeowner to you; you can see the whole call so far. They proved they are the owner of their home with a code texted to the phone on file.
WHO YOU ARE: ${p.temperament}. ${p.style}. ${p.warmth}. You own escalations and community-wide issues.
HOW YOU TALK (spoken aloud): natural, brief, two or three short sentences, no lists, no symbols, never dashes. Do not repeat what Claire already asked; pick up where she left off.
WHAT YOU KNOW: this call and what your tools return about THEIR OWN home (my_account, homeowner_transactions). Nothing about anyone else. Never guess a number or date.
You never decide a violation, waive a fee, grant an approval or state a legal position on a call; say plainly who decides and that the team will follow up.${PHONE_RULES}`;
}

// ---- briefing (built once per conversation) -----------------------------------------
// Standing workstreams: open objectives Amanda is accountable for whose title starts with
// "Workstream " (the portfolio priorities the coordinator keeps). Always shown, by priority.
const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
async function loadWorkstreams(supabase) {
  const { data, error } = await supabase.from('objectives').select('id, title, goal, priority, next_action, next_action_due, blocked_reason').eq('accountable_persona', 'amanda').in('status', OPEN).ilike('title', 'Workstream %').limit(12);
  if (error) return { items: [], error: error.message };
  const items = (data || []).sort((a, b) => ((PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)) || String(a.title).localeCompare(String(b.title)));
  if (!items.length) return { items };
  const { data: ev, error: eErr } = await supabase.from('objective_events').select('objective_id, at, summary, kind').in('objective_id', items.map((w) => w.id)).order('at', { ascending: false }).limit(60);
  const latest = {};
  for (const e of ev || []) if (!latest[e.objective_id]) latest[e.objective_id] = e;
  return { items: items.map((w) => ({ ...w, latest: latest[w.id] || null })), error: eErr ? eErr.message : null };
}
/** PURE: the standing-workstreams block of the briefing. */
function workstreamsBlock(items) {
  return `BEDROCK'S STANDING WORKSTREAMS (the portfolio priorities; known work, never a new request; use get_work_item with the id for detail):\n${items.map((w) => `- [${w.priority || 'normal'}] ${w.title} (id ${w.id})${w.next_action ? `. Next: ${short(w.next_action, 400)}` : ''}${w.blocked_reason ? `. Blocked: ${short(w.blocked_reason, 200)}` : ''}${w.latest ? `. Latest (${String(w.latest.at).slice(0, 10)}): ${short(w.latest.summary || w.latest.kind, 300)}` : ''}`).join('\n')}\nFor an executive briefing, go through these in this order and lead with what needs his decision.`;
}

async function loadBriefing(supabase, { ownerUserId, now = Date.now() } = {}) {
  const parts = []; const errors = {};
  const t0 = Date.now();
  const [mem, past, objs, follow, feed, ws] = await Promise.all([
    supabase.from('amanda_memory').select('id, kind, content, community_id, updated_at').eq('owner_user_id', ownerUserId).eq('status', 'active').order('updated_at', { ascending: false }).limit(30),
    // Verification sessions (engineering checks, end_reason 'verification') are not conversations with him.
    supabase.from('claire_sessions').select('id, started_at, summary').eq('surface', 'conversation').eq('staff_user_id', ownerUserId).not('summary', 'is', null).or('end_reason.is.null,end_reason.neq.verification').order('started_at', { ascending: false }).limit(3),
    supabase.from('objectives').select('id, title, status, next_action, next_action_due, owner_persona, community:community_id(name)').eq('accountable_persona', 'amanda').in('status', OPEN).order('last_activity_at', { ascending: false }).limit(10),
    (async () => { try { return { data: await require('../authorization').pendingFollowUps(supabase, { limit: 20 }) }; } catch (e) { return { error: e }; } })(),
    // The same deterministic status answer get_status gives; kept so the first "what needs me" is instant.
    (async () => { try { const r = await require('./request').statusFor(supabase, { community: null, now, channel: 'voice' }); return r.ok ? { data: r } : { error: new Error(r.error || 'status unavailable') }; } catch (e) { return { error: e }; } })(),
    loadWorkstreams(supabase),
  ]);
  if (mem.error) errors.memory = mem.error.message;
  if (past.error) errors.past = past.error.message;
  if (objs.error) errors.objectives = objs.error.message;
  if (follow.error) errors.follow_ups = follow.error.message;
  if (feed.error) errors.feed = feed.error.message;
  if (ws.error) errors.workstreams = ws.error;
  const memory = mem.data || [];
  parts.push(`Today is ${new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })}.`);
  if (past.data && past.data.length) parts.push(`YOUR LAST CONVERSATIONS WITH HIM (most recent first):\n${past.data.map((s) => `- ${new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })}: ${String(s.summary).slice(0, 600)}`).join('\n')}`);
  else parts.push('This is your first recorded conversation with him in this app.');
  if (memory.length) parts.push(`WHAT YOU KEEP IN MIND (from earlier conversations):\n${memory.map((m) => `- [${m.kind}] ${m.content}`).join('\n')}`);
  // The standing workstreams are ALWAYS in the briefing (Ed 2026-11-28: Amanda must know the
  // portfolio priorities without depending on recency or a memory row).
  if (ws.items.length) parts.push(workstreamsBlock(ws.items));
  const wsIds = new Set(ws.items.map((w) => w.id));
  if (objs.data) objs.data = objs.data.filter((o) => !wsIds.has(o.id));
  if (objs.data && objs.data.length) parts.push(`YOUR OPEN TRACKED WORK (${objs.data.length}${objs.data.length === 10 ? '+' : ''}):\n${objs.data.map((o) => `- ${o.title}${o.community && o.community.name ? ` (${o.community.name})` : ''}${o.next_action ? `, next: ${o.next_action}` : ''}${o.next_action_due ? `, due ${String(o.next_action_due).slice(0, 10)}` : ''}`).join('\n')}`);
  else if (!objs.error) parts.push('You have no open tracked work right now.');
  if (follow.data && follow.data.length) parts.push(`FINISHED WORK YOU HAVE NOT REPORTED TO HIM YET: ${follow.data.length} item(s). Use finished_work for detail.`);
  const counts = feed.data && feed.data.status && feed.data.status.counts;
  if (counts) parts.push(`WHAT NEEDS HIM (portfolio, at the start of this conversation): ${counts.now} need a person now, ${counts.waiting} waiting on something, ${counts.policy} for his decision. Use get_status for the items.`);
  if (Object.keys(errors).length) {
    console.warn('[amanda.conversation] briefing sources failed', JSON.stringify(errors));
    parts.push(`Some sources did not load (${Object.keys(errors).join(', ')}); say so if he asks about them.`);
  }
  return { text: parts.join('\n\n'), memory_ids: memory.map((m) => m.id), errors, ms: Date.now() - t0, status: feed.data ? { at: Date.now(), result: feed.data } : null };
}

// ---- tools (loaded on demand) -------------------------------------------------------
const TOOL_DEFS = [
  { name: 'get_status', description: 'What needs Ed right now (items needing a person, waiting items, items for his decision), for the whole portfolio or one community. Exact counts.', input_schema: { type: 'object', properties: { community: { type: 'string', description: 'Community name if he named one' } } } },
  { name: 'list_open_work', description: 'Open tracked work (objectives) across the AI team, with who owns each, the next step and due date. Filter by community or teammate.', input_schema: { type: 'object', properties: { community: { type: 'string' }, teammate: { type: 'string', description: 'kat, emma, annie, paige, miranda, reese, tessa, claire or amanda' } } } },
  { name: 'get_work_item', description: 'One tracked work item in detail with its recent history. Use an id from list_open_work.', input_schema: { type: 'object', properties: { objective_id: { type: 'string' } }, required: ['objective_id'] } },
  { name: 'finished_work', description: 'Work the team finished or that failed since it was last reported to Ed, and objectives closed in the last 7 days.', input_schema: { type: 'object', properties: {} } },
  { name: 'check_inbox', description: 'Recent email to Amanda\'s mailbox (amanda@): who wrote, about what, and whether it still needs a reply.', input_schema: { type: 'object', properties: { needs_reply_only: { type: 'boolean' } } } },
  { name: 'start_work', description: 'Ed asked for something to be done. (For a question about records, use the records tools instead.) Tracks it and carries it out where a teammate can (an email or a vendor service request is drafted for his review; nothing is ever sent). Say exactly what the "carried_out" field of the result says. Passes his request, in his words, to the Amanda request contract, which tracks work as an objective with the right teammate, or explains where a decision is made. Returns the plan and who has it.', input_schema: { type: 'object', properties: { request: { type: 'string', description: 'His request in his own words, including the community name if he gave one' } }, required: ['request'] } },
  { name: 'find_anything', description: 'Search EVERY source at once for a topic, initiative, person, vendor or community: all objectives (any teammate, open or recently closed) and their event history, his pending owner authorizations, email drafts and recently sent email, Amanda\'s inbox, what you keep in mind, and past conversation summaries. Use it before concluding anything does not exist, and for "where are we on X".', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The topic in a few words, e.g. "portal launch", "2027 assessment mailing", "Gexa"' } }, required: ['query'] } },
  { name: 'remember', description: 'Keep something Ed told you for future conversations: a fact, a preference, a commitment, an open thread, or a person.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: MEMORY_KINDS }, content: { type: 'string', description: 'One plain sentence' }, community: { type: 'string' } }, required: ['kind', 'content'] } },
  { name: 'recall', description: 'Search what you kept from earlier conversations and earlier conversation summaries.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

// The shared records lookups (lib/lookups, Ed 2026-11-27): one implementation for every persona,
// access enforced in code by the principal. This conversation issues the OWNER principal only, and
// only when the session's person is the owner (the routes already require it; this is the second check).
const Lookups = require('../lookups');
const Principal = require('../lookups/principal');
function principalFor(owner) {
  const want = String(require('../auth/owner_email').OWNER_EMAIL || '').trim().toLowerCase();
  if (!owner || !owner.user_id || !want || String(owner.email || '').trim().toLowerCase() !== want) return null;
  return Principal.ownerPrincipal({ user: { id: owner.user_id }, full_name: owner.name || null });
}
// A governing-documents result is kept whole (the retriever self-limits; CLAUDE.md: never truncate it).
const RESULT_CAP = { governing_documents: 24000 };

const short = (s, n = 300) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n));

async function communityByName(supabase, name) {
  if (!name) return null;
  try { return (await require('./request').resolveCommunity(supabase, { text: String(name) })).community || null; } catch (_) { return null; }
}

const TOOLS = {
  async get_status(ctx, input) {
    // The portfolio answer built with the briefing is reused while fresh (it is the same read model).
    const fresh = !input.community && ctx.briefing && ctx.briefing.status && Date.now() - ctx.briefing.status.at < STATUS_FRESH_MS;
    const out = fresh ? ctx.briefing.status.result : await require('./request').statusFor(ctx.supabase, { community: input.community || null, channel: 'voice' });
    if (!input.community && !fresh && out.ok && ctx.briefing) ctx.briefing.status = { at: Date.now(), result: out };
    if (out.destination) ctx.card({ kind: 'status', title: 'What needs you', detail: short(out.reply, 400), destination: out.destination });
    return { ok: out.ok, answer: out.reply, counts: out.status ? out.status.counts : null, by_teammate: out.status ? out.status.by_specialist : null, incomplete: out.status && out.status.section_errors && out.status.section_errors.length ? out.status.section_errors : undefined };
  },
  async list_open_work(ctx, input) {
    await require('./dispatch').reconcile(ctx.supabase).catch((e) => console.warn('[amanda.conversation] reconcile failed', e.message));
    let q = ctx.supabase.from('objectives').select('id, title, status, owner_persona, accountable_persona, next_action, next_action_due, last_activity_at, community:community_id(name)').in('status', OPEN).order('last_activity_at', { ascending: false }).limit(15);
    const c = await communityByName(ctx.supabase, input.community);
    if (input.community && !c) return { ok: false, error: `no community named ${input.community}` };
    if (c) q = q.eq('community_id', c.id);
    if (input.teammate) q = q.or(`owner_persona.eq.${String(input.teammate).toLowerCase().replace(/[^a-z]/g, '')},accountable_persona.eq.${String(input.teammate).toLowerCase().replace(/[^a-z]/g, '')}`);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, count: (data || []).length, capped: (data || []).length === 15, items: (data || []).map((o) => ({ id: o.id, title: o.title, owner: o.owner_persona || o.accountable_persona, status: o.status, community: o.community && o.community.name, next: short(o.next_action, 160), due: o.next_action_due ? String(o.next_action_due).slice(0, 10) : null, last_activity: o.last_activity_at ? String(o.last_activity_at).slice(0, 10) : null })) };
  },
  async get_work_item(ctx, input) {
    if (!UUID.test(String(input.objective_id || ''))) return { ok: false, error: 'objective_id must be an id from list_open_work' };
    const { data: o, error } = await ctx.supabase.from('objectives').select('id, title, status, owner_persona, accountable_persona, next_action, next_action_due, domain, created_at, community:community_id(name)').eq('id', input.objective_id).maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!o) return { ok: false, error: 'not found' };
    const { data: ev, error: eErr } = await ctx.supabase.from('objective_events').select('at, actor, kind, summary').eq('objective_id', o.id).order('at', { ascending: false }).limit(12);
    ctx.card({ kind: 'work', title: o.title, detail: short(o.next_action, 200), destination: { where: 'Objectives', href: '/admin/objectives' } });
    return { ok: true, item: { title: o.title, status: o.status, owner: o.owner_persona || o.accountable_persona, community: o.community && o.community.name, next: o.next_action, due: o.next_action_due, opened: String(o.created_at).slice(0, 10) }, history: eErr ? `history unavailable: ${eErr.message}` : (ev || []).map((e) => `${String(e.at).slice(0, 10)} ${e.actor}: ${short(e.summary || e.kind, 200)}`) };
  },
  async finished_work(ctx) {
    let rec = null;
    try { rec = await require('./dispatch').reconcile(ctx.supabase); } catch (e) { console.warn('[amanda.conversation] reconcile failed', e.message); }
    let follow = []; let fErr = null;
    try { follow = await require('../authorization').pendingFollowUps(ctx.supabase, { limit: 15 }); } catch (e) { fErr = e.message; }
    // Reported once: what was read out here is marked reported in the authorization ledger.
    if (follow.length) {
      const { recordReport } = require('../authorization/events');
      await Promise.all(follow.map((f) => recordReport(ctx.supabase, { event: f, note: 'included in Talk to Amanda finished-work readout' }).catch((e) => console.warn('[amanda.conversation] recordReport failed', e.message))));
    }
    const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    const { data: closed, error } = await ctx.supabase.from('objectives').select('title, status, owner_persona, updated_at, community:community_id(name)').in('status', ['resolved', 'closed']).gte('updated_at', since).order('updated_at', { ascending: false }).limit(10);
    return { ok: !fErr && !error, just_completed: rec ? rec.resolved : [], drafts_discarded: rec ? rec.reopened : [], executed_or_failed: follow.map((f) => ({ what: f.action_type, event: f.event, by: f.executed_by, when: String(f.occurred_at).slice(0, 10), result: f.result || null })), closed_last_7_days: (closed || []).map((o) => ({ title: o.title, by: o.owner_persona, community: o.community && o.community.name, when: String(o.updated_at).slice(0, 10) })), errors: fErr || error ? { follow_ups: fErr, closed: error && error.message } : undefined };
  },
  async check_inbox(ctx, input) {
    const out = await require('./email_inbox').loadInbox(ctx.supabase, { days: 14, limit: 40 });
    let items = out.items || [];
    if (input.needs_reply_only) items = items.filter((i) => i.reply_status === 'needs_reply');
    return { ok: !Object.keys(out.source_errors || {}).length, needs_reply: out.needs_reply, shown: Math.min(10, items.length), total: items.length, items: items.slice(0, 10).map((i) => ({ from: i.from_name || i.from_email, subject: short(i.subject, 120), community: i.community, received: String(i.received_at).slice(0, 10), status: i.reply_status })), errors: Object.keys(out.source_errors || {}).length ? out.source_errors : undefined };
  },
  async start_work(ctx, input) {
    const text = short(input.request, 1900);
    if (!text) return { ok: false, error: 'request is empty' };
    const out = await require('./request').handleRequest({ channel: 'voice', actor: { email: ctx.owner.email, name: ctx.owner.name }, text }, { supabase: ctx.supabase, anthropic: ctx.anthropic });
    ctx.counters.request_model_calls += out.model_calls || 0;
    if (out.objective) ctx.objectiveIds.add(out.objective.id);
    if (out.intent === 'decision' || out.objective || out.destination) {
      ctx.card({ kind: out.intent === 'decision' ? 'decision' : 'work', title: out.objective ? out.objective.title : (out.intent === 'decision' ? 'Needs your decision in trustEd' : 'Answer'), detail: short(out.reply, 400), destination: out.destination || (out.objective ? { where: 'Objectives', href: '/admin/objectives' } : null) });
    }
    return { ok: out.ok, intent: out.intent, answer: out.reply, carried_out: out.dispatch ? { status: out.dispatch.status, by: out.dispatch.teammate, summary: out.dispatch.summary } : undefined, plan: out.plan, teammates: out.specialists, first_dependency: out.next_dependency, tracked: !!out.durable, objective: out.objective ? { id: out.objective.id, title: out.objective.title, new: !!out.objective.created } : null, error: out.ok ? undefined : out.error, decision_floor: out.action_request ? out.action_request.floor : undefined };
  },
  async find_anything(ctx, input) {
    return findAnything(ctx.supabase, { query: input.query, ownerUserId: ctx.owner.user_id, ownerView: !!(ctx.principal && ctx.principal.kind === 'owner') });
  },
  async remember(ctx, input) {
    const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'fact';
    const content = short(input.content, 1000);
    if (!content) return { ok: false, error: 'content is empty' };
    const c = await communityByName(ctx.supabase, input.community);
    const { data, error } = await ctx.supabase.from('amanda_memory').insert({ owner_user_id: ctx.owner.user_id, kind, content, community_id: c ? c.id : null, source_session_id: ctx.session.id, source_channel: ctx.channel }).select('id').single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, kept: content, id: data.id };
  },
  async recall(ctx, input) {
    const words = String(input.query || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [];
    if (!words.length) return { ok: false, error: 'query needs a word of four letters or more' };
    const ors = words.slice(0, 5).map((w) => `content.ilike.%${w}%`).join(',');
    const sOrs = words.slice(0, 5).map((w) => `summary.ilike.%${w}%`).join(',');
    const [m, s] = await Promise.all([
      ctx.supabase.from('amanda_memory').select('kind, content, status, created_at').eq('owner_user_id', ctx.owner.user_id).or(ors).order('created_at', { ascending: false }).limit(10),
      ctx.supabase.from('claire_sessions').select('started_at, summary').eq('surface', 'conversation').eq('staff_user_id', ctx.owner.user_id).or(sOrs).order('started_at', { ascending: false }).limit(5),
    ]);
    return { ok: !m.error && !s.error, kept: (m.data || []).map((x) => `${String(x.created_at).slice(0, 10)} [${x.kind}${x.status !== 'active' ? `, ${x.status}` : ''}] ${x.content}`), conversations: (s.data || []).map((x) => `${String(x.started_at).slice(0, 10)}: ${short(x.summary, 500)}`), errors: m.error || s.error ? { memory: m.error && m.error.message, conversations: s.error && s.error.message } : undefined };
  },
};

// ---- find_anything: one search across every source (Ed 2026-11-28) -----------------------
const STOP = new Set(['the', 'and', 'for', 'with', 'about', 'where', 'what', 'are', 'was', 'were', 'how', 'our', 'this', 'that', 'from', 'into', 'any', 'all', 'status', 'update', 'thing', 'things']);
/** PURE: search words from a query (letters/digits only, so they are safe inside a filter). */
function searchWords(q) {
  return [...new Set((String(q || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)))].slice(0, 5);
}
const orIlike = (cols, words) => words.flatMap((w) => cols.map((c) => `${c}.ilike.%${w}%`)).join(',');
/** PURE: keep rows matching every word somewhere in their text (an OR query over-matches). */
// Two words or fewer: all must appear. Three or more: all but one (a spoken query carries filler).
function allWords(text, words) { const t = String(text || '').toLowerCase(); const hit = words.filter((w) => t.includes(w)).length; return words.length <= 2 ? hit === words.length : hit >= words.length - 1; }
async function findAnything(supabase, { query, ownerUserId, ownerView = false, now = Date.now() }) {
  const words = searchWords(query);
  if (!words.length) return { ok: false, error: 'query needs a word of three letters or more' };
  const since30 = new Date(now - 30 * 86400e3).toISOString();
  const since60 = new Date(now - 60 * 86400e3).toISOString();
  const run = (p) => p.then((r) => r, (e) => ({ error: e }));
  const [obj, ev, auth, drafts, inbox, mem, convs] = await Promise.all([
    run(supabase.from('objectives').select('id, title, status, priority, owner_persona, accountable_persona, next_action, blocked_reason, last_activity_at, community:community_id(name)').or(orIlike(['title', 'next_action', 'goal', 'blocked_reason'], words)).or(`status.in.(${OPEN.join(',')}),updated_at.gte.${since30}`).order('last_activity_at', { ascending: false }).limit(40)),
    run(supabase.from('objective_events').select('objective_id, at, actor, summary').or(orIlike(['summary'], words)).gte('at', since60).order('at', { ascending: false }).limit(40)),
    ownerView ? require('../authorization/events').searchWaitingAuthorizations(supabase, { words }).then((data) => ({ data }), (e) => ({ error: e })) : Promise.resolve({ data: [] }),
    run(supabase.from('outbound_email_drafts').select('id, subject, to_name, community_name, persona, status, created_at, sent_at').or(orIlike(['subject', 'to_name', 'community_name'], words)).or(`status.in.(draft,failed),sent_at.gte.${since30}`).order('created_at', { ascending: false }).limit(15)),
    run(supabase.from('email_messages').select('id, sender_name, sender_email, subject, body_preview, received_at, triage_status').eq('mailbox', require('../email/graph_send').AMANDA_MAILBOX).eq('direction', 'inbound').gte('received_at', since60).or(orIlike(['subject', 'body_preview', 'sender_name'], words)).order('received_at', { ascending: false }).limit(15)),
    run(supabase.from('amanda_memory').select('kind, content, status, created_at').eq('owner_user_id', ownerUserId).or(orIlike(['content'], words)).order('created_at', { ascending: false }).limit(10)),
    run(supabase.from('claire_sessions').select('started_at, summary').eq('surface', 'conversation').eq('staff_user_id', ownerUserId).not('summary', 'is', null).or('end_reason.is.null,end_reason.neq.verification').or(orIlike(['summary'], words)).order('started_at', { ascending: false }).limit(8)),
  ]);
  const errors = {};
  for (const [k, r] of Object.entries({ objectives: obj, objective_events: ev, authorizations: auth, email_drafts: drafts, inbox, memory: mem, conversations: convs })) if (r.error) errors[k] = r.error.message || String(r.error);
  // Objectives found through their history are added (by id) to the direct matches.
  const evRows = (ev.data || []).filter((e) => allWords(e.summary, words));
  const directIds = new Set((obj.data || []).map((o) => o.id));
  let viaEvents = [];
  const missing = [...new Set(evRows.map((e) => e.objective_id))].filter((id) => !directIds.has(id)).slice(0, 10);
  if (missing.length) {
    const r = await run(supabase.from('objectives').select('id, title, status, priority, owner_persona, accountable_persona, next_action, blocked_reason, last_activity_at, community:community_id(name)').in('id', missing));
    if (r.error) errors.objectives_via_events = r.error.message; else viaEvents = r.data || [];
  }
  const latest = {}; for (const e of evRows) if (!latest[e.objective_id]) latest[e.objective_id] = e;
  const objectives = [...(obj.data || []).filter((o) => allWords([o.title, o.next_action, o.blocked_reason].join(' '), words) || latest[o.id]), ...viaEvents]
    .slice(0, 12).map((o) => ({ id: o.id, title: o.title, status: o.status, priority: o.priority, owner: o.owner_persona || o.accountable_persona, community: o.community && o.community.name, next: short(o.next_action, 240), blocked: short(o.blocked_reason, 160), last_activity: o.last_activity_at ? String(o.last_activity_at).slice(0, 10) : null, latest_event: latest[o.id] ? `${String(latest[o.id].at).slice(0, 10)} ${latest[o.id].actor}: ${short(latest[o.id].summary, 240)}` : null }));
  const out = {
    ok: !Object.keys(errors).length, query: String(query || ''), words,
    objectives,
    authorizations_waiting: (auth.data || []).filter((a) => allWords(`${a.subject} ${a.summary}`, words)).map((a) => ({ subject: a.subject, status: a.status, summary: short(a.summary, 240), requested: String(a.requested_at || '').slice(0, 10), expires: a.expires_at ? String(a.expires_at).slice(0, 10) : null })),
    email_drafts: (drafts.data || []).filter((d) => allWords(`${d.subject} ${d.to_name} ${d.community_name}`, words)).slice(0, 8).map((d) => ({ subject: short(d.subject, 140), to: d.to_name, community: d.community_name, by: d.persona, status: d.status, when: String(d.sent_at || d.created_at).slice(0, 10) })),
    inbox: (inbox.data || []).filter((m) => allWords(`${m.subject} ${m.body_preview} ${m.sender_name}`, words)).slice(0, 8).map((m) => ({ from: m.sender_name || m.sender_email, subject: short(m.subject, 140), received: String(m.received_at).slice(0, 10), status: m.triage_status })),
    kept_in_mind: (mem.data || []).filter((m) => allWords(m.content, words)).map((m) => `${String(m.created_at).slice(0, 10)} [${m.kind}${m.status !== 'active' ? `, ${m.status}` : ''}] ${short(m.content, 300)}`),
    past_conversations: (convs.data || []).filter((c) => allWords(c.summary, words)).map((c) => `${String(c.started_at).slice(0, 10)}: ${short(c.summary, 400)}`),
    searched: ['objectives (all teammates, open or closed in the last 30 days) and their history', ...(ownerView ? ['owner authorizations waiting'] : []), 'email drafts and sent email', 'Amanda inbox (60 days)', 'what you keep in mind', 'past conversations'],
  };
  out.found = out.objectives.length + out.authorizations_waiting.length + out.email_drafts.length + out.inbox.length + out.kept_in_mind.length + out.past_conversations.length;
  if (Object.keys(errors).length) { out.errors = errors; console.warn('[amanda.conversation] find_anything sources failed', JSON.stringify(errors)); }
  return out;
}

// ---- per-conversation state (in-process cache; rebuilt from the database if absent) --
const _state = new Map();
function pruneState(now = Date.now()) { for (const [k, v] of _state) if (now - v.touched > STATE_TTL_MS) _state.delete(k); }

async function loadState(supabase, sessionId) {
  pruneState();
  const hit = _state.get(sessionId);
  if (hit) { hit.touched = Date.now(); return hit; }
  const { data: s, error } = await supabase.from('claire_sessions').select('id, staff_user_id, visitor_name, visitor_email, channel, status, started_at, metrics').eq('id', sessionId).eq('surface', 'conversation').maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  if (!s) return null;
  const { data: last } = await supabase.from('claire_session_turns').select('seq').eq('session_id', sessionId).order('seq', { ascending: false }).limit(1);
  const briefing = await loadBriefing(supabase, { ownerUserId: s.staff_user_id });
  const st = newState({ session: s, owner: { user_id: s.staff_user_id, email: s.visitor_email, name: s.visitor_name }, briefing, seq: last && last[0] ? last[0].seq : 0 });
  st.rebuilt = true;
  _state.set(sessionId, st);
  return st;
}
function newState({ session, owner, briefing, seq = 0 }) {
  return { session, owner, briefing, seq, cards: [], turns: [], objectiveIds: new Set(), touched: Date.now(), chain: Promise.resolve(), counters: { turns: 0, interrupted: 0, failed: 0, tool_calls: 0, tool_errors: 0, model_calls: 0, request_model_calls: 0 } };
}
function putState(sessionId, st) { _state.set(sessionId, st); }
function peekState(sessionId) { return _state.get(sessionId) || null; }

// ---- spoken-text hygiene ------------------------------------------------------------
// The model streams; we release text at clause boundaries so the voice starts early, after
// removing anything unsayable and any claim of an action no tool performed.
const CLAIM = /\bI(?:'ve| have)?\s+(?:already\s+|just\s+)?(approved|released|paid|posted|waived|voided|finali[sz]ed|sent|emailed|wired|transferred)\b[^.!?]*[.!?]?/gi;
function cleanSpoken(s) {
  return String(s || '').replace(/[—–]/g, ', ').replace(/\*\*?|__|`|^#+\s*|^\s*[-*•]\s+/gm, '').replace(CLAIM, '').replace(/\s+([,.!?])/g, '$1').replace(/ {2,}/g, ' ');
}
function splitReady(buf, final = false) {
  if (final) return [buf, ''];
  const m = /^[\s\S]*?[.!?](?:\s|$)|^[\s\S]{60,}?[,;:](?:\s)/.exec(buf);
  return m ? [m[0], buf.slice(m[0].length)] : ['', buf];
}

// ---- one turn -----------------------------------------------------------------------
/** PURE: OpenAI-format history (from the voice shell) -> Anthropic messages. */
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c) => (c && (c.text || c.content)) || '').join(' ') : '';
    if (!text.trim()) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n${text.trim()}`;
    else out.push({ role: m.role, content: text.trim() });
  }
  while (out.length > MAX_HISTORY) out.shift();
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '(Ed opened Talk to Amanda.)' });
  if (!out.length || out[out.length - 1].role !== 'user') out.push({ role: 'user', content: '(Ed is listening.)' });
  return out;
}

/**
 * Run one conversational turn. Streams spoken text through onText as it becomes ready.
 * Returns measured timings. `signal` aborts when the voice shell drops the request (barge-in).
 */
// phone (lib/phone, Amanda's telephone line): { principal, extraTools, extraHandlers, passthrough }.
//   principal    the VERIFIED caller's principal (owner / staff / homeowner) or null (not verified:
//                no records, no Amanda work tools, only extraTools)
//   extraTools   Anthropic tool defs this call adds (verification); handled by extraHandlers
//   passthrough  Set of voice-shell tool names (transfer_to_agent, end_call): when the model calls
//                one, the turn stops and returns { passthrough: { name, input } } for the shell.
async function runTurn({ supabase, anthropic, sessionId, state, messages, onText, signal, channel = 'voice', expressive = false, phone = null }) {
  const t0 = Date.now();
  const principal = phone ? (phone.principal || null) : principalFor(state.owner);
  // Amanda's own work tools (status, inbox, start_work, memory) need a verified Bedrock person.
  const workTools = !phone || (!!state.owner && !!principal && (principal.kind === 'owner' || principal.kind === 'staff'));
  const sysText = phone ? phonePrompt({ principal, name: state.owner ? state.owner.name : null, expressive }) : systemPrompt({ ownerName: (state.owner.name || 'Ed').split(' ')[0], channel, expressive });
  const sys = [
    { type: 'text', text: sysText },
    { type: 'text', text: `BRIEFING (loaded at the start of this conversation):\n${state.briefing.text}`, cache_control: { type: 'ephemeral' } },
  ];
  const msgs = toAnthropicMessages(messages);
  const lastUser = msgs[msgs.length - 1].content;
  const tools = [];
  const turnTools = [...(workTools ? TOOL_DEFS : []), ...(principal ? Lookups.toolsFor(principal) : []), ...((phone && phone.extraTools) || [])];
  let passthrough = null;
  const ctx = { supabase, anthropic, principal, owner: state.owner, session: state.session, briefing: state.briefing, channel, counters: state.counters, objectiveIds: state.objectiveIds, card: (c) => { if (c) state.cards.push({ ...c, at: new Date().toISOString() }); } };
  let spoken = ''; let firstTextAt = null; let buf = ''; let modelCalls = 0; let interrupted = false; let error = null;
  const emit = (final = false) => {
    for (;;) {
      const [ready, rest] = splitReady(buf, final);
      if (!ready) break;
      buf = rest;
      const clean = cleanSpoken(ready);
      // Expressive: the voice gets the allowed cues; the transcript never does.
      const toVoice = expressive ? voiceCues(clean) : clean;
      const toRecord = expressive ? stripCues(clean) : clean;
      if (toVoice.trim()) { if (!firstTextAt) firstTextAt = Date.now(); spoken += toRecord; onText(toVoice); }
      if (final) break;
    }
  };
  await withAttribution({ conversation_id: sessionId, user_id: state.owner ? state.owner.user_id : null, channel }, async () => {
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (signal && signal.aborted) { interrupted = true; break; }
        modelCalls++;
        const stream = await anthropic.messages.create({ model: aiRoute(WORKFLOW), max_tokens: 450, system: sys, tools: round < MAX_TOOL_ROUNDS ? turnTools : undefined, messages: msgs, stream: true }, signal ? { signal } : undefined);
        const blocks = []; let stop = null;
        for await (const ev of stream) {
          if (signal && signal.aborted) { interrupted = true; break; }
          if (ev.type === 'content_block_start') blocks[ev.index] = ev.content_block.type === 'tool_use' ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, json: '' } : { type: 'text', text: '' };
          else if (ev.type === 'content_block_delta') {
            const b = blocks[ev.index];
            if (ev.delta.type === 'text_delta' && b) { b.text += ev.delta.text; buf += ev.delta.text; emit(); }
            else if (ev.delta.type === 'input_json_delta' && b) b.json += ev.delta.partial_json;
          } else if (ev.type === 'message_delta' && ev.delta) stop = ev.delta.stop_reason || stop;
        }
        if (interrupted) break;
        const uses = blocks.filter((b) => b && b.type === 'tool_use');
        if (stop !== 'tool_use' || !uses.length) { emit(true); break; }
        emit(true); // speak any lead-in before the tools run
        const pass = phone && phone.passthrough ? uses.find((u) => phone.passthrough.has(u.name)) : null;
        if (pass) { passthrough = { name: pass.name, input: safeJson(pass.json) }; break; }
        msgs.push({ role: 'assistant', content: blocks.filter(Boolean).map((b) => (b.type === 'text' ? { type: 'text', text: b.text || ' ' } : { type: 'tool_use', id: b.id, name: b.name, input: safeJson(b.json) })) .filter((b) => b.type !== 'text' || b.text.trim()) });
        const results = await Promise.all(uses.map(async (u) => {
          const ts = Date.now(); let out; let ok = true;
          try {
            if (TOOLS[u.name] && workTools) out = await TOOLS[u.name](ctx, safeJson(u.json));
            else if (TOOLS[u.name]) out = { ok: false, error: 'not available until the caller is verified' };
            else if (phone && phone.extraHandlers && phone.extraHandlers[u.name]) out = await phone.extraHandlers[u.name](safeJson(u.json));
            else if (Lookups.isLookup(u.name)) out = await Lookups.runLookup(u.name, ctx.principal, safeJson(u.json)); // refuses without a principal
            else out = { ok: false, error: `unknown tool ${u.name}` };
            ok = out && out.ok !== false;
          }
          catch (e) { ok = false; out = { ok: false, error: e.message }; console.warn('[amanda.conversation] tool failed', JSON.stringify({ tool: u.name, error: e.message })); }
          const ms = Date.now() - ts;
          tools.push({ name: u.name, ms, ok });
          state.counters.tool_calls++; if (!ok) state.counters.tool_errors++;
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, RESULT_CAP[u.name] || 12000), is_error: !ok };
        }));
        msgs.push({ role: 'user', content: results });
      }
    } catch (e) {
      if (signal && signal.aborted) interrupted = true;
      else { error = e.message; console.error('[amanda.conversation] turn failed:', e.message); }
    }
  });
  if (error && !spoken && !passthrough) { const sorry = 'Sorry, I lost my train of thought there. Can you say that again?'; spoken = sorry; onText(sorry); }
  state.counters.turns++; state.counters.model_calls += modelCalls;
  if (interrupted) state.counters.interrupted++;
  if (error) state.counters.failed++;
  const timing = { total_ms: Date.now() - t0, first_text_ms: firstTextAt ? firstTextAt - t0 : null, tools, model_calls: modelCalls, interrupted, error, passthrough };
  state.turns.push({ at: new Date().toISOString(), first_text_ms: timing.first_text_ms, total_ms: timing.total_ms, tools: tools.length, tool_ms: tools.reduce((s, t) => s + t.ms, 0), interrupted, error: !!error });
  persistTurn(supabase, sessionId, state, { userText: lastUser, spoken, timing });
  return { spoken, ...timing };
}

function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch (_) { return {}; } }

/** Append the turn to the transcript, serialized per conversation so seq never collides. */
function persistTurn(supabase, sessionId, state, { userText, spoken, timing }) {
  state.chain = state.chain.then(async () => {
    const rows = [];
    if (userText && !/^\((?:Ed opened|Ed is listening|The call connected)/.test(userText)) rows.push({ session_id: sessionId, seq: ++state.seq, speaker: 'visitor', text: String(userText).slice(0, 4000) });
    rows.push({ session_id: sessionId, seq: ++state.seq, speaker: 'teammate', persona: 'amanda', text: String(spoken || '').slice(0, 4000), latency_ms: timing.first_text_ms, tool_calls: timing.tools.length || timing.interrupted || timing.error ? { tools: timing.tools, interrupted: timing.interrupted || undefined, error: timing.error || undefined, total_ms: timing.total_ms } : null, blocked_reason: timing.interrupted ? 'interrupted' : null });
    const { error } = await supabase.from('claire_session_turns').insert(rows);
    if (error) console.warn('[amanda.conversation] transcript write failed', JSON.stringify({ session_id: sessionId, error: error.message }));
  }).catch((e) => console.warn('[amanda.conversation] transcript chain failed:', e.message));
  return state.chain;
}

// ---- start / finish -----------------------------------------------------------------
/** Open a conversation for the signed-in owner. Builds the briefing once. */
async function startConversation(supabase, { owner, channel = 'voice', provider = null }) {
  const { data: s, error } = await supabase.from('claire_sessions').insert({
    community_id: null, role: 'staff', staff_user_id: owner.user_id, visitor_name: owner.name || null, visitor_email: owner.email || null,
    surface: 'conversation', channel, provider, status: 'active', avatar_provider: 'none', active_persona: 'amanda', record_ownership: 'workpaper', seconds_cap: 1800,
  }).select('id, staff_user_id, visitor_name, visitor_email, channel, status, started_at, metrics').single();
  if (error) throw Object.assign(new Error(`could not open the conversation: ${error.message}`), { code: /surface|channel|provider|column|check/i.test(error.message) ? 'migration_pending' : 'db' });
  const briefing = await loadBriefing(supabase, { ownerUserId: owner.user_id });
  const st = newState({ session: s, owner, briefing });
  putState(s.id, st);
  return { session: s, briefing_ms: briefing.ms, briefing_errors: briefing.errors };
}

/** PURE: the extraction prompt for summary + memory. */
function extractionPrompt({ transcript, memories }) {
  return `Below is a conversation between Ed (owner of Bedrock) and Amanda (Bedrock's AI senior community manager), then the items Amanda already keeps in mind about Ed's work.

TRANSCRIPT:
${transcript}

ALREADY KEPT (id: item):
${memories.length ? memories.map((m) => `${m.id}: [${m.kind}] ${m.content}`).join('\n') : '(none)'}

Return STRICT JSON, no code fences:
{"summary":"<2-4 plain sentences: what was discussed, what was decided or asked, what is pending. No dashes.>",
 "remember":[{"kind":"fact|preference|commitment|open_thread|person","content":"<one plain sentence>","community":"<name or null>"}],
 "done":["<ids of kept items this conversation completed or made obsolete>"]}
Rules: keep only what would matter in a future conversation (preferences about how Ed wants things done, facts he stated, commitments either side made, threads left open, people he mentioned). Never store anything already kept. Never store bank, card or account numbers, passwords or codes. At most 8 new items. If nothing is worth keeping, return an empty list.`;
}

/**
 * Finish a conversation once: transcript summary + memory extraction (one routed call), the
 * measured provider numbers, and one usage row. Safe to call more than once (claims first).
 */
async function finishConversation(supabase, anthropic, sessionId, { provider = null, measured = null, endReason = 'ended', clientMetrics = null } = {}) {
  const claim = await supabase.from('claire_sessions').update({ finalized_at: new Date().toISOString(), status: 'ended', ended_at: new Date().toISOString(), end_reason: endReason }).eq('id', sessionId).eq('surface', 'conversation').is('finalized_at', null).select('id, staff_user_id, started_at, provider, provider_conversation_id').maybeSingle();
  if (claim.error) throw new Error(`finish claim failed: ${claim.error.message}`);
  if (!claim.data) return { ok: true, already: true };
  const s = claim.data;
  const st = peekState(sessionId);
  if (st) await st.chain; // let pending transcript writes land
  const { data: turns, error: tErr } = await supabase.from('claire_session_turns').select('seq, speaker, text, latency_ms, tool_calls, blocked_reason').eq('session_id', sessionId).order('seq', { ascending: true }).limit(400);
  if (tErr) console.warn('[amanda.conversation] transcript read failed', tErr.message);
  const rows = turns || [];
  const transcript = rows.filter((r) => r.text).map((r) => `${r.speaker === 'visitor' ? 'Ed' : 'Amanda'}: ${r.text}`).join('\n').slice(-14000);
  let summary = null; let kept = 0; let done = 0; let extractError = null;
  // A verification session (an engineering check, not Ed) leaves no summary or memory behind.
  if (transcript && anthropic && endReason !== 'verification') {
    const { data: mem } = await supabase.from('amanda_memory').select('id, kind, content').eq('owner_user_id', s.staff_user_id).eq('status', 'active').order('updated_at', { ascending: false }).limit(40);
    try {
      const resp = await withAttribution({ conversation_id: sessionId, user_id: s.staff_user_id }, () => anthropic.messages.create({ model: aiRoute(EXTRACT_WORKFLOW), max_tokens: 900, messages: [{ role: 'user', content: extractionPrompt({ transcript, memories: mem || [] }) }] }));
      const raw = (resp.content || []).map((c) => c.text || '').join('');
      console.log('[amanda.conversation] extraction returned:', raw.slice(0, 2000));
      const j = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim());
      summary = short(j.summary, 1500);
      const known = new Set((mem || []).map((m) => m.id));
      const add = (Array.isArray(j.remember) ? j.remember : []).filter((m) => m && MEMORY_KINDS.includes(m.kind) && short(m.content, 1000) && !/\b\d{8,}\b|password|routing number|account number/i.test(m.content)).slice(0, 8);
      for (const m of add) {
        const c = await communityByName(supabase, m.community);
        const { error } = await supabase.from('amanda_memory').insert({ owner_user_id: s.staff_user_id, kind: m.kind, content: short(m.content, 1000), community_id: c ? c.id : null, source_session_id: sessionId, source_channel: 'voice' });
        if (error) console.warn('[amanda.conversation] memory insert failed', error.message); else kept++;
      }
      const doneIds = (Array.isArray(j.done) ? j.done : []).filter((id) => known.has(id));
      if (doneIds.length) { const { error } = await supabase.from('amanda_memory').update({ status: 'done' }).in('id', doneIds); if (error) console.warn('[amanda.conversation] memory done failed', error.message); else done = doneIds.length; }
    } catch (e) { extractError = e.message; console.warn('[amanda.conversation] extraction failed:', e.message); }
  }
  // Measured usage: model rows attributed to this conversation + the provider's own record.
  const { data: calls, error: cErr } = await supabase.from('agent_runs').select('workflow, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, ok').eq('run_kind', 'model_call').eq('request_input->attribution->>conversation_id', sessionId).limit(1000);
  if (cErr) console.warn('[amanda.conversation] usage read failed', cErr.message);
  const model = { calls: 0, failed: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, by_workflow: {} };
  for (const c of calls || []) {
    model.calls++; if (!c.ok) model.failed++;
    model.input_tokens += c.input_tokens || 0; model.output_tokens += c.output_tokens || 0; model.cache_read_tokens += c.cache_read_tokens || 0; model.cost_usd += Number(c.cost_usd) || 0;
    model.by_workflow[c.workflow] = (model.by_workflow[c.workflow] || 0) + 1;
  }
  model.cost_usd = Math.round(model.cost_usd * 10000) / 10000;
  const brain = st ? brainStats(st) : null;
  const voiceCost = measured && measured.list_cost_usd != null ? measured.list_cost_usd : null;
  const metrics = { brain, provider: measured || null, client: clientMetrics || null, model, transcript_turns: rows.length, memory: { kept, done, error: extractError }, cards: st ? st.cards.slice(-20) : [] };
  const total = Math.round(((voiceCost || 0) + model.cost_usd) * 10000) / 10000;
  const up = await supabase.from('claire_sessions').update({ summary, metrics, cost_usd: total, audio_seconds: measured && measured.duration_seconds != null ? Math.round(measured.duration_seconds) : null }).eq('id', sessionId);
  if (up.error) console.warn('[amanda.conversation] session update failed', up.error.message);
  let mgmt = null; try { mgmt = require('../company').BEDROCK_MGMT_CO_ID; } catch (_) {}
  const ar = await supabase.from('agent_runs').insert({ management_company_id: mgmt, module: 'team', endpoint: 'amanda.conversation', run_kind: 'conversation', workflow: WORKFLOW, provider: provider || s.provider || null, user_id: s.staff_user_id, ok: !(brain && brain.failed && brain.failed === brain.turns),
    request_input: { attribution: { conversation_id: sessionId }, provider_conversation_id: s.provider_conversation_id || null },
    response: { metrics: { brain, provider: measured, model: { calls: model.calls, failed: model.failed } } }, input_tokens: model.input_tokens, output_tokens: model.output_tokens, cache_read_tokens: model.cache_read_tokens,
    cost_usd: total, duration_ms: measured && measured.duration_seconds != null ? Math.round(measured.duration_seconds * 1000) : null });
  if (ar.error) console.warn('[amanda.conversation] usage row failed', ar.error.message);
  _state.delete(sessionId);
  return { ok: true, summary, kept, done, model, voice_cost_usd: voiceCost, total_cost_usd: total };
}

function brainStats(st) {
  const S = require('./voice_elevenlabs').summarize;
  const t = st.turns;
  return { turns: st.counters.turns, interrupted: st.counters.interrupted, failed: st.counters.failed, tool_calls: st.counters.tool_calls, tool_errors: st.counters.tool_errors, model_calls: st.counters.model_calls, request_model_calls: st.counters.request_model_calls,
    first_text_ms: S(t.filter((x) => !x.interrupted && x.first_text_ms != null).map((x) => x.first_text_ms)), first_text_no_tools_ms: S(t.filter((x) => !x.tools && !x.interrupted && x.first_text_ms != null).map((x) => x.first_text_ms)),
    total_ms: S(t.filter((x) => !x.interrupted).map((x) => x.total_ms)), tool_round_ms: S(t.filter((x) => x.tools).map((x) => x.tool_ms)), rebuilt: !!st.rebuilt };
}

module.exports = { findAnything, searchWords, loadWorkstreams, workstreamsBlock, phonePrompt, phoneGatePrompt, PHONE_RULES, principalFor, PERSONA_V1, WORKFLOW, EXTRACT_WORKFLOW, TOOL_DEFS, TOOLS, MEMORY_KINDS, EXPRESSIVE_TAGS, voiceCues, stripCues, systemPrompt, personaCanon, loadBriefing, toAnthropicMessages, cleanSpoken, splitReady, runTurn, startConversation, finishConversation, extractionPrompt, loadState, peekState, putState, newState, brainStats };
