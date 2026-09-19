// lib/ai/shadow/acc_shadow.js — SHADOW ACC evaluation. Produces what Miranda
// WOULD decide, for comparison against the human outcome. It is architecturally
// incapable of acting: it imports ONLY the router (model_client, tiers, policy,
// decide, audit, tasks/acc) — no email sender, no letter renderer, no status
// mutation, no homeowner comms. And it NEVER throws: any failure returns
// shadow_status:'error', so a shadow problem can't disrupt anything upstream.
// (Ed/ChatGPT 2026-09-19.)
const { tier, verifierFor } = require('../tiers');
const { policyFor } = require('../policy');
const { route } = require('../decide');
const { buildAuditRecord } = require('../audit');
const acc = require('../tasks/acc');
const defaultCall = require('../model_client').callModel;

// Miranda's structured decision -> a value comparable to acc_decisions.decision_type
function toHumanComparable(struct) {
  if (!struct) return null;
  const d = struct.decision;
  if (d === 'DENY') return 'denied';
  if (d === 'NEED_INFO') return 'request_more_info';
  if (d === 'ESCALATE') return null;
  if (d === 'APPROVE') {
    const conditioned = (struct.items || []).some((i) => i.disposition && i.disposition !== 'APPROVE') || struct.variance_required;
    return conditioned ? 'approved_with_conditions' : 'approved_no_conditions';
  }
  return null;
}
function norm(humanType) {
  if (!humanType) return null;
  if (/approv/i.test(humanType)) return 'APPROVE';
  if (/den/i.test(humanType)) return 'DENY';
  if (/info|incomplete/i.test(humanType)) return 'INFO';
  return null;
}

// opts: { applicationAndGuidelines, retrieval_complete, community_id,
//         community_name, source_acc_decision_id, human_decision_type }
// deps: { callModel } (injectable for tests)
async function evaluateApplication(opts, deps) {
  const callModel = (deps && deps.callModel) || defaultCall;
  const rec = {
    source_acc_decision_id: opts.source_acc_decision_id || null,
    community_id: opts.community_id || null,
    community_name: opts.community_name || null,
    human_decision_type: opts.human_decision_type || null,
    policy_version: null, shadow_status: 'ok', error: null,
  };
  try {
    const policy = policyFor('acc.review.general');
    rec.policy_version = policy.policy_version;
    const t = tier(policy.default_tier);
    const prompt = acc.buildPrompt(opts.applicationAndGuidelines || '');

    const p = await callModel({ provider: t.provider, model: t.model, price: t, system: 'You are the ACC review function. Return ONLY the JSON contract.', prompt, maxTokens: 2600, kind: 'shadow_primary' });
    if (!p.ok) { rec.shadow_status = 'error'; rec.error = 'primary: ' + p.error; return rec; }
    const pp = acc.parse(p.text);
    if (!pp.ok) { rec.shadow_status = 'error'; rec.error = 'primary parse: ' + pp.error; return rec; }
    const { struct: pStruct, overrides } = acc.applyDeterministicChecks(pp.value);
    const a = acc.assess(pStruct);
    rec.primary_provider = p.provider; rec.primary_model = p.model;
    rec.primary_decision = pStruct.decision; rec.primary_structured = pStruct;
    rec.deterministic_overrides = overrides; rec.severity = a.severity; rec.evidence_incomplete = a.evidence_incomplete;

    // cross-provider verifier, same contract
    let verifier = null, vStruct = null;
    const vcfg = verifierFor(t.provider);
    if (vcfg) {
      const v = await callModel({ provider: vcfg.provider, model: vcfg.model, price: vcfg, system: 'You are an independent ACC reviewer from a different provider. Return ONLY the JSON contract.', prompt, maxTokens: 2600, kind: 'shadow_verify' });
      if (v.ok) {
        const vp = acc.parse(v.text);
        if (vp.ok) {
          vStruct = acc.applyDeterministicChecks(vp.value).struct;
          rec.verifier_provider = v.provider; rec.verifier_model = v.model;
          rec.verifier_decision = vStruct.decision; rec.verifier_structured = vStruct;
          const ag = acc.agree(pStruct, vStruct);
          rec.agreement = ag.agree; rec.agreement_reasons = ag.reasons;
          verifier = { ran: true, ok: true, structured: { business_decision: vStruct.decision }, meta: { provider: v.provider, model: v.model } };
        } else { verifier = { ran: true, ok: false, reason: 'verifier parse: ' + vp.error }; }
      } else { verifier = { ran: true, ok: false, reason: v.error }; }
    }

    const verdict = route({
      subclass: 'acc.review.general', task_type: 'acc', policy,
      retrieval: { complete: opts.retrieval_complete !== false, document_versions: opts.document_versions || [] },
      primary: { ok: true, text: p.text, structured: { business_decision: pStruct.decision, basis: a.evidence_incomplete ? 'subjective' : 'objective' }, gate: { worst_fail: a.severity }, meta: { provider: p.provider, model: p.model, latency_ms: p.latency_ms } },
      verifier, evidence_incomplete: a.evidence_incomplete, action_unsafe: false,
    });
    rec.business_decision = verdict.business_decision; rec.execution = verdict.execution;
    rec.reason_code = verdict.reason_code; rec.notification_level = verdict.notification_level;

    // comparison to the human outcome
    const mirandaHuman = toHumanComparable(pStruct);
    const mn = norm(mirandaHuman), hn = norm(opts.human_decision_type);
    rec.overall_match = (mn && hn) ? (mn === hn) : null;
    rec.item_match = { miranda_items: (pStruct.items || []).map((i) => ({ type: i.type, disposition: i.disposition })) }; // human per-item unavailable historically
    rec.requirement_match = null;

    rec.audit = buildAuditRecord({
      community: opts.community_name, subclass: 'acc.review.general', task_type: 'acc', policy,
      retrieval: { complete: opts.retrieval_complete !== false, document_versions: opts.document_versions || [] },
      primary: { ok: true, structured: pStruct, gate: { worst_fail: a.severity }, meta: { provider: p.provider, model: p.model, latency_ms: p.latency_ms } },
      verifier: verifier && verifier.ok ? { ran: true, ok: true, structured: vStruct, meta: verifier.meta } : verifier,
      verdict,
    });
    return rec;
  } catch (e) {
    // Hard isolation: nothing in shadow may propagate a failure upstream.
    rec.shadow_status = 'error'; rec.error = 'exception: ' + (e && e.message ? e.message : String(e));
    return rec;
  }
}

module.exports = { evaluateApplication, toHumanComparable };
