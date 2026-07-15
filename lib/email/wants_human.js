// ============================================================================
// lib/email/wants_human.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Every AI signature promises: "Want a person instead? Just reply and I'll pass
// you to the team." NOTHING implemented that. A homeowner replying "I want to
// talk to a real person" landed in the same queue as everything else, with no
// priority — and Claire would cheerfully draft ANOTHER AI reply to them. Today
// Ed reads every message so it works; at 50 communities it silently breaks, and
// it breaks at the exact moment a frustrated owner decides we're hiding behind
// robots.
//
// So: detect the ask, flag it loudly, and DON'T let an AI answer it.
//
// Deliberately conservative — a false positive costs a human 10 seconds of
// attention; a false negative breaks a promise we printed in the signature.
// ============================================================================

// Explicit "get me a human" asks.
const ASKS_FOR_PERSON = new RegExp([
  // "talk/speak to a person" (real person, live person, actual human, someone)
  /\b(?:talk|speak|spoke|chat)\s+(?:to|with)\s+(?:an?\s+)?(?:real|live|actual|human|"?person"?)?\s*(?:person|human|being|rep|representative|manager|someone|somebody|agent)\b/,
  // "have someone call me", "can a person call me"
  /\b(?:someone|somebody|a\s+person|a\s+human|a\s+manager|a\s+rep)\s+(?:please\s+)?(?:call|contact|phone|reach|email)\s+me\b/,
  /\b(?:call|phone)\s+me\b/,
  // "I want/need a person/human"
  /\b(?:want|need|prefer|requesting|request)\s+(?:to\s+)?(?:speak\s+(?:to|with)\s+)?(?:an?\s+)?(?:real\s+|live\s+|actual\s+)?(?:person|human|manager|representative|rep)\b/,
  // "pass me to the team", "transfer me", "escalate"
  /\b(?:pass|transfer|connect|forward)\s+me\s+(?:to|on\s+to)\b/,
  /\bescalate\b/,
  // Frustration with the bot itself
  /\b(?:stop|quit)\s+(?:sending|emailing)\b.*\b(?:bot|robot|ai|automated)\b/,
  /\b(?:this|that|you)\s+(?:is|are|sounds?\s+like)\s+(?:a\s+)?(?:bot|robot|ai|automated|computer)\b/,
  /\b(?:not|don'?t\s+want)\s+(?:a\s+)?(?:bot|robot|ai|automated\s+(?:response|reply|message))\b/,
  /\bam\s+i\s+(?:talking|speaking)\s+to\s+(?:a\s+)?(?:bot|robot|human|person|real)\b/,
  /\bis\s+this\s+(?:a\s+)?(?:bot|robot|real\s+person|human|automated)\b/,
  /\breal\s+person\b/,
  /\bhuman\s+being\b/,
].map((r) => r.source).join('|'), 'i');

// Guardrail: a homeowner saying "I spoke to someone last week" is describing
// history, not asking for a handoff. Past-tense/hearsay framings around the
// same words shouldn't fire.
const PAST_OR_HEARSAY = /\b(?:spoke|talked|called|emailed|met)\s+(?:to|with)\s+\w+\s+(?:last|yesterday|earlier|on|about)\b/i;

/**
 * Did this person ask for a human?
 * @param {{subject?:string, body_full?:string, body_preview?:string}} email
 * @returns {{ wants:boolean, matched:string|null }}
 */
function wantsHuman(email) {
  const text = `${(email && email.subject) || ''}\n${(email && (email.body_full || email.body_preview)) || ''}`;
  if (!text.trim()) return { wants: false, matched: null };
  const m = text.match(ASKS_FOR_PERSON);
  if (!m) return { wants: false, matched: null };
  // If the ONLY signal sits inside a past-tense recollection, don't fire.
  const around = text.slice(Math.max(0, m.index - 60), m.index + 60);
  if (PAST_OR_HEARSAY.test(around) && !/\b(want|need|please|can\s+(?:someone|you))\b/i.test(around)) {
    return { wants: false, matched: null };
  }
  return { wants: true, matched: String(m[0]).trim().slice(0, 80) };
}

module.exports = { wantsHuman };
