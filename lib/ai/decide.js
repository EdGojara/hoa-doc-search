// lib/ai/decide.js — the decision pipeline (health BEFORE semantics).
// route(ctx) is PURE and deterministic: given an assembled context it returns
// { business_decision, execution, reason_code, notification_level }. EXECUTE is
// reachable ONLY by falling through every gate — a model/verifier failure, a
// severity gate, a verification failure/disagreement, a safety guard, a human
// floor, or a non-autonomous state each returns before EXECUTE. This is what the
// selftest proves: nothing can accidentally execute.
//
// Business decision (APPROVE/DENY/NEED_INFO/ESCALATE/ANALYZE) and execution
// authorization (EXECUTE/REVIEW/BLOCK/ERROR) are SEPARATE first-class outputs.
const { agree } = require('./verify');

const EXEC = { EXECUTE: 'EXECUTE', REVIEW: 'REVIEW', BLOCK: 'BLOCK', ERROR: 'ERROR' };
const NOTE = { DECISION_REQUIRED: 'DECISION_REQUIRED', OPERATIONAL_EXCEPTION: 'OPERATIONAL_EXCEPTION', ANOMALY_WATCH: 'ANOMALY_WATCH', NONE: 'NONE' };

function verdict(business, execution, reason_code, notification_level, extra) {
  return { business_decision: business, execution, reason_code: reason_code || null, notification_level: notification_level || NOTE.NONE, ...(extra || {}) };
}

// ctx = {
//   subclass, task_type, policy,
//   retrieval: { complete } | null,
//   primary: { ok, text, structured, gate:{worst_fail}, meta } | { ok:false, error, meta },
//   verifier: { ran, ok, structured, meta } | null,
//   action_unsafe: bool,           // safety guard (e.g. stale letter, out-of-band post)
// }
function route(ctx) {
  const p = ctx.policy;
  const primary = ctx.primary || { ok: false, error: 'no primary result' };
  const business = (primary.ok && primary.structured && primary.structured.business_decision) || 'ANALYZE';

  // 1) HEALTH — model completed with usable content. Failure is ERROR, never content.
  if (!primary.ok) return verdict('ESCALATE', EXEC.ERROR, 'HEALTH_MODEL_ERROR', NOTE.OPERATIONAL_EXCEPTION);

  // 2) RETRIEVAL completeness (doc-dependent tasks)
  if (p.retrieval_required && !(ctx.retrieval && ctx.retrieval.complete)) {
    return verdict('ESCALATE', EXEC.REVIEW, 'HEALTH_RETRIEVAL_INCOMPLETE', NOTE.OPERATIONAL_EXCEPTION);
  }

  // 3) SEVERITY gate on the primary answer (worst failed check)
  const worst = primary.gate && primary.gate.worst_fail;
  if (worst === 'catastrophic') return verdict(business, EXEC.REVIEW, 'GATE_CATASTROPHIC', NOTE.DECISION_REQUIRED);
  if (worst === 'compliance') return verdict(business, EXEC.REVIEW, 'GATE_COMPLIANCE', NOTE.DECISION_REQUIRED);
  if (worst === 'financial') return verdict(business, EXEC.REVIEW, 'GATE_FINANCIAL', NOTE.DECISION_REQUIRED);

  // 3b) EVIDENCE completeness: an APPROVE that rests on a requirement whose
  //     rule-type evidence is missing cannot be confirmed — never trust it as
  //     compliant (don't lean on the verifier for what the contract should require).
  if (ctx.evidence_incomplete) return verdict(business, EXEC.REVIEW, 'EVIDENCE_INCOMPLETE', NOTE.DECISION_REQUIRED);

  // 4) Subjective-standard guard: an autonomous DENY needs an OBJECTIVE cited
  //    violation. A denial on a subjective standard escalates.
  if (business === 'DENY' && primary.structured && primary.structured.basis === 'subjective') {
    return verdict('ESCALATE', EXEC.REVIEW, 'SUBJECTIVE_STANDARD', NOTE.DECISION_REQUIRED);
  }

  // 5) VERIFICATION (fail CLOSED — unavailable never becomes agreement)
  if (p.verify) {
    const v = ctx.verifier;
    if (!v || !v.ran || !v.ok) return verdict(business, EXEC.REVIEW, 'VERIFY_UNAVAILABLE', NOTE.OPERATIONAL_EXCEPTION);
    const ag = agree(primary.structured || {}, v.structured || {}, ctx.task_type);
    if (!ag.agree) return verdict('ESCALATE', EXEC.REVIEW, 'VERIFY_DISAGREEMENT', NOTE.DECISION_REQUIRED, { disagreement: ag.reasons });
  }

  // 6) SAFETY guard — this specific action must not fire (BLOCK != deny)
  if (ctx.action_unsafe) return verdict(business, EXEC.BLOCK, 'ACTION_UNSAFE', NOTE.DECISION_REQUIRED);

  // 7) HUMAN FLOOR — certified §209 / GL posting: human authorizes regardless of agreement
  if (p.human_floor) return verdict(business, EXEC.REVIEW, 'HUMAN_FLOOR', NOTE.DECISION_REQUIRED);

  // 8) AUTONOMY STATE (per subclass, reversible)
  if (p.autonomy_state === 'shadow') return verdict(business, EXEC.REVIEW, 'AUTONOMY_STATE', NOTE.ANOMALY_WATCH, { shadow: true });

  // 9) Cleared to act — but cap at the subclass ceiling (e.g. board packet REVIEW)
  if (p.max_execution === 'REVIEW') return verdict(business, EXEC.REVIEW, 'AUTONOMY_CEILING', NOTE.ANOMALY_WATCH);
  if (p.autonomy_state === 'assist') return verdict(business, EXEC.EXECUTE, null, NOTE.ANOMALY_WATCH, { sampled_review: true });
  if (p.autonomy_state === 'autonomous') return verdict(business, EXEC.EXECUTE, null, NOTE.NONE);

  // Fail-safe default: anything unrecognized holds for a human.
  return verdict(business, EXEC.REVIEW, 'AUTONOMY_STATE', NOTE.DECISION_REQUIRED);
}

module.exports = { route, EXEC, NOTE };
