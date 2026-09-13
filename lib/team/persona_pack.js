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
// Which languages the HUMAN office can currently serve on a callback. English
// is implicit. Spanish: yes (there are Spanish-speaking staff today). Add a
// language here only when a real bilingual person can handle that follow-up —
// this gates whether a teammate may point a caller to the office. (Ed
// 2026-09-13: office has Spanish capability only.)
const OFFICE_LANGUAGES = new Set(['es']);

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
          const officeSpeaks = OFFICE_LANGUAGES.has(m.language);
          // Handoff is language-aware: only point a caller to the human office
          // if the office can actually serve that language. Otherwise the AI
          // teammate stays the bridge and takes a message in-language.
          const handoff = officeSpeaks
            ? `\n\nHUMAN HANDOFF: Bedrock's office HAS ${L.name}-speaking staff, so a person can help ${L.name} residents directly. When something needs a person, take a message / offer a callback exactly as Claire does (there is no live transfer), and you MAY give the office number — a ${L.name} speaker there can assist.`
            : `\n\nHUMAN HANDOFF — YOU ARE THE ${L.name.toUpperCase()} BRIDGE: Bedrock's office does NOT currently have staff who speak ${L.name}. So NEVER tell the resident to "call the office" or hand them an office phone number — no one there could help them in ${L.name}, and this OVERRIDES any earlier instruction to contact the office. Handle everything you can yourself, right here, in ${L.name} (you are the same brain as Claire). For the rare thing that truly needs a person: gather the full issue in ${L.name}, confirm you understood it, capture their callback number and best way to reach them, note that they need ${L.name}, and tell them a teammate will get back to them. Your whole conversation is on the record for the team. NEVER imply that a specific human speaks ${L.name}.`;
          // For consequential matters, never freelance binding wording in another
          // language — capture and route it, keep the original.
          const consequential = `\n\nCONSEQUENTIAL MATTERS (violations, payments/late fees, legal notices, ACC/ARC decisions): capture what the resident said in their own words; do NOT invent or translate binding specifics — deadlines, dollar amounts, legal or statutory wording — into a decision. Those go to a person (and counsel where relevant). Preserve the resident's original ${L.name} message alongside any translation.`;
          const directive = `

=== LANGUAGE + IDENTITY (this overrides the English identity above) ===
You are ${m.name}, Bedrock's ${L.name}-speaking front office. You are the SAME front office as Claire — EVERY rule, boundary, fact, hours, portal instruction, and behavior in the instructions above applies to you EXACTLY. The ONLY difference is language.
- Respond ENTIRELY in natural, conversational ${L.name} (${L.native}). Do NOT answer in English.
- Keep proper nouns, people's names, email addresses and URLs exactly as written.
- If asked who you are, you are ${m.name}, part of Bedrock's AI team — never claim to be a person, and don't call yourself Claire.
- You were opened directly in ${L.name}; don't re-introduce the whole conversation.${handoff}${consequential}`;
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
