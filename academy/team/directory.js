// academy/team/directory.js  (DESIGN, sandbox; not loaded by production or by
// the v1.1 candidate prompt)
// ----------------------------------------------------------------------------
// The Shared Bedrock / trustEd Team Directory and Organizational Context.
// Every AI teammate knows who is on the team, human or AI, what each owns,
// what each may decide, and who has to be involved before something happens.
//
// Layering: this sits BENEATH the personality profiles, next to the culture
// layer. Personality can shape how a handoff sounds; it can never change who
// owns the work or who has to approve it.
//
// Sources of truth (derived, never restated):
//   AI teammates  -> lib/team/roster.js (name, title, tier, lane, reports_to)
//   handoff cues  -> academy/team/team_awareness.js TRIGGERS
//   default queue -> lib/ops/sla.js ROUTES (legal/government/collections -> Ed,
//                    board + owner correspondence -> Community Manager,
//                    invoices -> Payables, insurance + unowned -> info@)
// What lives HERE is only what no existing file holds: human teammates, Ed's
// organizational role, and the decision-authority matrix.
//
// ORGANIZATIONAL CONTEXT ONLY. This file is what a new coworker would be told
// on day one: roles, authority, and when to involve whom. It is not personal
// memory and not a biography. Personal relationship memory (preferences, history
// with a specific homeowner or board member) belongs to the memory layer, is
// scoped per relationship, and never lives in this shared directory. A test
// enforces that no personal-life fields appear here.
// ----------------------------------------------------------------------------
const path = require('path');
const { TRIGGERS } = require('./team_awareness');

// ---- Ed: organizational context ---------------------------------------------
const ED_CONTEXT = {
  key: 'ed', name: 'Ed Gojara', kind: 'human',
  role: 'Owner of Bedrock Association Management; founder of trustEd, the platform the team runs on.',
  expertise: ['accounting and financial reporting', 'audit and internal controls', 'operations and process design', 'HOA management operations'],
  responsible_for: ['Bedrock as a business: clients, contracts, pricing, staff', 'trustEd: how the platform and the AI team work', 'final approval on the books Bedrock keeps for associations'],
  approves: [
    'any journal entry, reclass, recognition schedule, or other financial posting',
    'management agreements, pricing, and proposals to new communities',
    'legal matters: attorney contact, demand letters, subpoenas, lawsuits, counsel referrals',
    'government, regulatory, tax, and county matters',
    'collections decisions (referral to counsel, NSF handling policy)',
    'anything that changes how the AI team itself works (a new lesson, autonomy for a lane)',
  ],
  involve_when: [
    'something in the approves list is on the table',
    'a board member or homeowner is dissatisfied with Bedrock itself, not just an issue',
    'a mistake by Bedrock (human or AI) reached a customer',
    'the issue is outside every teammate\'s lane and the Community Manager queue',
    'a risk (insurance lapse, safety, legal exposure) cannot be resolved by the owning lane today',
  ],
  do_not_escalate: [
    'routine vendor scheduling and status follow-up under an existing contract',
    'resident questions answerable from the governing documents or the record',
    'meeting logistics, notices, packets, and minutes (Paige)',
    'invoice status and payment questions (Emma)',
    'ACC application intake and status (Annie)',
    'violation status and cure periods (Miranda)',
    'a board decision the board can make itself: bring it to the board, not to Ed',
    'anything a teammate already owns and is working',
  ],
  how_to_involve: 'Bring Ed a decision, not a problem: what happened, what is known and unknown, the options, and what you recommend. Never say Ed "will" do something he has not agreed to.',
};

// ---- Human teammates ----------------------------------------------------------
// Roles, not desks: per the routing rule (lib/ops/sla.js, 2026-08-10) no
// individual staffer is a default routing target. Agents know human colleagues
// by name so they recognize them, but route work to the ROLE or shared queue.
const HUMAN_TEAM = [
  { key: 'ed', ...ED_CONTEXT },
  {
    key: 'community_manager', name: 'Martha Bravo', kind: 'human', role: 'Community Manager',
    expertise: ['day-to-day community operations', 'long-standing board and vendor relationships', 'site knowledge'],
    responsible_for: ['board relationships and owner correspondence that needs a person', 'site visits, walk-throughs, and anything that needs someone physically present', 'reviewing AI drafts she forwards to the team'],
    route_as: 'Community Manager', routing_target: false,
    hand_to_when: ['the work needs a human in person (a site visit, a walk-through, a meeting attendance)', 'a board or homeowner explicitly asks for a person'],
    may_decide: ['operational calls within the management agreement'],
    may_not_decide: ['financial postings (Ed)', 'legal positions (Ed and counsel)', 'board decisions (the board)'],
  },
  {
    key: 'staff_unconfirmed', name: null, kind: 'human', role: 'Other Bedrock staff (roles not yet recorded)',
    needs_ed_input: true,
    note: 'Names come from user_profiles at runtime (liveHumans). Their roles are not recorded anywhere (user_profiles.role is just "staff"), so until Ed records them agents recognize them as colleagues, route their kind of work to the shared info@ queue, and never guess what they do.',
  },
];

// Live human roster. Names are read at runtime from user_profiles through the
// same helper the email personas use (lib/email/team_roster.getTeam), so this
// public file never lists staff and a departed teammate (is_active=false) drops
// out on her own. Anyone the directory does not describe is flagged, not guessed.
const NON_PERSON = /^(bedrock|info|general|admin)\b/i;
async function liveHumans({ getTeam } = {}) {
  const load = getTeam || require(path.join(__dirname, '..', '..', 'lib', 'email', 'team_roster')).getTeam;
  const aiNames = new Set(aiTeam().map((t) => t.name.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const p of await load()) {
    const name = String(p.full_name || '').trim();
    const k = name.toLowerCase();
    if (!name || aiNames.has(k) || NON_PERSON.test(name) || seen.has(k)) continue;
    seen.add(k);
    const known = HUMAN_TEAM.find((h) => h.name && h.name.toLowerCase() === k);
    out.push(known ? { ...known } : { key: `staff:${k}`, name, kind: 'human', role: 'Bedrock staff (role not recorded)', needs_ed_input: true, route_as: 'info@', routing_target: false });
  }
  return out;
}

// Shared queues the team watches. Unowned work goes here, not to a person.
const SHARED_QUEUES = [
  { queue: 'info@', for: 'insurance and anything without a clear owner; the team self-assigns' },
  { queue: 'accounting@', for: 'accounting questions and documents' },
  { queue: 'violations@', for: 'deed-restriction reports and violation correspondence' },
  { queue: 'acc@', for: 'architectural applications' },
  { queue: 'builders@', for: 'builder ARC submissions' },
];

// ---- AI teammates, derived from the roster -------------------------------------
// Only the expertise and decision boundaries are added; name, title, tier, lane
// and reports_to come from roster.js at runtime.
const AI_AUTHORITY = {
  claire:   { may_decide: ['answers from the governing documents and the record', 'routing to the right teammate'], may_not_decide: ['waivers, fines, ACC, legal, or §209 determinations', 'governance interpretation beyond what the documents plainly say'] },
  isabella: { same_as: 'claire' }, mei: { same_as: 'claire' }, priya: { same_as: 'claire' },
  emma:     { may_decide: ['matching an invoice to a vendor and a GL code proposal', 'payment status from the record'], may_not_decide: ['releasing a payment without approval', 'paying an invoice that may already be paid'] },
  kat:      { may_decide: ['explaining a balance and its basis', 'preparing a journal entry, schedule, or reconciliation'], may_not_decide: ['posting any entry (Ed approves)', 'refunds or payment plans outside policy (board or Ed)'] },
  annie:    { may_decide: ['completeness of an ACC application', 'what the guidelines require'], may_not_decide: ['approving or denying an application (committee or board)'] },
  miranda:  { may_decide: ['violation facts, stage, and cure period from the record'], may_not_decide: ['waiving or reducing a fine (board)', 'any §209 determination (Ed and counsel)'] },
  amanda:   { may_decide: ['routine management within the management agreement: vendor coordination, scheduling, follow-up', 'a recommendation to the board'], may_not_decide: ['spends, waivers, contracts, ACC, legal positions (board, Ed, or counsel)', 'financial postings (Ed)'] },
  reese:    { may_decide: ['resale certificate contents from the record'], may_not_decide: ['balances not confirmed by Kat', 'title or legal opinions'] },
  darby:    { may_decide: ['counsel coordination logistics'], may_not_decide: ['a referral to counsel (Ed)', 'any legal position'] },
  paige:    { may_decide: ['agenda drafts, notice logistics, packet assembly, minutes drafts'], may_not_decide: ['what the board decides', 'a governance interpretation the documents do not state (Amanda, then counsel)'] },
  phoebe:   { may_decide: ['how a community update is written'], may_not_decide: ['any fact, date, amount, or status not confirmed by its owner'] },
  maggie:   { may_decide: ['first conversations with prospective communities'], may_not_decide: ['pricing, proposals, or contract terms (Ed)'] },
  tessa:    { private: true, may_decide: ["Ed's own scheduling and correspondence drafts"], may_not_decide: ['anything for customers; other agents never route to her'] },
};

function aiTeam() {
  const { ROSTER } = require(path.join(__dirname, '..', '..', 'lib', 'team', 'roster'));
  return ROSTER.filter((p) => p.persona && p.persona !== 'general').map((p) => {
    const auth = AI_AUTHORITY[p.persona] || {};
    const resolved = auth.same_as ? AI_AUTHORITY[auth.same_as] : auth;
    return {
      key: p.persona, name: p.name, kind: 'ai', role: p.signature_title || p.title, tier: p.tier,
      lane: p.lane, reports_to: p.reports_to || null, private: !!(TRIGGERS[p.persona] || {}).private,
      hand_to_when: (TRIGGERS[p.persona] || {}).handoff_when || [],
      escalates_to: (TRIGGERS[p.persona] || {}).escalate_to || null,
      may_decide: resolved.may_decide || [], may_not_decide: resolved.may_not_decide || [],
    };
  });
}

function directory() { return [...aiTeam(), ...HUMAN_TEAM]; }

// ---- Decision authority ---------------------------------------------------------
// Who must be involved before something happens. owner_class is what the
// routing cases grade. 'source' points at the rule in code; rows marked
// proposed:true are Academy proposals Ed must confirm before they are taught.
const OWNER_CLASSES = ['self', 'ai_teammate', 'human', 'ed_approval', 'board_approval', 'legal_review', 'accounting_review'];

const AUTHORITY = [
  { decision: 'answer a question inside your own lane from the record', owner_class: ['self'], source: 'roster.js lanes' },
  { decision: 'routine vendor coordination under an existing contract', owner_class: ['self'], who: 'amanda', source: 'amanda_reply.js (coordinate, not commit funds)' },
  { decision: 'a question in another teammate\'s lane', owner_class: ['ai_teammate'], source: 'team_awareness TRIGGERS' },
  { decision: 'something that needs a person physically present or a named human', owner_class: ['human'], who: 'community_manager', source: 'amanda_staff_assist.js (no calendar, cannot attend)' },
  { decision: 'waive or reduce a fine or fee', owner_class: ['board_approval'], source: 'amanda_reply.js WHAT YOU STILL MAY NOT DO' },
  { decision: 'spend association funds, sign or change a contract', owner_class: ['board_approval'], source: 'amanda_reply.js line 90' },
  { decision: 'approve or deny an ACC application', owner_class: ['board_approval'], who: 'annie prepares', source: 'amanda_reply.js reserved requests' },
  { decision: 'post, reclass, or reverse a journal entry; activate a recognition schedule', owner_class: ['ed_approval', 'accounting_review'], who: 'kat prepares, Ed approves', proposed: true },
  { decision: 'move money between operating and reserve funds', owner_class: ['board_approval', 'ed_approval', 'accounting_review'], who: 'board authorizes, kat prepares, Ed approves the posting', proposed: true },
  { decision: 'a legal threat, attorney contact, subpoena, or demand', owner_class: ['ed_approval', 'legal_review'], who: 'Ed, with darby coordinating counsel', source: 'sla.js ROUTES legal -> Ed' },
  { decision: 'refer an account to collections counsel', owner_class: ['ed_approval'], who: 'darby coordinates', source: 'sla.js ROUTES collections -> Ed' },
  { decision: 'a Texas Chapter 209 determination', owner_class: ['legal_review', 'ed_approval'], source: 'CLAUDE.md voice surfaces; amanda_reply.js' },
  { decision: 'management pricing, a proposal, or contract terms for a community', owner_class: ['ed_approval'], who: 'maggie leads the conversation', proposed: true },
  { decision: 'explain a financial discrepancy or a balance', owner_class: ['accounting_review'], who: 'kat', source: 'team_awareness TRIGGERS.kat' },
];

// ---- Handoff package -------------------------------------------------------------
// What must travel with the work so the recipient never asks the customer to
// repeat themselves. Validated by routing_checks.validateHandoff.
const HANDOFF_FIELDS = {
  from: 'who is handing off', to: 'who now owns it (teammate key, role, or approval class)',
  person: 'who the customer is and how they reached us', ask: 'what they asked, in their words where it matters',
  known: 'facts established, with where each came from', unknown: 'what is not yet confirmed',
  actions_on_record: 'what has actually been done, with dates', promised: 'anything already promised to the customer, and by when',
  why_theirs: 'why this belongs to the recipient', next_step: 'the first thing the recipient should do',
};

// ---- Shared work context -----------------------------------------------------------
// When a board member asks one teammate about work another teammate did, the
// answer comes from the shared record, not from "ask Paige". Production sources
// (to be wired after review): work_items (migration 256, the Status board),
// interactions (the property/community timeline), operator_actions audit
// records, and messages sent from each persona's mailbox. Each record carries
// who did it, so the answering teammate can credit them.
const WORK_RECORD_FIELDS = ['by', 'type', 'what', 'at', 'status', 'ref'];

// ---- Prompt block --------------------------------------------------------------
// humans: pass liveHumans() output in production; defaults to the described roles.
function directoryBlock(self, { humans } = {}) {
  const ai = aiTeam().filter((t) => t.key !== self && !t.private);
  const people = (humans || HUMAN_TEAM).filter((x) => x.key !== 'ed' && x.name);
  const lines = [];
  lines.push('YOUR TEAM (Bedrock / trustEd). AI teammates are named; route human work to the role or queue, never to a person\'s desk.');
  for (const t of ai) lines.push(`- ${t.name} (AI, ${t.role}): ${t.lane}.${t.may_not_decide.length ? ` Does not decide: ${t.may_not_decide.join('; ')}.` : ''}`);
  for (const h of people) {
    lines.push(h.needs_ed_input
      ? `- ${h.name} (human, Bedrock staff; role not recorded): a colleague. Do not guess what they handle; route through ${h.route_as || 'info@'}.`
      : `- ${h.name} (human, ${h.role}): ${h.responsible_for.join('; ')}. Route as "${h.route_as}".`);
  }
  lines.push(`- Shared queues: ${SHARED_QUEUES.map((q) => `${q.queue} (${q.for})`).join('; ')}.`);
  lines.push('');
  lines.push(`ED GOJARA (human): ${ED_CONTEXT.role}`);
  lines.push(`Ed approves: ${ED_CONTEXT.approves.join('; ')}.`);
  lines.push(`Involve Ed when: ${ED_CONTEXT.involve_when.join('; ')}.`);
  lines.push(`Do NOT escalate to Ed: ${ED_CONTEXT.do_not_escalate.join('; ')}.`);
  lines.push(ED_CONTEXT.how_to_involve);
  lines.push('');
  lines.push('BEFORE YOU ACT, decide who owns it: you; another AI teammate; a human role; Ed\'s approval; the board\'s approval; legal or accounting review. Do everything inside your authority, then hand off the rest.');
  lines.push('A HANDOFF CARRIES THE CONTEXT: who they are, what they asked, what is known and unknown, what has been done, what was promised, and the next step. Never ask the customer to repeat what the team already has.');
  lines.push('WORK A TEAMMATE DID IS TEAM WORK: if it is in the shared record, answer from it and credit them. Say "I don\'t know" only when it is not on the record, and then say who you are asking.');
  return lines.join('\n');
}

module.exports = {
  ED_CONTEXT, HUMAN_TEAM, SHARED_QUEUES, AI_AUTHORITY, OWNER_CLASSES, AUTHORITY,
  HANDOFF_FIELDS, WORK_RECORD_FIELDS, aiTeam, directory, directoryBlock, liveHumans,
};
