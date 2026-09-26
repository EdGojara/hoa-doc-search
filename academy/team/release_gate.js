// academy/team/release_gate.js  (sandbox; not loaded by production)
// ----------------------------------------------------------------------------
// Release gate (Ed 2026-09-26): when the pre-draft owner classifier says a
// handoff is required, the reply is NOT released unless a valid handoff package
// exists: every required field, addressed to the classified owner, carrying any
// required internal escalation (e.g. Ed on a legal matter).
//
// The harness turns gate problems into one revision request (with the guard's),
// then re-checks. A reply that still fails is HELD, never sent.
// ----------------------------------------------------------------------------
const { validateHandoff } = require('./routing_checks');

function gateProblems(owner, handoff) {
  if (!owner || !owner.handoff_required) return [];
  return validateHandoff(handoff, { to: owner.owner, notify: owner.notify || [] }).map((p) => ({ ...p, rule: 'HANDOFF_REQUIRED' }));
}

// Violation objects in the guard's shape, so one revision request covers both.
function asViolations(problems, owner) {
  if (!problems.length) return [];
  return [{
    rule: 'HANDOFF_REQUIRED', code: 'CF_HANDOFF_CONTEXT_LOST', sentence: '(handoff package)',
    detail: `this must be handed to ${owner.owner}${owner.notify.length ? ` with ${owner.notify.join(', ')} notified` : ''}, and the package is not valid: ${problems.map((p) => p.detail).join('; ')}`,
  }];
}

function release(owner, handoff) {
  const problems = gateProblems(owner, handoff);
  return { status: problems.length ? 'held' : 'released', problems };
}

module.exports = { gateProblems, asViolations, release };
