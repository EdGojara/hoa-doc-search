// ============================================================================
// lib/voice/persona_helpers.js — small utilities shared across voice modules
// ----------------------------------------------------------------------------
// Kept separate from persona.js (configuration) so the helpers can be
// imported without pulling the full config.
// ============================================================================

const { BANNED_PATTERNS } = require('./persona');

/** Strip banned phrases from a generated voice line. Mirrors the
 *  stripBannedPhrases() helper in server.js — same intent, lighter weight
 *  because voice lines are shorter.
 *
 *  @param {string} text — the candidate voice line
 *  @param {RegExp[]} [bannedPatternsOverride] — alternative banned list
 *    (used by non-default personas, e.g. Isabella's Spanish list). When
 *    omitted, uses Claire's English BANNED_PATTERNS. Each persona owns its
 *    own list rather than concatenating because the regex anchors (^...$)
 *    are language-specific and concatenation would let English patterns
 *    accidentally match Spanish words. */
function stripBannedPhrasesForVoice(text, bannedPatternsOverride) {
  if (!text || typeof text !== 'string') return text;
  const patterns = Array.isArray(bannedPatternsOverride) && bannedPatternsOverride.length > 0
    ? bannedPatternsOverride
    : BANNED_PATTERNS;
  // 2026-05-24 BUG FIX — strip stage-direction text BEFORE banned phrases.
  // Claude occasionally emits "[silent — waiting for them]" / "*[still
  // waiting quietly]*" when the conversation pacing prompt is interpreted
  // literally. Those characters get piped straight to ElevenLabs which
  // reads them out loud as "asterisk bracket silent dash..." — broke
  // a call 2026-05-24. Strip ANY content wrapped in square brackets or
  // asterisked brackets that contain stage-direction-y verbs (silent,
  // waiting, listening, pause, paused, quiet, etc.). Defensive layer on
  // top of the prompt instruction (reason.js system prompt also forbids
  // outputting these).
  let t = text;
  // Strip "[anything with silent/waiting/listening/pause/quiet]" patterns
  // (with or without surrounding asterisks / italics markers).
  t = t.replace(/\*?\[\s*(?:silent|silently|waiting|listening|pause|paused|quiet|quietly|no\s+response|nothing)[^\]]*\]\*?/gi, '');
  // Same stage-direction pattern but wrapped in parens — model dodged
  // the bracket filter on 2026-05-24 by outputting "(no response)".
  t = t.replace(/\(\s*(?:silent|silently|waiting|listening|pause|paused|quiet|quietly|no\s+response|staying\s+quiet|saying\s+nothing|nothing)[^)]*\)/gi, '');
  // Catch-all: any markdown-italic stage direction *[anything]*
  t = t.replace(/\*\[[^\]]*\]\*/g, '');
  for (const pattern of patterns) {
    t = t.replace(pattern, '').trim();
  }
  // Tidy: collapse double spaces, strip leading punctuation that may have
  // been left dangling after a banned opener was removed.
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/^[—,;\s]+/, '');
  return t.trim();
}

/** Detect intent to talk to a human, from a transcribed utterance. Used
 *  by the bridge to trigger a warm transfer mid-conversation. */
const HUMAN_REQUEST_PATTERNS = [
  /\b(?:can|could|may) (?:i|we) (?:speak|talk) (?:to|with) (?:a |an )?(?:person|human|real person|someone|manager|representative)\b/i,
  /\bspeak (?:to|with) (?:a |an )?(?:person|human|manager|representative)\b/i,
  /\b(?:get|put) me (?:through to|in touch with) (?:a |an )?(?:person|human|someone|manager)\b/i,
  /\bi (?:want|need|would like) (?:a |an )?(?:human|person|real person|manager|representative)\b/i,
  /\b(?:transfer|connect) me\b/i,
];
function detectHumanHandoffRequest(utterance) {
  if (!utterance) return false;
  return HUMAN_REQUEST_PATTERNS.some((p) => p.test(utterance));
}

/** Detect distress signals — for triggering the empathetic-handoff path
 *  faster. Heuristic, not perfect; bias toward false positives because
 *  handing off when uncertain is always the right call here. */
const DISTRESS_PATTERNS = [
  /\b(?:emergency|urgent|crisis)\b/i,
  /\b(?:flooding|fire|gas leak|break[- ]?in|injured|hurt)\b/i,
  /\b(?:i'?m|i am) (?:really|so|very)?\s*(?:upset|angry|frustrated|crying|losing it|fed up)\b/i,
  /\b(?:lawsuit|attorney|sue|sued|suing|lawyer)\b/i,
];
function detectDistress(utterance) {
  if (!utterance) return false;
  return DISTRESS_PATTERNS.some((p) => p.test(utterance));
}

/** Detect compliance-touching content — fines, violations, §209, waivers.
 *  Forces a handoff per the spec §7. */
const COMPLIANCE_PATTERNS = [
  /\b(?:fine|fines|violation|violations|enforcement)\b/i,
  /\b(?:waiv(?:e|er|ed)|forgiv(?:e|en|eness))\b/i,
  /\b(?:section|§)\s*209\b/i,
  /\b(?:cure period|hearing|appeal|due process)\b/i,
  /\b(?:lien|foreclos)/i,
];
function detectComplianceMatter(utterance) {
  if (!utterance) return false;
  return COMPLIANCE_PATTERNS.some((p) => p.test(utterance));
}

/** Detect that an account has been turned over to collections counsel.
 *  This is a stricter scope than generic compliance — once an attorney
 *  is handling the file, the management company cannot discuss specifics
 *  per TX rules of professional conduct + FDCPA. The bridge uses this to
 *  route to the 'at_legal' handoff variant which lands the boundary
 *  warmly instead of clinically. False positives are fine here (handoff
 *  is the right call when uncertain); false negatives drop the caller
 *  into the generic compliance path which is fine but cooler. */
const AT_LEGAL_PATTERNS = [
  /\b(?:collection|collections) attorney\b/i,
  /\b(?:collection|collections) (?:agency|law firm|firm)\b/i,
  /\b(?:turned over|sent) to (?:legal|the attorney|collections|the lawyer|the law firm)\b/i,
  /\b(?:account|file) (?:is|was|has been) (?:at|with|in) (?:legal|collections|the attorney|the lawyer)\b/i,
  /\b(?:my|the|i'?m at) account (?:is )?in legal\b/i,
  /\b(?:letter|notice|demand) from (?:the|your) (?:attorney|lawyer|law firm|collection)\b/i,
  /\b(?:filed|filing) (?:a )?lien (?:on|against)\b/i,
  /\bdemand letter\b/i,
  /\bRMWBH\b/i,                                    // common TX HOA collection attorney firm
  /\b(?:Riddle|Williams|Manion|Brundrett|Hieronymus)\b/i,  // common firm-name fragments
];
function detectAtLegalMatter(utterance) {
  if (!utterance) return false;
  return AT_LEGAL_PATTERNS.some((p) => p.test(utterance));
}

module.exports = {
  stripBannedPhrasesForVoice,
  detectHumanHandoffRequest,
  detectDistress,
  detectComplianceMatter,
  detectAtLegalMatter,
};
