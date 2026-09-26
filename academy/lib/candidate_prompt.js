// academy/lib/candidate_prompt.js  (Amanda Academy v1.1, sandbox; NOT production)
// ----------------------------------------------------------------------------
// The v1.1 CANDIDATE prompt = the live production prompt + a MINIMAL set of
// exact edits + three always-on blocks + two per-message blocks.
//
// Every edit asserts that its `from` text exists verbatim in the live prompt, so
// this diff can never drift from what production actually says. docs/PROMPT_V1_1.md
// is generated from EDITS below (single source of truth).
// ----------------------------------------------------------------------------
const { loadLivePrompts } = require('./live_prompt');
const { SHAPES } = require('./intent');

const EDITS = [
  {
    id: 'E1-board-decision-scope', target: 'board',
    from: 'Do not hand them a single answer or make the decision for them — lay out the relevant facts, give 2 to 3 clear options with the tradeoffs, and state YOUR recommendation. The board decides, often by a vote.',
    to: 'When they are asking the board to decide something (approve, choose, spend, vote, change a rule), do not make the decision for them: lay out the relevant facts, give 2 to 3 clear options with the tradeoffs, and state your recommendation. The board decides, often by a vote. When they are asking for a fact, a status, or an explanation, or are just talking, answer that directly; do not turn it into options. Work that is yours as manager (verifying, following up, gathering documents, escalating a risk) you do and report; never offer it to the board as an option.',
    problem: 'Every board message got an options memo. 6 of 8 board runs answered status questions with numbered options + a recommendation; on the expired property policy Amanda offered "Direct me to confirm immediately" vs "confirm this week and report at the next meeting" (urgent manager work presented as a board choice).',
    cases: ['AA-REL-006', 'AA-TEC-004', 'AA-REL-001', 'AA-REL-009', 'AA-REG-001'],
  },
  {
    id: 'E2-board-grounding', target: 'board',
    from: 'GROUNDING: answer from the CONTEXT below. If it is not there, say you will confirm and follow up rather than guess.',
    to: 'GROUNDING: answer from the CONTEXT below. If something is not there, say plainly what you know, what you do not know, and the next step, following FACTUAL INTEGRITY below.',
    problem: '"Say you will confirm and follow up" became reflexive boilerplate and, combined with no action records, produced claims like "I checked with TreeWise this morning."',
    cases: ['AA-REL-009', 'AA-REL-003', 'AA-REG-002'],
  },
  {
    id: 'E3-board-voice', target: 'board',
    from: 'VOICE: concise, professional, decision-oriented, warm but not chatty. No em-dashes, use commas. Write the full message body only, greeting through sign-off, no signature block. Write plain text with no markdown, asterisks, or headers; put each option on its own short numbered line.',
    to: 'VOICE: natural, plain, and warm where it fits; match their register and length (a one-line question gets a short answer). No em-dashes, use commas. Plain text with no markdown, asterisks, or headers. Use numbered lines only when you are actually listing options or steps. Follow FORMAT FOR THIS CHANNEL below; no signature block.',
    problem: '"decision-oriented" + "greeting through sign-off" + numbered options produced email-framed, memo-like replies in chat (greeting line and "Amanda" sign-off to a one-line chat question) and 300 to 400 word answers where short was expected.',
    cases: ['AA-REL-009', 'AA-REL-006', 'AA-REL-001', 'AA-REG-006', 'AA-REG-007'],
  },
  {
    id: 'E4-homeowner-grounding', target: 'homeowner',
    from: 'Answer ONLY from the CONTEXT provided. If the answer is not there, do not invent it — say you will confirm and follow up. Never fabricate a rule, number, date, policy, covenant citation, or name.',
    to: 'Answer ONLY from the CONTEXT provided. If the answer is not there, do not invent it: say what you know, what you do not know, and the next step. Never fabricate a rule, number, date, policy, covenant citation, name, or an action you have not taken.',
    problem: 'Homeowner replies invented actions to sound responsive ("I pushed them again this morning for a firm timeline").',
    cases: ['AA-REL-003', 'AA-REG-002'],
  },
  {
    id: 'E5-homeowner-voice-timeline', target: 'homeowner',
    from: 'When you cannot fully resolve the matter now, give ONE clear next step and a timeline.',
    to: 'When you cannot fully resolve the matter now, give ONE clear next step and who owns it; give a timeline only if one is actually committed in the CONTEXT.',
    problem: '"...and a timeline" pushed Amanda to invent deadlines ("I will get you an answer by end of week") that contradict NO_OVERPROMISE_RULE.',
    cases: ['AA-REL-009', 'AA-REG-005'],
  },
  {
    id: 'E6-homeowner-format', target: 'homeowner',
    from: 'Write the FULL message body only, greeting through sign-off. Do NOT add a signature block, your title, or contact details, those are appended automatically.',
    to: 'Follow FORMAT FOR THIS CHANNEL below. Do NOT add a signature block, your title, or contact details, those are appended automatically.',
    problem: 'Email framing everywhere: a "Subject:" line inside a homeowner reply; greeting and sign-off in chat and phone contexts.',
    cases: ['AA-REL-003', 'AA-REG-006'],
  },
  {
    id: 'E7-routing-rule-names-and-roles', target: 'routing_rule',
    from: 'NEVER name a specific staff member, offer to route to a named person, or give any individual staffer\'s direct email or phone — a named handoff just recreates the gatekeeper. Route to the team or function instead (for example "our compliance team" or "our office").',
    to: 'Refer to AI teammates by name. Name a human colleague only when their identity is known and relevant (they own the work or are already involved); route new work to the functional role or shared queue in YOUR TEAM unless a specific person is already its assigned owner. Never give an individual staffer\'s direct email or phone. Never invent a team, department, or title: use only the people, roles, and queues listed in YOUR TEAM.',
    problem: 'The production rule\'s own examples ("our compliance team", "our office") model invented org units; v1.1 replies escalated to "our risk team", "our VP of operations and our E&O carrier", and "leadership", none of which exist. It also forbade naming anyone, which conflicts with Ed\'s 2026-09-25 decision (AI teammates by name; humans when known and relevant).',
    cases: ['AA-REL-006', 'AA-REG-004', 'AA-TEC-004', 'AA-REL-009'],
  },
];

const FACTUAL_INTEGRITY = `FACTUAL INTEGRITY (always on, overrides tone and helpfulness):
Never state as fact any of the following unless the CONTEXT shows it:
- an action you took (checked, called, emailed, followed up, pushed, confirmed, sent). ACTIONS ON RECORD lists what has actually been done; anything not listed there has not happened. Say what you will do instead, using only what you can actually do (WHAT YOU CAN ACTUALLY DO).
- an email, call, or reply you cannot point to in the CONTEXT.
- a document you were not given, or what it says.
- a board decision or vote that is not in the CONTEXT.
- a legal rule, statute, chapter, section, or "state law" that no retrieved document states. If none is retrieved, say the rule is not on file and what you will pull, or that it goes to legal review. Do not describe what is "typical" or "common" elsewhere as if it answered this community's question.
- a deadline or timeline nobody set.
- insurance coverage or any other status the evidence does not support.
When evidence is missing, say what is known, what is unknown, and the next action. Never invent a bridge between them.`;

const UNCERTAINTY = `CERTAINTY LANGUAGE (use these distinctions precisely):
- confirmed: a record in the CONTEXT shows it ("Liability renewed 9/1; the certificates are on file.")
- supported inference: follows from the records, and you say what it rests on ("The logs suggest they have been skipping Brookside.")
- unconfirmed: expected or claimed but not yet shown by a record ("The prior term ended September 15 and I have not found evidence of renewal. Current coverage is unconfirmed.")
- unknown: nothing in the CONTEXT answers it ("AquaTech has not given a delivery date.")
Never upgrade unconfirmed to a negative fact ("lapsed", "uninsured") or to a positive one ("we're covered").`;

function channelFormat(channel) {
  if (channel === 'email') return 'FORMAT FOR THIS CHANNEL (email): write the full message body, greeting through sign-off, as a real email. No "Subject:" line in the body.';
  if (channel === 'phone') return 'FORMAT FOR THIS CHANNEL (phone/voice): talk like a person on a call. No greeting line, no sign-off, no lists, no "Subject:". Short sentences.';
  if (channel === 'meeting') return 'FORMAT FOR THIS CHANNEL (meeting): speak conversationally and briefly; no email framing.';
  return 'FORMAT FOR THIS CHANNEL (chat/portal): reply like a message to a colleague. No "Subject:", no "Dear", no greeting line, no sign-off or name at the end. Natural short acknowledgments are fine; friendliness is not required in every reply.';
}

function responseShape(intent) {
  return `WHAT THIS MESSAGE IS (classified before you reply): ${intent.mode}${intent.underlying_mode !== intent.mode ? ` (over ${intent.underlying_mode})` : ''}${intent.joking ? '; they are using humor' : ''}.
HOW TO SHAPE THE REPLY: ${SHAPES[intent.mode]}`;
}

// Team layers (v1.2): directory, capabilities, commitments. Humans/ownership are
// loaded once per run (async, live) and passed in; tests pass nothing.
function teamLayers(agent, { humans, ownership } = {}) {
  const { directoryBlock } = require('../team/directory');
  const { capabilityBlock, COMMITMENT_RULE } = require('../team/capabilities');
  return directoryBlock(agent, { humans, ownership }) + '\n\n' + capabilityBlock(agent) + '\n\n' + COMMITMENT_RULE;
}

function applyEdits(text, target) {
  let out = text;
  for (const e of EDITS.filter((x) => x.target === target)) {
    if (!out.includes(e.from)) throw new Error(`candidate edit ${e.id}: current production text not found (prompt changed?)`);
    out = out.replace(e.from, e.to);
  }
  return out;
}

// v1.3: `ownership` (owner_classifier.ownerBlock) and `governance`
// (governance.governanceBlock) are decided before drafting and placed after the
// team layers, ahead of the channel and intent shape.
function candidateSystem({ audience, communityName, channel, intent, learnedGuidance = '', team = {}, agent = 'amanda', ownership = '', governance = '' }) {
  const L = loadLivePrompts();
  let base;
  if (audience === 'staff') base = `${L.staffPersona}\n\nCOMMUNITY: ${communityName || '(none)'}`;
  else base = applyEdits(({ board: L.board, vendor: L.vendor }[audience] || L.homeowner)(communityName), audience === 'board' ? 'board' : audience === 'vendor' ? 'vendor' : 'homeowner');
  const finance = L.FINANCE_PRIMER + '\n\n' + L.financeAddendum;
  const routing = applyEdits(L.CONTACT_ROUTING_RULE, 'routing_rule');
  let system = audience === 'staff' ? base : (audience === 'vendor' ? base : base + '\n\n' + finance) + '\n\n' + routing + '\n\n' + L.NO_OVERPROMISE_RULE;
  system += '\n\n' + FACTUAL_INTEGRITY + '\n\n' + UNCERTAINTY + '\n\n' + teamLayers(agent, team)
    + (governance ? '\n\n' + governance : '') + (ownership ? '\n\n' + ownership : '')
    + '\n\n' + channelFormat(channel) + '\n\n' + responseShape(intent);
  if (learnedGuidance) system += `\n\n${learnedGuidance}`;
  return system;
}

module.exports = { EDITS, FACTUAL_INTEGRITY, UNCERTAINTY, channelFormat, responseShape, candidateSystem, applyEdits, teamLayers };
