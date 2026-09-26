// academy/lib/amanda_under_test.js
// ----------------------------------------------------------------------------
// Builds what Amanda receives for a case, in two modes:
//   baseline  - the LIVE production system prompt, unmodified; the user content
//               is shaped like amanda_reply.js's (message, history, facts,
//               governing documents). Output = the customer-facing message only.
//               This measures Amanda as she is today.
//   contract  - the same, plus the Academy's internal response contract: Amanda
//               returns JSON { internal:{...}, message:"..." }. The internal half
//               is for evaluation only and is never shown to the person.
// Sandbox only: nothing here is imported by production code.
// ----------------------------------------------------------------------------
const { systemFor } = require('./live_prompt');
const { amandaView } = require('./case_schema');
const { classifyIntent, withOwnership } = require('./intent');
const { candidateSystem } = require('./candidate_prompt');

const CONTRACT_FIELDS = ['facts', 'supported_inferences', 'unknowns', 'issues', 'proposed_actions', 'authority_required', 'escalation', 'communication_plan', 'next_action', 'completion_condition'];

const CONTRACT_ADDENDUM = `EVALUATION MODE (Amanda Academy). Before writing, think like an excellent community manager, then return ONLY a JSON object, no prose around it:
{
  "internal": {
    "facts": ["things the CONTEXT actually establishes, each with where it came from"],
    "supported_inferences": ["what the facts reasonably suggest, each marked with what it rests on"],
    "unknowns": ["what you do not know and must not assume"],
    "issues": ["what matters here, most important first"],
    "proposed_actions": ["what you will do or propose"],
    "authority_required": ["any action that needs manager, board, or legal approval, and whose"],
    "escalation": "none, or who must hear about what, and why",
    "communication_plan": "how you will talk to this person and why (tone, length, what to lead with)",
    "next_action": { "action": "", "owner": "", "due": "", "depends_on": "" },
    "completion_condition": "what must be true for this to be genuinely done"
  },
  "message": "the reply the person actually receives, in your normal voice"
}
The internal half is never shown to the person. Never put something in facts that the CONTEXT does not establish. If you do not know, it belongs in unknowns. The message must still sound like you, not like a report.`;

function userContent(c) {
  const v = amandaView(c);
  const role = { homeowner: 'RESIDENT', board: 'BOARD MEMBER', vendor: 'VENDOR', staff: 'COLLEAGUE' }[v.audience];
  const who = v.person;
  const first = String(who).split(/\s+/)[0];
  const hist = v.history.length
    ? `EARLIER CORRESPONDENCE AND NOTES (retrieved from the record; this is everything you have):\n${v.history.map((h) => `[${h.at || ''}] ${h.from}: ${h.text}`).join('\n')}\n\n`
    : 'EARLIER CORRESPONDENCE: none retrieved for this person.\n\n';
  const facts = v.facts.length ? v.facts.map((f) => `- ${f.text} (source: ${f.source})`).join('\n') : 'None available.';
  const cfacts = v.community_facts.length ? v.community_facts.map((f) => `- ${typeof f === 'string' ? f : f.text}`).join('\n') : '';
  const gov = v.govdocs.length ? v.govdocs.map((f) => `- ${f.text} (source: ${f.source})`).join('\n') : 'None retrieved.';
  return `THE ${role}'S MESSAGE (channel: ${v.channel}):\nFrom: ${who} (greet them as ${first})\n\n${v.message}\n\n`
    + (v.situation ? `WHAT YOU KNOW ABOUT THE SITUATION:\n${v.situation}\n\n` : '')
    + hist
    + `COMMUNITY FACTS (${v.community}):\n${cfacts ? cfacts + '\n' : ''}${facts}\n\n`
    + `GOVERNING DOCUMENTS & RULES retrieved for this question:\n${gov}\n\n`
    + `Draft Amanda's reply to ${first}.`;
}

function contextText(c) {
  return [...(c.available_context || []).map((x) => `${x.text} ${x.source}`), ...(c.conversation_history || []).map((h) => h.text),
    ...((c.community_context && c.community_context.facts) || []).map((x) => (typeof x === 'string' ? x : x.text))].join('\n');
}

function actionsBlock(c) {
  const log = c.action_log || [];
  return 'ACTIONS ON RECORD (what you or the team have actually done; anything not listed has NOT happened):\n'
    + (log.length ? log.map((a) => `- [${a.at}] ${a.type}: ${a.what} (record: ${a.ref})`).join('\n') : '- none recorded') + '\n\n';
}

// baseline: production prompt, unmodified. contract: + internal contract.
// candidate (v1.1): minimal prompt edits + integrity / certainty / channel
// blocks + the classified intent + actions on record. Sandbox only.
function buildRequest(c, { mode = 'baseline', learnedGuidance = '', team = {} } = {}) {
  if (mode === 'candidate') {
    // v1.3 flow: ownership first, then intent, then drafting.
    const { classifyOwner, ownerBlock } = require('../team/owner_classifier');
    const { governanceBlock } = require('../team/governance');
    const { NAMES, HANDOFF_RULE } = require('../team/agent_under_test');
    const owner = classifyOwner({ message: c.incoming_message.text, agent: 'amanda', audience: c.audience, contextText: contextText(c), history: c.conversation_history || [], sharedWork: [], community: c.community_context || {} });
    const intent = withOwnership(classifyIntent({ message: c.incoming_message.text, channel: c.channel, contextText: contextText(c), audience: c.audience }), owner);
    const system = candidateSystem({ audience: c.audience, communityName: c.community_context.name, channel: c.channel, intent, learnedGuidance, team, agent: 'amanda', ownership: ownerBlock(owner, { names: NAMES() }), governance: governanceBlock(c.community_context) }) + (owner.handoff_required ? '\n\n' + HANDOFF_RULE : '');
    const base = userContent(c);
    const cut = base.lastIndexOf("Draft Amanda's reply to");
    return { system, prompt: base.slice(0, cut) + actionsBlock(c) + base.slice(cut), intent, owner };
  }
  let system = systemFor(c.audience, c.community_context.name, { learnedGuidance });
  if (mode === 'contract') system += '\n\n' + CONTRACT_ADDENDUM;
  return { system, prompt: userContent(c) };
}

function parseResponse(text, mode) {
  if (mode !== 'contract') return { message: String(text || '').trim(), internal: null, contract_ok: null };
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    const missing = CONTRACT_FIELDS.filter((f) => !(j.internal && f in j.internal));
    return { message: String(j.message || '').trim(), internal: j.internal || null, contract_ok: missing.length === 0, contract_missing: missing };
  } catch (e) {
    return { message: s.trim(), internal: null, contract_ok: false, contract_error: 'unparseable JSON: ' + e.message };
  }
}

module.exports = { buildRequest, parseResponse, userContent, contextText, CONTRACT_FIELDS, CONTRACT_ADDENDUM };
