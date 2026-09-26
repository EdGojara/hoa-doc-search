// academy/team/owner_classifier.js  (sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Pre-draft OWNER / AUTHORITY classifier (Ed 2026-09-26). Ownership is decided
// BEFORE the agent drafts, deterministically, so an agent can no longer decide
// ownership after the fact (v1.2: Amanda kept a legal threat, Kat's
// reconciliation, and a site visit).
//
// Flow:  request -> OWNER/AUTHORITY -> intent -> context -> plan -> draft
//        -> fact/capability guard -> release gate (handoff package) -> send/handoff
//
// owner_class: who owns the next substantive step
//   current_agent | ai_teammate | human_role | ed | board | legal | accounting
//   | community_governance_body
// Also returned: owner (key), reason, authority_required (who must approve),
// notify (internal escalation recipients), handoff_required, accountable
// (who keeps follow-through; the originating agent unless ownership is
// explicitly transferred), transfer, consult, signals.
//
// Rules are ordered; the first match wins. Every rule cites where the rule
// lives (directory AUTHORITY, sla.js ROUTES, Ed's decisions).
// ----------------------------------------------------------------------------
const { decidingBody } = require('./governance');

const RX = {
  legal: /\b(attorney|lawyer|lawsuit|sue\b|suing|legal action|counsel|cease and desist|demand letter|subpoena|take (you|this) to court|small claims)\b/i,
  government: /\b(county|city of|tax (notice|assessor|office)|irs|comptroller|regulator|state agency|code enforcement)\b/i,
  bedrockComplaint: /\b(fire (bedrock|you|your company)|terminate (bedrock|your (company|contract|management))|(your|the) management company (is|has been) (terrible|awful|failing)|complain(t)? about (bedrock|your company))\b/i,
  pricing: /\b(what would (bedrock|you) charge|how much (do|would) you charge|pricing|price per (door|home)|management (fee|proposal|contract)|proposal for (our|management))\b/i,
  posting: /\b(reclass\w*|journal entr(y|ies)|post (it|this|that|the entry)|posted this month|(move|transfer) \$?[\d,]+|(to|into|from) the reserve( fund| account)?\b(?!.*\bmade\b))/i,
  approvalAsk: /\b(ok to|okay to|go ahead|can you|could you|please|wants?|should we|approve)\b/i,
  discrepancy: /\b(statement|financials|balance|ledger|books|bank)\b[^?.!]{0,80}\b(shows?|says?|differ\w*|does ?n'?t match|off by|which is right|discrepanc\w*|reconcil\w*)\b|\bwhich is right\b/i,
  waiver: /\b(waive|waiver|forgive|reduce|refund|credit back|remove) (the |my |a |this |that )?(\$?[\d,]+ )?(late )?(fee|fine|penalty|interest|charge)s?\b|\bwaive (it|that|this)\b/i,
  spend: /\b(approve (the )?(bid|quote|contract|proposal|spend)|sign (the )?(contract|agreement)|bind (the |a )?(policy|coverage))\b/i,
  physical: /\b(come (out |over )?(and )?(look|see|check|inspect)|coming out|come look|look at it with me|walk (it|the \w+) with me|meet (me|us) (there|on site|at)|site visit|in person|walk-?through)\b/i,
  meetingSetup: /\b(set (it|this|that) up|schedule|do the \d{4}? ?\w* ?meeting|call a (special )?meeting|put (it|this) on the agenda|send (the )?notice)\b/i,
  meetingWords: /\b(meeting|agenda|notice|minutes|packet|election|ballot|written consent)\b/i,
  actionItems: /\baction items?\b/i,
  newsletter: /\b(newsletter|resident update|community update)\b/i,
  unconfirmedCtx: /\b(no firm date|weather permitting|not (yet )?confirmed|unconfirmed|should finish|tentative)\b/i,
  invoiceRoute: /\b(send|submit|email|mail) (the |my |an |our )?invoice|\binvoice to\b|who do i (send|bill)\b/i,
  violation: /\b(violation|cure period|courtesy notice|deed restriction)\b/i,
  resale: /\b(resale certificate|estoppel|closing|title company)\b/i,
  // an application-approval question, not any sentence that mentions "ACC"
  arcApproval: /\b(will (it|this|that|my \w+) (get|be) approved|approv(e|al) (of )?(my|the|our) (fence|application|plans?|request)|can i (build|install|put up|add|paint)|is my (application|request) approved)\b/i,
  arcHistory: /\b(fence|shed|pool|patio|addition|paint|roof|application|survey|plans?)\b/i,
  governance: /\b(can the board|without (asking us|a (member )?vote|member approval)|member vote|need a vote|amend\w*|bylaws|declaration|rules? change|change the (\w+ )?rules|on (our|its) own)\b/i,
  status: /\b(did (we|the|you)|was (the|our|it)|has (the|it)|have (we|you)|any update|where are we|is (someone|the|it|our)\b.*\?|still (coming|waiting|open)|go out\?|been paid|get paid)\b|\b(was|were|is|has|have) [\w' ]{0,40}\b(paid|sent|mailed|posted|done|made|completed|scheduled)\b/i,
};

const ROUTINE_LANES = [
  { key: 'emma', re: RX.invoiceRoute, reason: 'vendor invoices go to Emma (AP pipeline)', transfer: true },
  { key: 'miranda', re: RX.violation, reason: 'violation notices and cure periods are Miranda\'s lane', transfer: false, notFor: /harass|attorney/i },
  { key: 'reese', re: RX.resale, reason: 'resale certificates and closings are Reese\'s lane', transfer: true },
];

function base(agent) { return { owner_class: 'current_agent', owner: agent, reason: '', authority_required: [], notify: [], handoff_required: false, accountable: agent, transfer: false, consult: [], signals: [] }; }

/**
 * @param {object} p
 * @param {string} p.message
 * @param {string} p.agent             roster key of the agent receiving it
 * @param {string} [p.audience]
 * @param {string} [p.contextText]     context + history text
 * @param {Array}  [p.sharedWork]      shared team record entries
 * @param {object} [p.community]       community_context (governance bodies)
 */
function classifyOwner({ message, agent, audience = '', contextText = '', history = [], sharedWork = [], community = {} }) {
  const m = String(message || '');
  const hist = (history || []).map((h) => h.text).join(' ');
  const out = base(agent);
  const set = (o) => Object.assign(out, o, { handoff_required: o.handoff_required !== undefined ? o.handoff_required : (o.owner && o.owner !== agent) });
  const sig = (s) => out.signals.push(s);

  // 1. Legal threats: legal-review path (Darby coordinates counsel; Ed is the
  //    internal escalation). Nobody argues the merits first. [sla.js ROUTES legal -> Ed]
  if (RX.legal.test(m)) {
    sig('legal');
    return set({ owner_class: 'legal', owner: 'darby', reason: 'a legal threat or attorney communication goes to legal review before anyone responds on the merits', authority_required: ['legal_review'], notify: ['ed'], handoff_required: true });
  }
  // 2. Government / regulatory / tax -> Ed. [sla.js ROUTES government -> Ed]
  if (RX.government.test(m)) { sig('government'); return set({ owner_class: 'ed', owner: 'ed', reason: 'government, regulatory, and tax matters go to Ed', authority_required: ['ed_approval'], handoff_required: true }); }
  // 3. A complaint about Bedrock itself -> Ed. [directory ED_CONTEXT.involve_when]
  if (RX.bedrockComplaint.test(m)) { sig('bedrock_complaint'); return set({ owner_class: 'ed', owner: 'ed', reason: 'dissatisfaction with Bedrock itself goes to Ed', authority_required: [], handoff_required: true }); }
  // 4. Pricing / management contracts: Maggie runs the conversation; Ed approves. [Ed 2026-09-25]
  if (RX.pricing.test(m) && agent !== 'maggie') { sig('pricing'); return set({ owner_class: 'ai_teammate', owner: 'maggie', reason: 'prospect conversations are Maggie\'s lane; any pricing or contract commitment needs Ed', authority_required: ['ed_approval'], notify: [], transfer: true }); }
  // 5. Postings / reclasses / fund transfers: Kat prepares; Ed approves every
  //    posting; moving funds also needs board authority. [Ed 2026-09-25]
  if (RX.posting.test(m) && RX.approvalAsk.test(m)) {
    sig('posting');
    const funds = /\breserve|operating\b/i.test(m);
    return set({ owner_class: 'accounting', owner: agent === 'kat' ? 'kat' : 'kat', reason: 'every financial posting is prepared by Kat and approved by Ed' + (funds ? '; moving money between funds also needs board authority' : ''), authority_required: funds ? ['board_approval', 'ed_approval'] : ['ed_approval'], handoff_required: agent !== 'kat' });
  }
  // 6. A balance or statement discrepancy: accounting review (Kat). [TRIGGERS.kat]
  if (RX.discrepancy.test(m) && agent !== 'kat') { sig('discrepancy'); return set({ owner_class: 'accounting', owner: 'kat', reason: 'explaining or reconciling a balance is Kat\'s accounting review', authority_required: [] }); }
  // 7. Waivers and spends: the board decides; a manager carries it to them,
  //    front office hands it to Amanda. [amanda_reply.js reserved decisions]
  if (RX.waiver.test(m) || RX.spend.test(m)) {
    sig('board_decision');
    const carrier = ['amanda', 'paige'].includes(agent) ? agent : 'amanda';
    return set({ owner_class: 'board', owner: 'board', reason: 'waivers, spending, contracts, and binding coverage are board decisions', authority_required: ['board_approval'], handoff_required: carrier !== agent, accountable: agent, consult: carrier !== agent ? [carrier] : [] });
  }
  // 8. Architectural decisions: the community's established ACC/ARC if one is
  //    on record, else the board; Annie runs intake. [governance.js]
  if (RX.arcApproval.test(m) && (RX.arcHistory.test(m) || RX.arcHistory.test(hist))) {
    sig('architectural');
    const body = decidingBody(community, 'architectural');
    return set({ owner_class: body ? 'community_governance_body' : 'board', owner: agent === 'annie' ? 'annie' : 'annie', decision_body: body ? body.name : 'board', reason: `architectural applications: Annie handles intake; ${body ? `${body.name} decides (${body.source})` : 'no ACC/ARC is on record, so the board decides'}`, authority_required: [body ? 'community_governance_body' : 'board_approval'], handoff_required: agent !== 'annie' });
  }
  // 9. Needs a person on site -> the Community Manager (human role). If the
  //    shared record shows it is already assigned, answer from it; no new handoff.
  if (RX.physical.test(m)) {
    sig('physical');
    const assigned = sharedWork.find((w) => w.assigned && w.by === 'community_manager');
    return set({ owner_class: 'human_role', owner: 'community_manager', reason: assigned ? 'site work is the Community Manager\'s and is already assigned; answer from the record' : 'no AI teammate can be anywhere in person; site work goes to the Community Manager', authority_required: [], handoff_required: !assigned });
  }
  // 10. Status question the shared record answers: the current agent answers it
  //     and credits the teammate who did the work.
  if (sharedWork.length && RX.status.test(m)) { sig('shared_status'); return set({ owner_class: 'current_agent', owner: agent, reason: 'the shared team record answers this; answer it and credit the teammate', handoff_required: false }); }
  // 11. Meeting setup -> Paige (collaborate; the requester keeps the substance).
  if (agent !== 'paige' && RX.meetingWords.test(m) && RX.meetingSetup.test(m)) { sig('meeting_setup'); return set({ owner_class: 'ai_teammate', owner: 'paige', reason: 'meeting notice, agenda, and packet are Paige\'s lane; the budget substance stays with you', authority_required: [] }); }
  // 12. Board action items -> Amanda (operations owns execution).
  if (agent !== 'amanda' && RX.actionItems.test(m)) { sig('action_items'); return set({ owner_class: 'ai_teammate', owner: 'amanda', reason: 'operational action items from a meeting are Amanda\'s to execute', authority_required: [] }); }
  // 13. Newsletter: Phoebe's own lane; unconfirmed facts get confirmed with the owner first.
  if (agent === 'phoebe' && RX.newsletter.test(m)) {
    sig('newsletter');
    const unconfirmed = RX.unconfirmedCtx.test(contextText);
    return set({ owner_class: 'current_agent', owner: 'phoebe', reason: unconfirmed ? 'your lane, but a date or status is unconfirmed: confirm it with the owner before it prints' : 'your lane', consult: unconfirmed ? ['amanda'] : [], handoff_required: false });
  }
  // 14. Routine specialist lanes.
  for (const l of ROUTINE_LANES) {
    if (l.key !== agent && l.re.test(m) && !(l.notFor && l.notFor.test(m))) { sig(`lane:${l.key}`); return set({ owner_class: 'ai_teammate', owner: l.key, reason: l.reason, authority_required: [], transfer: l.transfer }); }
  }
  // 15. Governance interpretation: Amanda's judgment (front office hands it up).
  if (RX.governance.test(m)) {
    sig('governance');
    if (agent !== 'amanda') return set({ owner_class: 'ai_teammate', owner: 'amanda', reason: 'interpreting what the board may do under the governing documents is Amanda\'s judgment', authority_required: [] });
    return set({ owner_class: 'current_agent', owner: agent, reason: 'governance interpretation is yours; state only what the retrieved documents say, and route an unclear legal question to legal review', authority_required: [] });
  }
  // 16. Default: the agent who received it owns it.
  sig('default');
  return set({ owner_class: 'current_agent', owner: agent, reason: 'within your lane', handoff_required: false });
}

// Prompt block: ownership is stated to the agent as already decided.
function ownerBlock(o, { names = {} } = {}) {
  const n = (k) => names[k] || k;
  const lines = [`OWNERSHIP (decided before you draft; do not re-decide it): ${o.owner_class.replace(/_/g, ' ')}${o.owner && o.owner !== o.accountable ? `, owner: ${n(o.owner)}` : ''}.`, `Why: ${o.reason}.`];
  if (o.authority_required.length) lines.push(`Approval needed: ${o.authority_required.map((a) => a.replace(/_/g, ' ')).join(', ')}${o.decision_body ? ` (${o.decision_body})` : ''}. You do not make this decision.`);
  if (o.handoff_required) lines.push(`HANDOFF REQUIRED to ${n(o.owner)}: you may acknowledge the question, summarize the known facts, say who has it, and explain what happens next. Do not make the ruling yourself (no "so yes", no "the board can", no "it will be approved"). Include the HANDOFF package. Without a valid package your reply will not be released.`);
  if (o.notify.length) lines.push(`Internal escalation: also notify ${o.notify.map(n).join(', ')} (put them in the package's "notify").`);
  if (o.consult.length) lines.push(`Before you commit to facts, confirm them with ${o.consult.map(n).join(', ')}.`);
  lines.push(o.transfer ? `Ownership transfers to ${n(o.owner)}; say so plainly.` : `You stay accountable for follow-through: the person should hear from you (or know exactly who is on it) and never have to start over.`);
  if (o.owner_class === 'legal') lines.push(`Do not respond to the merits (whether the violation, fee, or decision was right). In one human sentence acknowledge that they are upset, without agreeing or arguing. Then say ${n(o.owner)}, who coordinates legal matters for Bedrock, has it, and that nothing they sent is lost. Stop there.`);
  return lines.join('\n');
}

module.exports = { classifyOwner, ownerBlock, RX };
