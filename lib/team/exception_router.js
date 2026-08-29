// ============================================================================
// lib/team/exception_router.js  (Ed 2026-08-28)
// ----------------------------------------------------------------------------
// The operator model, shared by the whole team. Every persona reply — Amanda's,
// and as they adopt the operator core, Claire's / Annie's / Miranda's / Emma's —
// classifies its own work into routine (auto_ok) vs exception (needs_review),
// so ONE exception queue works for the whole desk, not just one persona.
//
// This lives here, not in amanda_reply.js, on purpose: the primitive that
// decides "does a human need to see this" must not be a thing one teammate has
// and the others don't. That is the silo the roster header warns about — a
// capability copied per persona drifts; a capability shared per persona cannot.
//
// classifyDisposition() is the rich form: it reads the four signals an operator
// reply computes (reserved-decision gate fired, answer grounded, thread
// charged/hardship/legal, sender verified). dispositionForCareful() is the
// honest baseline for a persona that does NOT yet compute those signals: a
// careful/sensitive draft is an exception; nothing else has earned auto_ok yet,
// so it stays an exception until that persona adopts the real signals. We do not
// mint a false auto_ok from a missing signal — the safety invariant is that
// anything uncertain is an exception.
// ============================================================================

// A litigation threat or a "we've retained counsel" claim is not a routine
// exception — it is the one inbound that must NEVER sit quietly in a medium
// queue, whichever teammate catches it (a homeowner is as likely to fire it at
// Claire or Miranda as at Darby). It carries legal exposure the moment it
// arrives: it wants a human, and usually counsel, now. So it is (a) a shared
// signal computed in the engine for every persona, not a per-persona trigger
// someone must remember to add, and (b) SEVERE — it forces the urgent tier.
const LEGAL_THREAT_REASON = 'litigation threat / retained counsel — escalate now';

// Imminent harm to a person or animal is the other thing that must never sit in
// a routine queue or get a bureaucratic brush-off. When it appears, the right
// handling is urgent, empathetic, and OWNS the escalation to the authority that
// can actually act (Animal Control, 911/police) — not "not our jurisdiction,
// here's a number." Shared across every lane; a homeowner reports a dying dog to
// whoever's inbox they have. (Ed 2026-08-29, the 5943 Baldwin Elm dog case.)
const HARM_REASON = 'possible imminent harm — escalate to a human + the proper authority now';

// The reasons that are not just "a human should look" but "a human should look
// NOW". A severe reason forces confidence to the urgent tier even when the draft
// is otherwise grounded and in-bounds.
const SEVERE_REASONS = new Set([LEGAL_THREAT_REASON, HARM_REASON]);

// Detect litigation intent WITHOUT tripping on the many benign uses of the word
// "attorney" in this domain (a closing attorney, power of attorney, "have your
// attorney send the payoff"). We require an actual intent-to-litigate signal:
// suing, court, a demand/cease-and-desist, retaining counsel to come after us,
// or the Texas DTPA that HOA disputes reach for by name.
const LEGAL_THREAT_PATTERNS = [
  /\bsue(d|ing|s)?\b/i,
  /\blaw ?suit\b/i,
  /\blitigat(e|ion|ing)\b/i,
  /\bcease and desist\b/i,
  /\bsmall claims\b/i,
  /\blegal action\b/i,
  /\bdemand letter\b/i,
  /\bbreach of fiduciary\b/i,
  /\b(dtpa|deceptive trade practices)\b/i,
  /\btake (you|this|the association|the hoa|the board|us|management)\b[^.]{0,40}\bto court\b/i,
  /\bsee you in court\b/i,
  /\bhearing from (my|our) (lawyer|attorney|counsel)\b/i,
  /\b(retain|retained|hire|hired|engag(e|ed)|got|have) (a |an |my |our )?(lawyer|attorney|counsel)\b/i,
  /\bfile (a |an )?(suit|complaint|claim|grievance)\b/i,
];
function detectLegalThreat(text) {
  const s = String(text || '');
  return LEGAL_THREAT_PATTERNS.some((re) => re.test(s)) ? LEGAL_THREAT_REASON : null;
}

// Detect imminent harm. Strong standalone signals (violence, self-harm, medical,
// hazard) fire on their own; animal welfare requires an animal word AND a
// distress word together, so "I have a dog" doesn't trip but "dog left in a hot
// garage, crying for help" does. Erring toward catching is acceptable: a positive
// only means urgent human review + an empathetic, authority-forward reply, never
// anything destructive.
const HARM_PATTERNS = [
  /\b(threaten(ing|ed)?|going to|about to|gonna)\b[^.]{0,30}\b(hurt|harm|kill|shoot|stab|attack|beat)\b/i,
  /\b(suicidal|suicide|kill myself|end my life|hurt myself|harm myself)\b/i,
  /\bdomestic (violence|abuse)\b/i,
  /\bchild (abuse|neglect)\b|\bchild (is |was )?(in danger|left alone|home alone)\b/i,
  /\b(unconscious|not breathing|bleeding (badly|out)|overdos(e|ing))\b/i,
  /\b(gas leak|carbon monoxide|house (is )?on fire|actively on fire)\b/i,
  /\bmedical emergency\b/i,
];
const HARM_ANIMAL = /\b(animal|dog|cat|pet|puppy|kitten|horse|livestock)s?\b/i;
const HARM_ANIMAL_DISTRESS = /\b(cruel|cruelty|abuse|abused|neglect|dying|distress|starv|suffering|no (food|water|shade)|left (in|out)|locked (in|up)|chained|caged|crying for help|hot (car|garage|vehicle)|unlawfully restrained|inadequate (shelter|enclosure))\b/i;
function detectHarmEmergency(text) {
  const s = String(text || '');
  if (HARM_PATTERNS.some((re) => re.test(s))) return HARM_REASON;
  if (HARM_ANIMAL.test(s) && HARM_ANIMAL_DISTRESS.test(s)) return HARM_REASON;
  return null;
}

// The response-shaping instruction injected into a draft when harm is detected —
// so the reply owns the escalation instead of deflecting.
const HARM_DRAFT_INSTRUCTION = `IMMINENT-HARM SIGNAL DETECTED — handle with urgency and OWNERSHIP, not process. Lead with genuine empathy. If a person or an animal may be in real danger, clearly point the sender to the authority that can actually act — for an animal, their county Animal Control; for a person, 911 or local police — and what documentation to bring. Do NOT state a specific phone number unless it is given in the CONTEXT; if you are not certain of it, tell them to look up their county Animal Control (911 for an emergency is always safe to give). Then state plainly what WE are doing on our end and that we are treating this as urgent and escalating it internally to the team (never to a named individual). Do NOT give a bureaucratic brush-off, do NOT say only that it is "not our jurisdiction," and do NOT close with a cheerful sign-off like "have a great weekend." Take ownership of driving it.`;

// The safety invariant, enforced in one place: any signal off-nominal (reserved,
// ungrounded, charged/hardship, unverified sender, litigation threat) routes to
// needs_review and can never be waved through as auto_ok. A SEVERE reason also
// forces the urgent (low) tier so it sorts to the top of the human's queue.
function classifyDisposition({ gateAllowed, grounded, escalationReasons, audience }) {
  const reasons = [];
  if (!gateAllowed) reasons.push('reserved decision');
  for (const r of (escalationReasons || [])) reasons.push(r);
  if (!grounded) reasons.push('answer not grounded (fell back)');
  if (audience === 'other') reasons.push('sender not verified');
  const needsReview = reasons.length > 0;
  const severe = reasons.some((r) => SEVERE_REASONS.has(r));
  let confidence = 'high';
  if (!grounded || !gateAllowed || severe) confidence = 'low';
  else if (needsReview) confidence = 'medium';
  return {
    disposition: needsReview ? 'needs_review' : 'auto_ok',
    confidence,
    reason: reasons.join('; ') || 'routine, grounded, in-bounds, verified sender',
  };
}

// Baseline for a persona without the full operator signals: a careful/sensitive
// draft is an exception; anything else is unproven, so it is ALSO an exception
// until that persona computes real signals. Never fabricates an auto_ok.
function dispositionForCareful(careful) {
  return {
    disposition: 'needs_review',
    confidence: careful ? 'low' : 'medium',
    reason: careful ? 'careful hold (specialist decision or sensitive lane)' : 'no operator signals yet — human review until this persona adopts the operator core',
  };
}

module.exports = {
  classifyDisposition, dispositionForCareful,
  detectLegalThreat, LEGAL_THREAT_REASON,
  detectHarmEmergency, HARM_REASON, HARM_DRAFT_INSTRUCTION,
};
