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

// Per-language layer for the front-office personas. `bridges` are the short
// "give me a beat" fillers in that language (so a Spanish answer never opens
// with "One sec."); `banned` are phrase patterns to avoid. Adding a language is
// this entry + a roster persona + an opener + a lobby button — the RULES come
// from Claire's shared prompt automatically.
const LANGUAGES = {
  es: {
    name: 'Spanish',
    native: 'español natural y conversacional',
    bridges: (() => { try { return require('../voice/persona_isabella').BRIDGE_PHRASES; } catch (_) { return ['Un momento.', 'Déjame ver.']; } })(),
    banned: (() => { try { return require('../voice/persona_isabella').BANNED_PATTERNS; } catch (_) { return []; } })(),
  },
  zh: {
    name: 'Mandarin Chinese',
    native: '自然、口语化的简体中文（普通话）',
    bridges: ['稍等一下。', '我看一下。', '让我查一下。', '请稍候。'],
    banned: [],
  },
};

/**
 * Build a personaPack for any teammate on the roster, or null for the default
 * front office (Claire), where the base builder already applies.
 *
 * Returns { buildSystemPromptParts } in the shape streamTurn expects.
 */
function packFor(persona) {
  const m = roster.get(persona);
  if (!m || persona === 'claire') return null;   // Claire IS the base persona

  const { buildVoiceSystemPromptParts } = require('../voice/reason');

  // LANGUAGE personas (Isabella=Spanish, Mei=Mandarin, ...) are the SAME front
  // office as Claire, speaking another language. They are a THIN layer over
  // Claire's shared prompt — NOT a forked copy. This is the fix for the drift
  // bug: Isabella used to run her own full Spanish prompt (reason_isabella) that
  // never got Claire's newer rules (portal-only ARC, the fob rule, seasonal
  // hours), so she gave stale answers in Spanish. Now every rule Claire has, the
  // language personas inherit automatically — add a rule once, every language
  // gets it. (Ed 2026-09-12.)
  if ((m.tier === 'front_office' || m.counterpart_of === 'claire') && m.language && m.language !== 'en') {
    const L = LANGUAGES[m.language];
    if (L) {
      return {
        persona: m.persona,
        bridgePhrases: L.bridges,
        bannedPatterns: L.banned,
        buildSystemPromptParts(...args) {
          const base = buildVoiceSystemPromptParts(...args);
          const directive = `

=== LANGUAGE + IDENTITY (this overrides the English identity above) ===
You are ${m.name}, Bedrock's ${L.name}-speaking front office. You are the SAME front office as Claire — EVERY rule, boundary, fact, hours, portal instruction, and behavior in the instructions above applies to you EXACTLY. The ONLY difference is language.
- Respond ENTIRELY in natural, conversational ${L.name} (${L.native}). Do NOT answer in English.
- Keep proper nouns, people's names, email addresses and URLs exactly as written.
- If asked who you are, you are ${m.name}, part of Bedrock's AI team — never claim to be a person, and don't call yourself Claire.
- You were opened directly in ${L.name}; don't re-introduce the whole conversation.`;
          return { stable: base.stable, variable: (base.variable || '') + directive };
        },
      };
    }
  }

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
