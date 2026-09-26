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

// G4 (Ed 2026-09-26): a required handoff also needs a PERSISTED tracked work
// item owned by the recipient, with a due time. The package alone can be lost;
// the work item is what gets monitored.
function gateProblems(owner, handoff, workItems = []) {
  if (!owner || !owner.handoff_required) return [];
  const problems = validateHandoff(handoff, { to: owner.owner, notify: owner.notify || [] });
  const tracked = workItems.filter((w) => w && w.persisted && w.owner === String(owner.owner).toLowerCase() && w.due);
  if (!tracked.length) problems.push({ code: 'HO_NOT_TRACKED', detail: `no persisted work item owned by ${owner.owner} with a due time (the package alone is not monitored work)` });
  return problems.map((p) => ({ ...p, rule: 'HANDOFF_REQUIRED' }));
}

// Violation objects in the guard's shape, so one revision request covers both.
function asViolations(problems, owner) {
  if (!problems.length) return [];
  return [{
    rule: 'HANDOFF_REQUIRED', code: 'CF_HANDOFF_CONTEXT_LOST', sentence: '(handoff package)',
    detail: `this must be handed to ${owner.owner}${owner.notify.length ? ` with ${owner.notify.join(', ')} notified` : ''}, and the package is not valid: ${problems.map((p) => p.detail).join('; ')}`,
  }];
}

function release(owner, handoff, workItems = []) {
  const problems = gateProblems(owner, handoff, workItems);
  return { status: problems.length ? 'held' : 'released', problems };
}

module.exports = { gateProblems, asViolations, release };
