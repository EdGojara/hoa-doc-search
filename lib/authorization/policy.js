// ============================================================================
// lib/authorization/policy.js  (Ed 2026-11-25: Owner Authorization Service)
// ----------------------------------------------------------------------------
// Who the AI teammates are, how sensitive each kind of action is, and which
// channels may authorize each sensitivity tier. PURE: no I/O. One policy for
// every teammate, module and channel; a module never invents its own.
//
// Tiers (set per ACTION TYPE, never by the channel the approval arrives on):
//   1  routine: accounting runs within the module's controls, conversion items,
//      drafts. Any verified channel (email reply, signed-in app or
//      conversation, an active grant or standing authority).
//   2  consequential: adopting a budget record, billing assessments, ACC
//      denials, amounts above a policy ceiling. Same channels, and a
//      conversational approval needs an explicit read-back of the exact items
//      before it executes.
//   3  sensitive: movement of money (transfers, payment release), vendor bank
//      details, live payments, user permissions. Signed-in owner with step-up
//      only; never a reply, conversation, voice call or integration. Accounting
//      authorization (an entry, an interfund payable) is tier 1; MOVING the cash
//      it describes is tier 3 and a separate action.
// ============================================================================

const TEAMMATES = {
  amanda: { id: 'ai-team:amanda', label: 'Amanda (AI community manager)', coordinator: true },
  kat: { id: 'ai-team:kat', label: 'Kat Reed (AI accounting manager)' },
  tessa: { id: 'ai-team:tessa', label: 'Tessa (AI executive assistant)' },
  annie: { id: 'ai-team:annie', label: 'Annie (AI architectural review)' },
  miranda: { id: 'ai-team:miranda', label: 'Miranda (AI compliance and enforcement)' },
  paige: { id: 'ai-team:paige', label: 'Paige (AI board operations)' },
  emma: { id: 'ai-team:emma', label: 'Emma (AI accounts payable)' },
  claude: { id: 'ai-team:claude', label: 'Claude (AI team)' },
};
const COORDINATOR = TEAMMATES.amanda.id;
const KNOWN_TEAMMATE_IDS = new Set(Object.values(TEAMMATES).map((t) => t.id));

// Channels that can carry an owner decision, and how each proves identity.
const CHANNELS = {
  email: 'reply from the owner mailbox to the exact request email, authenticated inside the Microsoft 365 tenant',
  in_app: 'the owner signed in to trustEd',
  conversation: 'a trustEd conversation in the owner\'s signed-in session',
  grant: 'an instruction under a time-limited grant the owner issued while signed in',
  standing: 'an action within standing delegated authority the owner issued while signed in',
  voice: 'a voice request completed by a step-up on the owner\'s authenticated device',
  integration: 'an external AI integration acting under a grant, or relayed for confirmation on a trusted channel',
};

const TIER_CHANNELS = {
  1: ['email', 'in_app', 'conversation', 'grant', 'standing'],
  2: ['email', 'in_app', 'conversation', 'grant', 'standing'],
  3: ['in_app'],
};
// Channels on which a tier-2 decision needs a read-back of the exact items first.
const READ_BACK = { 2: ['email', 'conversation', 'voice', 'integration'] };

/** May this channel authorize an action of this tier? (Tier 3 also needs step-up in the app.) */
function channelAllowed(tier, channel) {
  return (TIER_CHANNELS[Number(tier)] || []).includes(channel);
}
function needsReadBack(tier, channel) {
  return (READ_BACK[Number(tier)] || []).includes(channel);
}
function needsStepUp(tier) { return Number(tier) >= 3; }

/** A teammate id must be one of the known AI teammates (or the posting system for in-app approvals). */
function isTeammate(id) { return KNOWN_TEAMMATE_IDS.has(String(id || '')); }

module.exports = { TEAMMATES, COORDINATOR, CHANNELS, TIER_CHANNELS, READ_BACK, channelAllowed, needsReadBack, needsStepUp, isTeammate };
