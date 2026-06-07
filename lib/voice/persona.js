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
    voice_id: 'gJx1vCzNCD1EQHT212Ls', // "Ava — Eager, Helpful and Understanding" — Ed selected 2026-06-08 to shift the Bedrock voice from "calming property manager" to "youthful AI-native operations." Mary (ClH95FbjM9JXsdORDh0z) read as older + slower; Ava reads ~late-20s with conversational energy. The "Eager" + "Helpful" descriptors map to Bedrock's brand positioning as a modern AI-native HOA company, not a stodgy traditional management firm. Fallback to Mary by reverting this line if Ava doesn't survive real-phone codec testing.
    stability: 0.40,      // Bumped 0.35→0.40 for Ava (Ed 2026-06-08): younger voices tend toward more variability already, so we tighten slightly to keep her from sounding rushed across longer sentences. Still in the "expressive" zone (under 0.5).
    similarity_boost: 0.85, // Raised 0.75→0.85 for Ava (Ed 2026-06-08): keeps her sounding distinctly like Ava through the Flash v2.5 pipeline + phone codec compression. Younger voices lose more character through low-bandwidth audio without the boost.
    style: 0.55,          // Slight bump 0.5→0.55 for Ava (Ed 2026-06-08): leans into the "Eager" descriptor without crossing into chirpy. Combined with stability=0.40, gives her energy without rushing.
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
// Time-of-day awareness (Ed 2026-06-08). Bedrock's office hours are roughly
// 9am-5pm Central, Mon-Fri. After-hours calls get a slightly different
// opening (still warm but doesn't promise a same-day callback that won't
// happen). Time computed in Central regardless of server timezone.
function _timeOfDayContext() {
  const central = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = central.getHours();
  const day = central.getDay();  // 0 = Sun, 6 = Sat
  const isWeekend = day === 0 || day === 6;
  const inBusinessWindow = !isWeekend && hour >= 9 && hour < 17;
  let greeting;
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';
  return { greeting, in_business_hours: inBusinessWindow, hour, day, is_weekend: isWeekend };
}

function buildOpener(communityName, callerFirstName, warmupHint) {
  const brand = PERSONA.brand;
  const { greeting } = _timeOfDayContext();
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
  //
  // 2026-06-08 — added time-of-day greeting + optional warmupHint. When the
  // pre-call context fetch surfaces a likely call reason (open ACC, recent
  // AR follow-up, etc.) we use it as a soft probe instead of the generic
  // "what's going on" question. Encode-Ed: the system shows up already
  // informed about the caller's context.
  if (callerFirstName && warmupHint) {
    return `${greeting}, ${callerFirstName} — Claire here from ${brand}. ${warmupHint}`;
  }
  if (callerFirstName && communityName) {
    return `${greeting}, ${callerFirstName} — Claire here from ${brand}. What's going on at ${communityName} today?`;
  }
  if (callerFirstName) {
    return `${greeting}, ${callerFirstName} — Claire here from ${brand}. What can I help with today?`;
  }
  if (communityName) {
    return `${greeting}, this is Claire — an AI team member with ${brand}. I see you're calling from ${communityName} — what's going on today?`;
  }
  return `${greeting}, this is Claire — an AI team member with ${brand}. What's your name and what can I help with today?`;
}

// Human-handoff phrase Claire uses when she senses the caller wants a
// person, OR when the conversation hits an escalation flag, OR when the
// caller explicitly asks.
//
// HARD RULE #4 alignment (Ed 2026-06-08): never "put you through" —
// there is no live transfer mechanism. Always take-a-message instead.
// "Put you through" promises something the system can't deliver and
// erodes trust when the caller waits for a transfer that never happens.
//
// Pattern: warm acknowledgment → concrete next step (callback by team
// with a specific timeframe) → ask for the best number.
function buildHandoffOffer(reason) {
  if (reason === 'unresolvable') {
    return "Honestly, that's one I'd rather have someone on the team handle directly — they can call you back today with the answer. What's the best number to reach you at?";
  }
  if (reason === 'compliance') {
    return "That one touches our enforcement process — let me have the right person on the team call you back today. What's the best number for you?";
  }
  if (reason === 'at_legal') {
    // When an account has been turned over to a collection attorney, the
    // management company cannot discuss the matter under TX rules of
    // professional conduct + FDCPA scoping. The boundary IS the help —
    // but the handoff has to land with empathy because the caller is
    // often distressed (potential lien / collection / fees stacking).
    // We acknowledge what they're facing, name the boundary honestly,
    // and direct them to the attorney without sounding dismissive.
    return "I hear you, and I can tell this is weighing on you. Here's the honest piece — once an account moves to collections counsel, I'm not able to discuss the specifics on our side. That's not me brushing you off — it's so the attorney handling your file can do their job cleanly. Let me get you their direct contact, and if there's a hardship piece you want them to know about, you can raise that with them directly.";
  }
  if (reason === 'distressed') {
    return "I hear you. Let me have someone from the team call you back today — what's the best number to reach you at?";
  }
  // Default — caller explicitly asked for a human, or Claire detected the
  // request implicitly.
  return "Sure — let me have someone from the team call you back today. What's the best number for you?";
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
  // ---- Empathy AI-tells (added 2026-06-06 per Ed's empathy-pattern spec) ----
  // These generic acknowledgment phrases signal AI immediately and erode
  // the trust that the actual empathy pivot is supposed to build. The
  // posture (name what they're protecting in their own framing) replaces
  // these phrases — it does not coexist with them.
  /^i hear you'?re? frustrated/i,
  /^i hear that you'?re? frustrated/i,
  /^i hear how frustrated/i,
  /^i can hear how/i,
  /^that'?s completely valid/i,
  /^that'?s entirely valid/i,
  /^your (?:concern|frustration|feelings) (?:is|are) (?:completely |entirely |totally )?valid/i,
  /^i (?:completely |totally |fully )?understand your concern/i,
  /^i (?:completely |totally |fully )?understand your frustration/i,
  /^i can imagine how (?:frustrating|difficult|hard) (?:this|that) (?:is|must be)/i,
  /^that (?:sounds|must be) (?:so |really |incredibly )?(?:frustrating|difficult|hard)/i,
  /^i'?m sorry (?:to hear|that) you'?re (?:feeling|going through)/i,
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
  _timeOfDayContext,  // exported for reason.js to inject business-hours awareness
};
