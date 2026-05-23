// ============================================================================
// lib/voice/persona_helpers.js — small utilities shared across voice modules
// ----------------------------------------------------------------------------
// Kept separate from persona.js (configuration) so the helpers can be
// imported without pulling the full config.
// ============================================================================

const { BANNED_PATTERNS } = require('./persona');

/** Strip banned phrases from a generated voice line. Mirrors the
 *  stripBannedPhrases() helper in server.js — same intent, lighter weight
 *  because voice lines are shorter. */
function stripBannedPhrasesForVoice(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  for (const pattern of BANNED_PATTERNS) {
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

module.exports = {
  stripBannedPhrasesForVoice,
  detectHumanHandoffRequest,
  detectDistress,
  detectComplianceMatter,
};
