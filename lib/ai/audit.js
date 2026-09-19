// lib/ai/audit.js — the decision trail. When a homeowner, board, auditor, or Ed
// later asks "why did Miranda decide this?", the answer must not be an old chat
// transcript — it's this record. Critically it captures WHAT MIRANDA KNEW AT THE
// TIME: policy version, source-document versions, and model versions, because the
// declaration / guidelines / model / policy may all change later.
function buildAuditRecord({ community, subclass, task_type, policy, retrieval, primary, verifier, verdict, action_unsafe }) {
  return {
    at: new Date().toISOString(),
    community: community || null,
    task: { subclass, task_type },
    inputs: {
      // versions of the documents Miranda retrieved to decide (fill from retrieval layer)
      document_versions: (retrieval && retrieval.document_versions) || [],
      retrieval_complete: !!(retrieval && retrieval.complete),
    },
    policy: { policy_version: policy && policy.policy_version, autonomy_state: policy && policy.autonomy_state, verify_required: !!(policy && policy.verify), human_floor: !!(policy && policy.human_floor), max_execution: policy && policy.max_execution },
    primary: primary && primary.ok ? {
      provider: primary.meta && primary.meta.provider, model: primary.meta && primary.meta.model,
      structured_decision: primary.structured, gate: primary.gate, latency_ms: primary.meta && primary.meta.latency_ms,
    } : { ok: false, error: primary && primary.error },
    verifier: verifier ? {
      ran: verifier.ran, ok: verifier.ok, provider: verifier.meta && verifier.meta.provider, model: verifier.meta && verifier.meta.model,
      structured_decision: verifier.structured || null, findings: verifier.findings_text || null, reason: verifier.reason || null,
    } : null,
    gates_fired: {
      severity_worst_fail: (primary && primary.gate && primary.gate.worst_fail) || null,
      disagreement: verdict.disagreement || null,
      action_unsafe: !!action_unsafe,
    },
    outcome: {
      business_decision: verdict.business_decision,
      execution: verdict.execution,
      reason_code: verdict.reason_code,
      notification_level: verdict.notification_level,
      shadow: !!verdict.shadow,
    },
    human_override: null, // filled when a human resolves an exception (decision + rationale) -> becomes a fixture/precedent
  };
}

module.exports = { buildAuditRecord };
