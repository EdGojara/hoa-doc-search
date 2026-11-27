// ============================================================================
// lib/characters/voice_models.js  (Ed 2026-11-27: Harper is Amanda's Canon voice)
// ----------------------------------------------------------------------------
// WHICH SPEECH MODEL speaks a teammate's canonical voice, per use. The Character
// Canon decides the VOICE (lib/characters/production.js, provider-independent
// spec + an ElevenLabs mapping); the Canon spec deliberately carries no provider
// or model ids, so the model choice per use lives here, in one place.
//
//   conversation  Talk to Amanda (ElevenLabs Agents). English agents may only use
//                 Flash v2, Turbo v2 or v4 Turbo; v4 Turbo turns on expressive
//                 mode and the brain may add delivery cues ([laughs], [sighs] ...).
//   media         pre-rendered speech for video (HeyGen lip-sync audio, Media
//                 Studio, YouTube) and audio samples. Eleven v3: the model Ed
//                 auditioned Harper on, with audio tags. v3 accepts stability
//                 0, 0.5 or 1 only (Creative, Natural, Robust).
//
// A teammate without an entry keeps the platform defaults (conversation: English
// Flash v2; media: lib/voice/persona.js Flash v2.5 settings), so this file changes
// nothing for anyone not listed.
// ============================================================================

const DEFAULT_CONVERSATION = { model_id: 'eleven_flash_v2', expressive: false };

const BY_PERSONA = {
  // Ed 2026-11-27: "I approve Harper as Amanda's permanent Canon voice ... with Eleven v4 Turbo and
  // the expressive conversational settings I tested yesterday" (the 2026-11-26 owner audition).
  amanda: {
    conversation: { model_id: 'eleven_v4_turbo', expressive: true },
    // Natural stability: the restrained take of the 2026-11-26 Harper audition. A production can
    // still direct a different take per script.
    media: { model_id: 'eleven_v3', voice_settings: { stability: 0.5 } },
  },
};

/** The conversation model for a teammate's canonical voice: { model_id, expressive }. */
function conversationModelFor(persona) {
  const e = BY_PERSONA[String(persona || '').toLowerCase()];
  return { ...DEFAULT_CONVERSATION, ...((e && e.conversation) || {}) };
}

/** The pre-rendered speech model for a teammate, or null (use the platform default). */
function mediaModelFor(persona) {
  const e = BY_PERSONA[String(persona || '').toLowerCase()];
  return (e && e.media) ? { model_id: e.media.model_id, voice_settings: { ...(e.media.voice_settings || {}) } } : null;
}

module.exports = { conversationModelFor, mediaModelFor, DEFAULT_CONVERSATION, _BY_PERSONA: BY_PERSONA };
