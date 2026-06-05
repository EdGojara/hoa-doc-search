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

// FAST PACING flag — when ON, lowers the Deepgram silence threshold from
// 1500 → 900ms. This pairs with bridge.js forcing semantic endpointing +
// backchannel on under the same flag, so the smart "are they actually done?"
// check defends against the interrupt regression that motivated the bump to
// 1500 in the first place (Ed 2026-05-24 test). Flag-based so it's a single
// rollback if anything goes sideways. Read AT MODULE LOAD — bridge reads the
// same env at module load too, so the two switches flip in lockstep.
const _fastPacing = (() => {
  const v = String(process.env.CLAIRE_FAST_PACING || '').trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1' || v === 'on';
})();
const STT_ENDPOINTING_MS = _fastPacing ? 900 : 1500;

const PERSONA = Object.freeze({
  name: 'Claire',
  brand: 'Bedrock',
  // Voice provider + voice id — ElevenLabs Flash v2 for low-latency streaming.
  // Final voice ID chosen after listening tests; placeholder is the default
  // warm female voice. Tunable per community in future if a board prefers.
  tts: {
    provider: 'elevenlabs',
    model: 'eleven_flash_v2_5',
    voice_id: 'ClH95FbjM9JXsdORDh0z', // "Mary — Calming, Reassuring and Steady" — Ed selected 2026-05-23 after A/B-testing against Sarah and other candidates. The descriptor maps directly to the Bedrock voice tone (calming = not rushed, reassuring = competent, steady = reliable). Sarah read as B2B-demo-clinical; Mary's register lands closer to "someone who actually cares" for HOA service context.
    stability: 0.35,      // Lowered 0.5→0.35 (Ed 2026-05-23): higher stability reads as monotone/clipped, which makes Claire sound rushed and rude. 0.35 gives more emotional variation per sentence. Tradeoff: occasional sentence-to-sentence inflection variance.
    similarity_boost: 0.75,
    style: 0.5,           // Raised 0.3→0.5 (Ed 2026-05-23): boosts expressiveness; warmer tone with the same words. Combined with the stability drop, Sarah should sound less call-center-clinical and more conversational.
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
    endpointing: STT_ENDPOINTING_MS, // ms of silence to consider an utterance complete. 1500ms is the safe default (bumped from 800 on 2026-05-24 after Claire interrupted callers mid-sentence). When CLAIRE_FAST_PACING=true is set on Render, this drops to 900ms AND bridge.js automatically forces semantic endpointing + backchannel on — the smart-layer defends against the interrupt regression. Net win: ~600ms shaved per turn with the same answers. Roll back by removing the env var (one flip).
    interim_results: true,
    vad_events: true,
  },
});

// The opener Claire delivers on every call. Community name is injected.
// Same casual register as the email-tone work that shipped 2026-05-23.
//
// Personalization tiers (in order of preference):
//   1. Caller matched by phone AND community known   → "Hey Ed — this is Claire from Bedrock. Calling about Canyon Gate?"
//   2. Caller matched by phone, community unknown    → "Hey Ed — this is Claire from Bedrock. What can I help with?"
//   3. Community known, caller anonymous             → "Hey, this is Claire from Bedrock — AI assistant for Canyon Gate. What can I help with?"
//   4. Generic Bedrock greeting                      → "Hey, this is Claire from Bedrock — an AI assistant for the property management team. What can I help with?"
//
// Honest-AI rule: every variant identifies Claire as AI within the first
// sentence. We never pretend to be a specific human.
//
// Phrasing notes from Ed 2026-05-23 testing:
//   - "AI assistant" reads sterile; "AI team member with Bedrock" frames Claire
//     as a colleague rather than a tool (humanizes without losing honesty)
//   - "Calling about [Community]?" sounded too direct/quiz-like; warmer to use
//     an open-ended invitation like "What's going on at [Community]?"
//   - Don't overuse the first name — once in the opener is enough; reserve
//     repeated name use for emotional moments or goodbyes (see CONVERSATIONAL
//     ENGAGEMENT block in reason.js system prompt)
function buildOpener(communityName, callerFirstName) {
  const brand = PERSONA.brand;
  // 2026-05-24 SECOND revision after first test call. Prior version had two
  // questions stacked ("Am I speaking with X, AND what can I help with?")
  // which gave the caller no beat to confirm identity before being asked
  // the next thing — sounded rushed and rude. New form: ONE question only.
  // When we have caller-ID we ASSUME it's them (they'll correct if wrong);
  // the opening question becomes the help-invite. Caller-ID known cases
  // skip the "am I speaking with" gate entirely — it's just friction when
  // we already know who they are. For unknown callers, the question is
  // identity + reason in one ask (which is fine because that's a natural
  // pair to answer together).
  if (callerFirstName && communityName) {
    return `Hi ${callerFirstName} — Claire here from ${brand}. What's going on at ${communityName} today?`;
  }
  if (callerFirstName) {
    return `Hi ${callerFirstName} — Claire here from ${brand}. What can I help with today?`;
  }
  if (communityName) {
    return `Hi, this is Claire — an AI team member with ${brand}. I see you're calling from ${communityName} — what's going on today?`;
  }
  return `Hi, this is Claire — an AI team member with ${brand}. What's your name and what can I help with today?`;
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
  // 2026-05-24 — Haiku started slipping in "good question" variants
  // despite explicit prompt ban. Defensive strip.
  /\bthat'?s\s+a\s+(?:good|great|thoughtful|fair|nice)\s+question[.,!?\s]*/gi,
  /\b(?:good|great|thoughtful|fair|nice)\s+question[.,!?\s]+/gi,
];

module.exports = {
  PERSONA,
  buildOpener,
  buildHandoffOffer,
  buildClose,
  BANNED_PATTERNS,
};
