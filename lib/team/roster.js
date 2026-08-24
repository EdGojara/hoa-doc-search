// ============================================================================
// lib/team/roster.js  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// WHO WORKS HERE. One roster, every surface.
//
// This file exists because there were three of them, drifting:
//
//   lib/email/persona.js      TEAM         8 teammates + general + Tessa
//   lib/email/route_specialist.js SPECIALISTS  5, hand-copied, with a comment
//                                              admitting it "mirrors persona.js TEAM"
//   lib/email/team_roster.js  AI_TEAM      4  ← the one injected into every
//                                              outbound persona's prompt
//
// The third one is the reason this got fixed rather than tidied. AI_TEAM feeds
// teamRosterBlock(), which tells every persona "these people work here with
// you" — and it listed four names. Kat Reed, Amanda Albright, Reese Calloway
// and Paige Chandler were missing. So Emma, reading a vendor's "I already spoke
// with Kat about this," had no idea Kat was her colleague. That is the EXACT
// bug team_roster.js was created to prevent, recurring against half the team,
// because the fix was a second list a human had to remember to update.
//
// A hand-mirrored list is not a source of truth, it is a promise to remember.
// So: one roster here, and the other three become derived views of it. Adding a
// teammate is one entry; drift is structurally impossible, and a test asserts
// the views still agree.
//
// This is also where FACES live. Multiple personas means multiple avatars and
// voices, resolved by env key per teammate, so the roster is the only place
// that knows Annie looks like Annie.
// ============================================================================

// Tiers, because scrutiny scales to the decision. Specialists own a lane;
// managers hold the escalation tier above them; the front office is the default
// door. A homeowner should never have to know which is which.
const TIERS = Object.freeze(['front_office', 'specialist', 'manager', 'executive']);

const ROSTER = [
  {
    persona: 'claire', name: 'Claire Bennett', title: 'Front office',
    signature_title: 'Customer Support Specialist', signature_phone: '(832) 588-2485',
    mailbox: 'info@ / claire@', self_mailbox: 'claire@', emoji: '💬',
    tier: 'front_office', language: 'en', face: 'CLAIRE',
    lane: 'general questions and getting you to the right person',
    domain: 'general homeowner questions, account and community information, and getting people to the right person',
    visit: true,
  },
  {
    persona: 'isabella', name: 'Isabella Reyes', title: 'Front office (Español)',
    mailbox: 'info@', self_mailbox: null, emoji: '🗣️',
    tier: 'front_office', language: 'es', face: 'ISABELLA',
    counterpart_of: 'claire',
    lane: 'the front office, in Spanish',
    domain: 'the same front-office lane as Claire, in Spanish',
    visit: true,
    // Not on the email board: Spanish correspondence routes to Claire's queue
    // today and Isabella is the voice/video counterpart. Listed so no persona
    // treats her as a stranger.
    email_board: false,
  },
  {
    persona: 'emma', name: 'Emma Brooks', title: 'Accounts payable',
    signature_title: 'Accounts Payable Specialist', signature_phone: '(832) 588-2485',
    mailbox: 'emma@', self_mailbox: 'emma@', emoji: '🧾',
    tier: 'specialist', language: 'en', face: 'EMMA',
    lane: 'vendor invoices and payments',
    domain: 'vendor invoices, payment status, W-9s and AP questions',
    // Vendors want their invoice paid, not a video visit. Her door is email
    // until there is a reason for it not to be.
    visit: false,
  },
  {
    persona: 'kat', name: 'Kat Reed', title: 'Accounting manager',
    signature_title: 'Accounting Manager', signature_phone: '(832) 588-2485',
    mailbox: 'kat@', self_mailbox: 'kat@', emoji: '📊',
    tier: 'manager', language: 'en', face: 'KAT',
    lane: 'assessments, payment plans and refunds',
    domain: 'assessments, payment plans, autopay, refunds, disputed charges and the association\'s books',
    visit: true,
  },
  {
    persona: 'annie', name: 'Annie Reeves', title: 'ACC / ARC',
    signature_title: 'Architectural Review Coordinator', signature_phone: '(832) 588-2485',
    mailbox: 'annie@', self_mailbox: 'annie@', emoji: '🏗️',
    tier: 'specialist', language: 'en', face: 'ANNIE',
    lane: 'architectural review',
    domain: 'architectural review: what the guidelines require, what a submittal still needs, and where an application stands',
    visit: true,
  },
  {
    persona: 'miranda', name: 'Miranda Pierce', title: 'Compliance / DRV',
    signature_title: 'Compliance Coordinator', signature_phone: '(832) 588-2485',
    mailbox: 'miranda@', self_mailbox: 'miranda@', emoji: '📋',
    tier: 'specialist', language: 'en', face: 'MIRANDA',
    lane: 'deed restriction notices',
    domain: 'deed-restriction notices: what a letter means, what the rule says, cure windows and how to close one out',
    visit: true,
  },
  {
    persona: 'amanda', name: 'Amanda Albright', title: 'Sr community manager',
    signature_title: 'Senior Community Manager', signature_phone: '(832) 588-2485',
    mailbox: 'amanda@', self_mailbox: 'amanda@', emoji: '🏘️',
    tier: 'manager', language: 'en', face: 'AMANDA',
    lane: 'escalations and community-wide issues',
    domain: 'escalations, community-wide issues and anything that has already been through a specialist',
    visit: true,
  },
  {
    persona: 'reese', name: 'Reese Calloway', title: 'Resale / estoppels',
    signature_title: 'Resale & Estoppel Coordinator', signature_phone: '(832) 588-2485',
    mailbox: 'reese@', self_mailbox: 'reese@', emoji: '🔑',
    tier: 'specialist', language: 'en', face: 'REESE',
    lane: 'resale certificates and closings',
    domain: 'resale certificates, estoppels, closings and transfers of ownership',
    visit: true,
  },
  {
    persona: 'paige', name: 'Paige Chandler', title: 'Board operations',
    signature_title: 'Board Operations Coordinator', signature_phone: '(832) 588-2485',
    mailbox: 'paige@', self_mailbox: 'paige@', emoji: '📦',
    tier: 'manager', language: 'en', face: 'PAIGE',
    lane: 'board meetings, packets and minutes',
    domain: 'board packets, meetings, agendas, minutes and governance questions',
    visit: true,
  },
  {
    persona: 'tessa', name: 'Tessa McCall', title: 'Executive assistant',
    signature_title: 'Executive Assistant', signature_phone: null,
    mailbox: 'tessa@', self_mailbox: 'tessa@', emoji: '💼',
    tier: 'executive', language: 'en', face: 'TESSA',
    lane: 'Ed\'s correspondence and follow-ups',
    domain: 'Ed\'s own correspondence and follow-ups',
    visit: true,
    owner_only: true, href: '/admin/tessa',
    email_board: 'owner_only',
  },
  {
    // Not a teammate — the unrouted pile. Kept in the roster because the email
    // board renders it as a column and it must not drift out of that list.
    persona: 'general', name: 'General inbox', title: 'Solicitations & other',
    mailbox: 'info@', self_mailbox: null, emoji: '📥',
    tier: 'front_office', language: 'en', face: null,
    lane: 'anything not yet routed',
    domain: 'anything not yet routed to a teammate',
    visit: false, catch_all: true, not_a_person: true,
  },
];

const BY_PERSONA = Object.freeze(Object.fromEntries(ROSTER.map((m) => [m.persona, m])));

function get(persona) { return BY_PERSONA[persona] || null; }

/** Real people (excludes the general/unrouted pile). */
function people() { return ROSTER.filter((m) => !m.not_a_person); }

/** Teammates who have a live video door, optionally in a given language. */
function visitPersonas(language) {
  return people().filter((m) => m.visit && (!language || m.language === language));
}

// ---- faces -----------------------------------------------------------------
// Resolved per teammate from env so each one can be locked independently:
//   ANNIE_AVATAR_ID / ANNIE_VOICE_ID, MIRANDA_AVATAR_ID, ...
// Claire keeps her original CLAIRE_AVATAR_ID / CLAIRE_VOICE_ID names so the
// existing configuration keeps working unchanged.
function avatarIdFor(persona) {
  const m = get(persona);
  if (!m || !m.face) return null;
  return process.env[`${m.face}_AVATAR_ID`] || null;
}
function voiceIdFor(persona) {
  const m = get(persona);
  if (!m || !m.face) return null;
  // ISABELLA_VOICE_ID already exists for the Spanish voice line; this keeps it.
  return process.env[`${m.face}_VOICE_ID`] || null;
}
/** Which teammates actually have a face configured right now. */
function facesConfigured() {
  return people().filter((m) => m.visit && avatarIdFor(m.persona));
}

/**
 * How a teammate introduces themselves. Honest-AI is not optional on a surface
 * with a realistic face: the opener names the person, that they are AI, and the
 * community, every time.
 */
function opener(persona, communityName, firstName) {
  const m = get(persona);
  if (!m) return null;
  const who = firstName ? `, ${firstName}` : '';
  if (m.language === 'es') {
    return `Hola${who}, soy ${m.name}, del equipo de inteligencia artificial de Bedrock para ${communityName}. En qué le puedo ayudar?`;
  }
  return `Hi${who}, I'm ${m.name}, Bedrock's AI ${m.title.toLowerCase()} for ${communityName}. What can I help with?`;
}

// The routing reasons come from the email hand-off card, which is written for a
// staffer reading a screen: "an architectural / exterior-modification (ACC)
// request". Spoken by a face, the slash and the acronym land as noise. This is
// the same string, said out loud.
function _speakable(why) {
  let s = String(why)
    .replace(/\s*\([^)]*\)\s*/g, ' ')   // drop parenthetical acronyms
    .replace(/\s{2,}/g, ' ')
    .trim();
  // "a / b / c" is unsayable. Three or more read as a list, two as a choice.
  if (s.includes('/')) {
    const parts = s.split(/\s*\/\s*/).filter(Boolean);
    s = parts.length > 2
      ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
      : parts.join(' or ');
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * The line Claire says when she brings a specialist in. Named handoff, not a
 * silent swap: someone whose screen changes face mid-sentence with no
 * explanation has been tricked, not helped.
 */
function handoffLine(fromPersona, toPersona, why) {
  const to = get(toPersona);
  if (!to) return null;
  // Uses `lane` (a short phrase), never `domain`. The domain string is written
  // for a system prompt and runs to a full clause list; said out loud in a video
  // hand-off it turns a one-breath sentence into a paragraph.
  const reason = why ? ` That is ${_speakable(why)}.` : '';
  return `${reason} Let me bring in ${to.name}, who handles ${to.lane}. One second.`.trim();
}

module.exports = {
  ROSTER, TIERS, get, people, visitPersonas,
  avatarIdFor, voiceIdFor, facesConfigured,
  opener, handoffLine,
};
