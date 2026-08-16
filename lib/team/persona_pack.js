// ============================================================================
// lib/team/persona_pack.js  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// Multiple personas, ONE brain.
//
// Giving each teammate a face without giving them a lane would be theatre: the
// screen changes, Annie's name appears, and the same generalist answer arrives.
// Giving each of them a separate reasoning stack would be the parallel-silo
// failure this codebase has paid for twice, and would mean nine copies of every
// guardrail to keep in sync.
//
// So: one reasoning core (lib/voice/reason.streamTurn), one retrieval, one set
// of rules — plus a thin identity layer per teammate. streamTurn already accepts
// a personaPack for exactly this (it is how Isabella's Spanish stack plugs in);
// this builds one from a roster entry, wrapping the default prompt builder
// rather than replacing it. A teammate can narrow the lane and change who is
// speaking. A teammate cannot loosen a rule.
// ============================================================================
const roster = require('./roster');

/**
 * Build a personaPack for any teammate on the roster, or null for the default
 * front office (Claire), where the base builder already applies.
 *
 * Returns { buildSystemPromptParts } in the shape streamTurn expects.
 */
function packFor(persona) {
  const m = roster.get(persona);
  if (!m || persona === 'claire') return null;   // Claire IS the base persona

  // Isabella has a real Spanish stack of her own — prompt, banned phrases and
  // all. Never shadow it with a thin English wrapper.
  if (persona === 'isabella') {
    try {
      const p = require('../voice/reason_isabella');
      return p.personaPack || p;
    } catch (e) {
      console.warn('[persona_pack] Spanish stack unavailable, falling back to the base persona:', e.message);
      return null;
    }
  }

  const { buildVoiceSystemPromptParts } = require('../voice/reason');

  return {
    persona: m.persona,
    buildSystemPromptParts(...args) {
      const base = buildVoiceSystemPromptParts(...args);
      const identity = `

WHO YOU ARE ON THIS CALL
You are ${m.name}, Bedrock's AI ${m.title.toLowerCase()}. You are NOT the front
office. Your lane is: ${m.domain}.

- Speak as ${m.name}. If you are asked who you are, you are ${m.name}, part of
  Bedrock's AI team, and you say so plainly. Never claim to be a human being.
- The visitor was just handed to you by a colleague, so do NOT re-introduce the
  whole conversation or ask them to repeat what they already said. Pick it up.
- Stay in your lane. If the question turns out to belong to a different
  teammate, say who should take it rather than guessing outside your depth. An
  answer outside your lane that turns out wrong costs more than a hand-off.
- Everything you are barred from doing still applies here in full. Being the
  specialist means you know the rule and where the request stands. It does not
  mean you get to decide it. You do not waive, reverse, approve, deny, or take
  a legal position, whatever the visitor's job title is.`;

      // Append, never replace: the base prompt carries the brand voice, the
      // banned-phrase list, the statutory rules and the account grounding.
      // A persona narrows; it does not get to drop any of that.
      return { stable: base.stable, variable: (base.variable || '') + identity };
    },
  };
}

module.exports = { packFor };
