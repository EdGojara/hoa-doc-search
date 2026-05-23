// ============================================================================
// Claire — Bedrock's voice persona
// ----------------------------------------------------------------------------
// The voice that answers when homeowners call into a Bedrock-managed
// community. Single sonic brand across all communities; behavior is shaped
// by the same Ed-voice system prompt as askEd, scoped to the caller's
// community via the same hybrid-retrieval pipeline.
//
// Design choices (see templates/responder-engine.spec.md §5):
//   - PERSONA NAME: "Claire" — clarity association lines up with Bedrock's
//     transparency thesis; two syllables, clean for TTS, common enough to
//     feel human without claiming to be a specific employee.
//   - HONEST DISCLOSURE: every opener identifies as AI. We do NOT pretend
//     to be a specific human. The casual-tone playbook says brevity +
//     specificity make it human, not pretending. Openly AI on direct channels.
//   - HUMAN HANDOFF: never "press 1." Always offered conversationally
//     ("want me to put you through to someone?"). Phone trees grate;
//     offered handoff feels respectful. Partial Stage-1 brief accompanies
//     the warm transfer.
// ============================================================================

const PERSONA = Object.freeze({
  name: 'Claire',
  brand: 'Bedrock',
  // Voice provider + voice id — ElevenLabs Flash v2 for low-latency streaming.
  // Final voice ID chosen after listening tests; placeholder is the default
  // warm female voice. Tunable per community in future if a board prefers.
  tts: {
    provider: 'elevenlabs',
    model: 'eleven_flash_v2_5',
    voice_id: 'EXAVITQu4vr4xnSDxMaL', // ElevenLabs default "Sarah" — placeholder; A/B test against alternatives before launch
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.3,
    use_speaker_boost: true,
  },
  // Speech-to-text — Deepgram Nova-2 streaming. Endpointing tuned for
  // conversational pauses (homeowners pause more than business callers).
  stt: {
    provider: 'deepgram',
    model: 'nova-2-phonecall',
    language: 'en-US',
    punctuate: true,
    smart_format: true,
    endpointing: 500, // ms of silence to consider an utterance complete
    interim_results: true,
    vad_events: true,
  },
});

// The opener Claire delivers on every call. Community name is injected.
// Same casual register as the email-tone work that shipped 2026-05-23.
function buildOpener(communityName) {
  if (!communityName) {
    return `Hey, this is Claire from ${PERSONA.brand} — an AI assistant for the property management team. What can I help with?`;
  }
  return `Hey, this is Claire from ${PERSONA.brand} — AI assistant for ${communityName}. What can I help with?`;
}

// Human-handoff phrase Claire uses when she senses the caller wants a
// person, OR when the conversation hits an escalation flag, OR when the
// caller explicitly asks. Never a phone-tree prompt; always conversational.
function buildHandoffOffer(reason) {
  if (reason === 'unresolvable') {
    return "Honestly, that's one I'd rather have someone on the team handle — let me put you through.";
  }
  if (reason === 'compliance') {
    return "That one touches our enforcement process, so I want to make sure the right person handles it — let me put you through.";
  }
  if (reason === 'distressed') {
    return "I hear you. Let me put you through to someone right now.";
  }
  // Default — caller explicitly asked for a human, or Claire detected the
  // request implicitly.
  return "Want me to put you through to someone on the team?";
}

// Closing line when the conversation wraps successfully — short, warm,
// no "have a great day!" cheese.
function buildClose(nextStepShort) {
  if (nextStepShort) {
    return `Okay — ${nextStepShort}. Take care.`;
  }
  return 'Got it. Take care.';
}

// Sentence patterns Claire NEVER says — same banned-phrase list as the
// chat/email tone work (server.js stripBannedPhrases). Defense-in-depth:
// the system prompt forbids them, AND the streaming TTS pipeline can
// filter them client-side before sending audio if anything slips through.
// We keep this list in sync with server.js manually for now; long term
// it should move into lib/banned_phrases.js shared by both surfaces.
const BANNED_PATTERNS = [
  /^thank you for reaching out/i,
  /^great question/i,
  /^certainly[!,—\s]+/i,
  /^of course[!,—\s]+/i,
  /\bi hope this helps/i,
  /please don't hesitate to/i,
  /i would be happy to/i,
  /how can i assist you today/i,
];

module.exports = {
  PERSONA,
  buildOpener,
  buildHandoffOffer,
  buildClose,
  BANNED_PATTERNS,
};
