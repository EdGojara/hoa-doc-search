// academy/team/capabilities.js  (DESIGN, sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Agent Capability Registry: what each AI teammate can ACTUALLY do, at runtime.
// The action guard validates every first-person action claim, past OR future,
// against this registry: an agent may not say "I'll call the broker" unless
// make_phone_call is enabled for her, and no AI may claim a physical action.
//
// Each capability per agent: enabled, tool (the real code path), approval
// (what must happen before it takes effect), scope, and availability (computed
// from live signals where one exists, e.g. whether outbound mail is held).
//
// Grounded in code as of 2026-09-25:
//   send/read email   lib/email/graph_send.js (sendAs; AUTO_OUTBOUND_EMAIL off = held for a human)
//   receive phone     lib/voice (inbound Claire / Isabella / Mei / Priya)
//   make phone call   NO outbound call path exists anywhere (Twilio line is SMS test only)
//   create task       lib/team/objectives.js openObjective (owner_persona, next_action)
//   schedule followup objectives.next_action_due, monitored by objectives.findStalled
//   update record     lib/team/operator_actions.js log_interaction (autonomy 'propose' by default)
//   publish content   api/newsletters.js (Phoebe drafts; a human publishes)
//   post / pay        no AI path: postings need Ed's approval, payments a human release
//   physical action   never, for any AI
// ----------------------------------------------------------------------------

const CAPABILITIES = {
  read_email:           { label: 'read email in its mailbox and routed queues' },
  send_email:           { label: 'send or reply to email' },
  receive_phone:        { label: 'answer inbound phone calls' },
  make_phone_call:      { label: 'place an outbound phone call' },
  create_task:          { label: 'open a tracked work item or objective' },
  schedule_followup:    { label: 'set a tracked, monitored follow-up with a due time' },
  prepare_document:     { label: 'draft a document (letter, packet, entry, newsletter)' },
  publish_content:      { label: 'publish to residents (newsletter, portal post)' },
  update_record:        { label: 'write to the platform record (timeline note, status)' },
  post_financial_entry: { label: 'post a journal entry to the general ledger' },
  execute_payment:      { label: 'release a payment' },
  physical_site_action: { label: 'go somewhere in person (inspect, walk, attend, check on site)' },
};

// Shared defaults for every AI teammate. Per-agent overrides below.
const NO = (why) => ({ enabled: false, tool: null, approval: null, scope: null, why });
const BASE = {
  read_email:           { enabled: true, tool: 'Microsoft Graph mailbox (lib/email)', approval: 'none', scope: 'own mailbox and queues routed to its lane' },
  send_email:           { enabled: true, tool: 'graph_send.sendAs', approval: 'held for human release unless AUTO_OUTBOUND_EMAIL=on', scope: 'correspondence in its lane', live: 'outbound_mail' },
  receive_phone:        NO('no inbound voice line for this teammate'),
  make_phone_call:      NO('no outbound calling exists on the platform'),
  create_task:          { enabled: true, tool: 'objectives.openObjective (migration 399)', approval: 'none', scope: 'its own lane' },
  schedule_followup:    { enabled: true, tool: 'objectives.next_action_due, monitored by objectives.findStalled', approval: 'none', scope: 'its own commitments' },
  prepare_document:     { enabled: true, tool: 'drafting in its lane', approval: 'delivery follows send_email / publish rules', scope: 'its lane' },
  publish_content:      NO('publishing to residents is Phoebe\'s lane and needs a human'),
  update_record:        { enabled: true, tool: 'operator_actions.log_interaction', approval: 'proposed for a human while lane autonomy is "propose"', scope: 'timeline notes and statuses in its lane', live: 'operator_autonomy' },
  post_financial_entry: NO('no AI teammate posts to the ledger; Kat prepares, Ed approves'),
  execute_payment:      NO('no AI teammate releases payments; a human releases after approval'),
  physical_site_action: { ...NO('AI teammates cannot be anywhere in person; the Community Manager handles site work'), hard: true },
};

const OVERRIDES = {
  claire:   { receive_phone: { enabled: true, tool: 'lib/voice (inbound Claire)', approval: 'none', scope: 'inbound calls to Bedrock lines', live: 'voice' } },
  isabella: { receive_phone: { enabled: true, tool: 'lib/voice (persona_isabella)', approval: 'none', scope: 'inbound Spanish calls', live: 'voice' } },
  mei:      { receive_phone: { enabled: true, tool: 'lib/voice', approval: 'none', scope: 'inbound Mandarin calls', live: 'voice' } },
  priya:    { receive_phone: { enabled: true, tool: 'lib/voice', approval: 'none', scope: 'inbound Hindi calls', live: 'voice' } },
  phoebe:   { publish_content: { enabled: true, tool: 'api/newsletters.js', approval: 'a human approves before anything reaches residents', scope: 'newsletter and resident-wide updates' } },
  kat:      { prepare_document: { enabled: true, tool: 'drafting in its lane', approval: 'Ed approves any posting', scope: 'journal entries, schedules, reconciliations (prepared, not posted)' } },
  emma:     { prepare_document: { enabled: true, tool: 'AP pipeline', approval: 'a human releases payment', scope: 'invoice coding and payment proposals' } },
  tessa:    { private: true },
};

// Live signals. Sandbox reads env only; nothing is called.
function liveAvailability(cap, env = process.env) {
  if (!cap.enabled) return 'unavailable';
  if (cap.live === 'outbound_mail') {
    const graph = !!(env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET);
    if (!graph) return 'unavailable (mail not configured)';
    return /^(1|true|on|yes|enabled)$/i.test(String(env.AUTO_OUTBOUND_EMAIL || '').trim()) ? 'available (sends automatically)' : 'available (drafts held for a human to release)';
  }
  if (cap.live === 'operator_autonomy') return 'available (proposed for a human; lane autonomy is propose-only)';
  return 'available';
}

function capabilitiesFor(agent, { env } = {}) {
  const o = OVERRIDES[agent] || {};
  const out = {};
  for (const k of Object.keys(CAPABILITIES)) {
    const c = { ...BASE[k], ...(o[k] || {}) };
    if (BASE[k].hard) Object.assign(c, BASE[k]); // hard limits cannot be overridden
    out[k] = { ...c, availability: liveAvailability(c, env) };
  }
  return out;
}

function can(agent, cap) { return !!capabilitiesFor(agent)[cap].enabled; }

// ---- Claim recognition -------------------------------------------------------
// Map an action phrase (past or future) to the capability it needs.
const CLAIM_PATTERNS = [
  ['physical_site_action', /\b(go|going|goes|went|head|heading|headed|drive|driving|drove|walk|walking|walked|swing|swinging|stop|stopping|come|coming|run|running|get|getting) (over |out |down |back )?(and )?(inspect|check|look at|see|walk|test|take a look)\b|\b(go|going|goes|went|head|heading|headed|drive|driving|drove|walk|walking|walked|swing|swinging|stop|stopping|come|coming|run|running|get|getting) (over |out |down |by |back )?(to|by|past) (the )?(pool|site|property|gate|latch|fence|drain|entrance|entrances|clubhouse|pond|fountain|amenity|community|house|lot|area|tree|damage|brookside)\b|\b(go|going|goes|went|head|heading|headed|drive|driving|drove|walk|walking|walked|swing|swinging|stop|stopping|come|coming|run|running|get|getting) out (there|to (see|check|look))\b|\binspect(ing)? (the )?(pool|site|property|gate|latch|fence|drain|entrance|entrances|clubhouse|pond|fountain|amenity|community|house|lot|area|tree|damage|brookside)\b|\b(check|test|inspect|look at|see|walk|verify)(ing)? (the |it|that|this|[a-z]+ ){0,3}(myself|in person|personally|on site|onsite)\b|\bin person\b|\bon[- ]site\b|\bdrive-?bys?\b|\b(be|meet you) (there|on site|out there)\b|\b(meet|walk) (you|with you)\b|\b(schedule|set up|arrange|book)(ing)? (a |the )?(site visit|walk-?through|visit)( with you)?\b/i],
  ['make_phone_call', /\b(call(ing|ed)?|phon(e|ed|ing)|ring(ing)?|dial(ing)?)\b(?! (me|us) | (a|the|an) (special |board |member |annual |emergency )?(meeting|vote|election|question)| (it|this) (in|done|a))|\bget (them|him|her) on the phone\b|\bleave (a )?voicemail\b|\bspoke (with|to)\b/i],
  ['post_financial_entry', /\b(post(ed|ing)?|book(ed|ing)?|record(ed|ing)?) (the |a |this |that )?(journal )?(entry|reclass|adjustment|je)\b|\breclass(ed|ing|ify|ified)? (it|the|this|that)\b|\bpost (it|this|that)\b/i],
  ['execute_payment', /\b(pay(ing)?|paid|release(d)? (the )?payment|issue(d)? (a |the )?(check|payment|refund)|send (a |the )?payment|refund(ed)? (you|the))\b/i],
  ['publish_content', /\b(publish(ed|ing)?|post(ed|ing)? (it |this )?(to|on) the (portal|website|newsletter)|send(ing)? (it )?to (all )?(residents|the community))\b/i],
  ['send_email', /\b(email(ed|ing)?|e-mail(ed|ing)?|send(ing)? (you|them|him|her|an email|a note|a message|over)|sent (you|them|him|her|an email)|reply|write to|forward(ed|ing)?)\b/i],
  ['create_task', /\b(open(ed|ing)? (a |an )?(work item|ticket|task|objective))\b/i],
  ['update_record', /\b(log(ged|ging)?|note(d)? (it|this) (on|in) the (record|file|timeline)|update(d)? the (record|file|account))\b/i],
];

function capabilityForClaim(phrase) {
  for (const [cap, re] of CLAIM_PATTERNS) if (re.test(phrase)) return cap;
  return null;
}

// ---- Prompt block ----------------------------------------------------------------
function capabilityBlock(agent, { env } = {}) {
  const caps = capabilitiesFor(agent, { env });
  const yes = Object.entries(caps).filter(([, c]) => c.enabled).map(([k, c]) => `- ${CAPABILITIES[k].label}${c.approval && c.approval !== 'none' ? ` (${c.approval})` : ''}`);
  const no = Object.entries(caps).filter(([, c]) => !c.enabled).map(([k, c]) => `- ${CAPABILITIES[k].label}: ${c.why}`);
  return `WHAT YOU CAN ACTUALLY DO (never say you did or will do anything outside this list):\n${yes.join('\n')}\nWHAT YOU CANNOT DO:\n${no.join('\n')}\n`
    + 'If something needs a phone call, a site visit, a posting, or a payment, say who does it (from YOUR TEAM) and what you are doing to move it, for example emailing, opening a tracked follow-up, or preparing the document.';
}

// Same-day / time-bound commitments (Ed 2026-09-25): allowed only if the agent
// has the capability, a tracked commitment is created, a due time is recorded,
// and follow-through is monitored. In production the COMMITMENTS block becomes
// an objective next_action (+ next_action_due), watched by findStalled.
const COMMITMENT_RULE = `COMMITMENTS: you may promise something with a time ("today", "this afternoon", "by Friday") only if you can actually do it (WHAT YOU CAN ACTUALLY DO) AND you record it. To record it, end your output with:
---COMMITMENTS---
[{"what":"...","due":"YYYY-MM-DD HH:MM or 'today 17:00'","capability":"send_email|schedule_followup|..."}]
That block is removed before the person sees your reply; the platform turns each entry into a tracked follow-up with that due time and watches it. If you cannot or do not record it, say what you are doing now or the next step instead of promising a time.`;

module.exports = { CAPABILITIES, capabilitiesFor, can, capabilityForClaim, capabilityBlock, COMMITMENT_RULE, CLAIM_PATTERNS };
