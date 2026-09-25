// academy/team/team_awareness.js  (DESIGN, sandbox; not loaded anywhere yet)
// ----------------------------------------------------------------------------
// Every agent knows every teammate's lane and when to HAND OFF (the teammate
// owns the work or decision), COLLABORATE (both lanes are involved; one keeps
// the thread), or ASK FOR EXPERTISE (keep ownership, borrow knowledge).
//
// Lanes come from lib/team/roster.js at runtime (single source of truth); only
// the handoff triggers live here. Customer-facing handoffs reuse
// roster.handoffLine() and always carry a context package so the person never
// repeats themselves.
// ----------------------------------------------------------------------------
const path = require('path');

const TRIGGERS = {
  claire:   { handoff_when: ['general questions she can fully answer are hers; everything lane-specific goes to its owner'], escalate_to: 'amanda' },
  isabella: { handoff_when: ['Spanish-language front office'], escalate_to: 'amanda' },
  mei:      { handoff_when: ['Mandarin-language front office'], escalate_to: 'amanda' },
  priya:    { handoff_when: ['Hindi-language front office'], escalate_to: 'amanda' },
  emma:     { handoff_when: ['a vendor invoice, payment status, or AP question', 'an invoice that looks unpaid but may have been paid (never pay twice)'] },
  kat:      { handoff_when: ['assessments, ledgers, payment plans outside standard policy, refunds', 'detailed accounting, reconciliation, recognition schedules, or anything touching posting'] },
  annie:    { handoff_when: ['architectural (ACC/ARC) applications, approvals, conditions'] },
  miranda:  { handoff_when: ['deed-restriction violation notices, cure periods, enforcement stage'] },
  amanda:   { handoff_when: ['tough, cross-lane, or relationship-heavy cases', 'anything already through a specialist that is still unresolved', 'a risk (insurance, safety, legal exposure) that needs a manager today'] },
  reese:    { handoff_when: ['resale certificates, closings, title or estoppel questions'] },
  darby:    { handoff_when: ['an account referred or about to be referred to collections counsel', 'any legal threat or counsel coordination'] },
  paige:    { handoff_when: ['board meetings, agendas, packets, minutes, notices, elections, governance procedure'] },
  phoebe:   { handoff_when: ['community newsletter, resident-wide updates, engagement and volunteer outreach'] },
  maggie:   { handoff_when: ['prospective communities, partnerships, proposals'] },
  tessa:    { handoff_when: ["Ed's own correspondence and follow-ups (owner-only; never routed to by other agents for customers)"], private: true },
};

// Collaboration patterns: two lanes, one owner of the thread.
const COLLABORATIONS = [
  { when: 'An issue will need a board decision', owner: 'amanda', with: ['paige'], how: 'Amanda frames the options and recommendation; Paige puts it on the agenda or runs written consent and records the outcome.' },
  { when: 'A resident-wide message about an operational issue', owner: 'phoebe', with: ['amanda'], how: 'Phoebe drafts for residents; Amanda (or the owning lane) confirms every fact and date before it goes out.' },
  { when: 'A board asks a finance question in a meeting context', owner: 'paige', with: ['kat'], how: 'Kat supplies the numbers and their basis; Paige places them in the packet.' },
  { when: 'A homeowner dispute spans a violation and a balance', owner: 'amanda', with: ['miranda', 'kat'], how: 'Amanda keeps one thread with the homeowner; Miranda owns the violation facts, Kat the ledger.' },
  { when: 'A delinquent account raises a legal threat', owner: 'darby', with: ['kat', 'amanda'], how: 'Darby coordinates counsel; Kat confirms the balance; Amanda handles the relationship.' },
];

const MODES = {
  handoff: 'The teammate owns the work or decision. Transfer it with a context package: who, what they asked, what is known, unknown, already done (action records), promised, and why it is theirs. Tell the person who will pick it up (roster.handoffLine).',
  collaborate: 'Both lanes are involved. One teammate owns the thread and the person; the other supplies their part. The owner never goes silent waiting.',
  ask_expertise: 'You keep ownership; you borrow knowledge ("Kat, what is the basis for this balance?"). Cite what you learned; do not present it as your own determination if it is theirs to make.',
};

function teamMap() {
  const { ROSTER } = require(path.join(__dirname, '..', '..', 'lib', 'team', 'roster'));
  return ROSTER.filter((p) => p.persona && p.persona !== 'general').map((p) => ({
    persona: p.persona, name: p.name, tier: p.tier, lane: p.lane, reports_to: p.reports_to || null,
    ...(TRIGGERS[p.persona] || { handoff_when: [], missing_triggers: true }),
  }));
}

// Rendered block for an agent's prompt (when approved): who's who, compactly.
function teamBlock(selfPersona) {
  const rows = teamMap().filter((t) => t.persona !== selfPersona && !t.private);
  return 'YOUR TEAMMATES (bring them in rather than doing their job badly; hand off with the full picture):\n'
    + rows.map((t) => `- ${t.name} (${t.lane})${t.handoff_when.length ? `: ${t.handoff_when.join('; ')}` : ''}`).join('\n');
}

module.exports = { TRIGGERS, COLLABORATIONS, MODES, teamMap, teamBlock };
