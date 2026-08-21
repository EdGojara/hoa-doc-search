// ============================================================================
// lib/ea/tessa_identity.js — the people Tessa should never have to look up.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "tessa is having a hard time understanding me, she doesn't know
// who Ed is."
//
// He asked her to "copy ed and martha". She found Martha, then asked "which one
// did you mean by 'ed'?" and offered Hope Lloyd, HomeWiseDocs Implementation,
// Claire Bennett, the jobs inbox, and a RealPage rep.
//
// TWO SEPARATE FAULTS, and the second one is the ugly one:
//
//  1. She had no record of her own boss. Tessa is Ed's executive assistant and
//     the single most common person in any instruction he gives her is Ed. He
//     was not in the address book, not in the team roster (that file is the AI
//     team), and nowhere else she looks.
//
//  2. The contact search matches substrings against the EMAIL column, so "ed"
//     matched 96 of 539 contacts — every @b-ed-rocktx.com address, plus
//     homewis-ed-ocs.com, f-ed-ex.com and inde-ed-email.com. A two-letter hint
//     against a domain name is not a match, it is a coincidence.
//
// This file fixes the first. It answers, with certainty and without asking, for
// the handful of people Tessa deals with constantly: Ed himself, first-person
// references to him, and the AI team (roster.js remains the source of truth for
// who works here, per the standing rule that every other list derives from it).
//
// Anyone NOT in here still goes through the normal contact search. This is a
// fast path for the obvious, not a replacement for looking people up.
// ============================================================================
const graphSend = require('../email/graph_send');

// Normalise for comparison: lowercase, punctuation out, collapse whitespace.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Ed refers to himself in the third person when dictating instructions for
// Tessa to carry out ("ed asked me to reach out"), and in the first person when
// telling her what to do ("copy me"). Both mean the same address.
const ED_ALIASES = new Set([
  'ed', 'ed gojara', 'gojara', 'edward gojara',
  'me', 'myself', 'my', 'i', 'the boss', 'boss', 'the owner', 'owner',
]);

function edIdentity() {
  return {
    name: 'Ed Gojara',
    email: graphSend.ED_MAILBOX,
    position: 'Owner, Bedrock Association Management',
    source: 'known_identity',
  };
}

// The AI team. roster.js is the single source of truth for who works here, so
// this derives from it rather than restating the list.
function teamIdentities() {
  let roster = [];
  try { roster = require('../team/roster').ROSTER || []; } catch (_) { roster = []; }
  const out = [];
  for (const p of roster) {
    if (!p || !p.persona) continue;
    // Their real mailbox, from the same constants the send path uses.
    const key = `${String(p.persona).toUpperCase()}_MAILBOX`;
    const email = graphSend[key];
    if (!email) continue;                     // no mailbox of their own (Isabella)
    out.push({
      name: p.name,
      email,
      position: p.signature_title || p.title || null,
      persona: p.persona,
      source: 'known_identity',
    });
  }
  return out;
}

// Resolve a hint to somebody Tessa already knows. Returns null when she does
// not, which sends the caller back to the normal contact search.
//
// Matching is EXACT on the normalised string, deliberately. A fuzzy match here
// would be worse than no match: quietly resolving "eddie at the bank" to Ed
// because it starts with "ed" is the same class of mistake as matching "ed"
// inside "bedrocktx.com".
function resolveKnownIdentity(hint) {
  const h = norm(hint);
  if (!h) return null;

  if (ED_ALIASES.has(h)) return edIdentity();

  for (const person of teamIdentities()) {
    const full = norm(person.name);
    const first = full.split(' ')[0];
    if (h === full || h === first || h === norm(person.persona)) return person;
    // "amanda albright" typed as "albright"
    const last = full.split(' ').slice(1).join(' ');
    if (last && h === last) return person;
  }
  return null;
}

// Everyone Tessa knows by heart, for the UI and for tests.
function knownIdentities() {
  return [edIdentity(), ...teamIdentities()];
}

module.exports = { resolveKnownIdentity, knownIdentities, edIdentity, teamIdentities, ED_ALIASES, norm };
