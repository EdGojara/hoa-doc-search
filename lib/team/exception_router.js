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

// The safety invariant, enforced in one place: any signal off-nominal (reserved,
// ungrounded, charged/hardship, unverified sender) routes to needs_review and can
// never be waved through as auto_ok.
function classifyDisposition({ gateAllowed, grounded, escalationReasons, audience }) {
  const reasons = [];
  if (!gateAllowed) reasons.push('reserved decision');
  for (const r of (escalationReasons || [])) reasons.push(r);
  if (!grounded) reasons.push('answer not grounded (fell back)');
  if (audience === 'other') reasons.push('sender not verified');
  const needsReview = reasons.length > 0;
  let confidence = 'high';
  if (!grounded || !gateAllowed) confidence = 'low';
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

module.exports = { classifyDisposition, dispositionForCareful };
