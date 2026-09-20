// lib/ai/shadow/evidence_conflict.test.js — Phase 2 acceptance (Ed/ChatGPT
// 2026-09-19). OFFLINE (injected model/deps). Grounded in the MASONRY case:
// two contradictory statements about the stone veneer (stays vs replaced).
//
// Acceptance:
//  1) The contradiction is IDENTIFIED (not arbitrarily resolved); readiness=CONFLICT.
//  2) The gate treats it as a routine autonomous clarification: NEED_INFO /
//     EVIDENCE_CONFLICT / REQUEST_CLARIFICATION — NOT a DECISION_REQUIRED Ed exception.
//  3) A CONFLICT package never reaches ACC reasoning (no model call).
//  4) The clarification question is DETERMINISTIC (same conflict -> same ask).
//  5) BOTH answer branches resolve the conflict, version the package, and reach READY.
//  6) On resume, the objective "match existing" condition is DETERMINISTICALLY
//     attached once the model establishes stone veneer is in scope.
//   node lib/ai/shadow/evidence_conflict.test.js
const { assembleEvidencePackage, READINESS, STATE } = require('./acc_evidence');
const { detectConflicts, withConflicts, applyClarification, renderQuestion } = require('./evidence_conflict');
const { evidenceReadinessGate, EXEC, NOTE } = require('../decide');
const { enforceObjectiveConditions } = require('../objective_conditions');
const { evaluateApplication } = require('./acc_shadow');

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };

// ---- mock deps for a real assembly of the masonry package ----
const masonryTranscript = 'Exterior masonry repair. Letter A: stone veneer will remain in place as existing. Application: stone veneer will be removed and replaced; product ID outstanding.';
function mkDeps() {
  const supabase = {
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from('%PDF').buffer }, error: null }) }) },
    from: () => ({ select: () => ({ eq: () => ({ neq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }),
  };
  const anthropic = { messages: { create: async () => ({ content: [{ type: 'text', text: masonryTranscript }] }) } };
  const getRelevantChunks = async () => 'Waterview Design Guidelines 3.9.1: exterior materials in natural state; color harmony.';
  return { supabase, getRelevantChunks, anthropic };
}
const masonryRow = { id: 'masonry-1', community_name: 'Waterview Estates', homeowner_address: '5406 Jay Thrush Dr', project_summary: 'Exterior masonry repair; brick, flashing, stone veneer.', application_pdf_storage_path: 'acc/masonry/app.pdf' };

// injected conflict detector: returns the stone-veneer contradiction
const conflictJSON = JSON.stringify({ conflicts: [{ topic: 'stone_veneer_scope', topic_label: 'the existing stone veneer', assertion_a: { source: 'Approval Letter A', claim: 'the stone veneer will remain in place as existing' }, assertion_b: { source: 'Application', claim: 'the stone veneer will be removed and replaced' }, resolvable_by: 'homeowner_clarification' }] });
const detectorCaller = async () => ({ ok: true, text: conflictJSON, provider: 'x', model: 'y' });
const noConflictCaller = async () => ({ ok: true, text: '{"conflicts":[]}', provider: 'x', model: 'y' });
// reproduces the LIVE over-split: the model returns TWO near-duplicate conflicts
// about the SAME stone-veneer fact with different topic keys.
const splitConflictJSON = JSON.stringify({ conflicts: [
  { topic: 'stone_veneer_replacement_scope', topic_label: 'whether stone veneer is being replaced or remaining', assertion_a: { source: 'Letter A', claim: 'stone veneer no longer being replaced' }, assertion_b: { source: 'Application', claim: 'application described replacing the stone veneer with matching material; product ID requested' }, resolvable_by: 'homeowner_clarification' },
  { topic: 'stone_veneer_treatment_requirement', topic_label: 'stone veneer treatment', assertion_a: { source: 'Letter A', claim: 'stone veneer remains in place as existing' }, assertion_b: { source: 'Application', claim: 'stone veneer to be replaced; specific product identification not yet provided' }, resolvable_by: 'homeowner_clarification' },
] });
const splitDetectorCaller = async () => ({ ok: true, text: splitConflictJSON, provider: 'x', model: 'y' });

// injected ACC model for the resume step: a stone-veneer item APPROVED with no condition
const accJSON = JSON.stringify({ decision: 'APPROVE', items: [{ type: 'Stone Veneer Repair', disposition: 'APPROVE', requirements: [{ rule: 'exterior materials', rule_type: 'SUBJECTIVE', resolved_from: 'evidence', complies: true }] }], variance_required: false });
const accCaller = async () => ({ ok: true, text: accJSON, usage: { input: 1, output: 1 }, provider: 'x', model: 'y', latency_ms: 1 });

(async () => {
  console.log('\n=== evidence-conflict Phase 2 (masonry regression) ===');

  // --- objective-condition enforcer (unit) ---
  {
    const s = { decision: 'APPROVE', items: [{ type: 'Stone Veneer Repair', disposition: 'APPROVE', requirements: [] }] };
    const { enforced } = enforceObjectiveConditions(s, 'Waterview Estates');
    assert('enforcer adds the stone-veneer match-existing condition', enforced.length === 1 && enforced[0].requirement_id === 'WVE-STONE-VENEER-MATCH');
    assert('enforcer upgrades APPROVE -> APPROVE_WITH_CONDITIONS', s.items[0].disposition === 'APPROVE_WITH_CONDITIONS' && s.decision === 'APPROVE_WITH_CONDITIONS');
    assert('enforced condition carries a governing-doc source', /3\.9\.1/.test(s.items[0].requirements[0].source_document || ''));
    const again = enforceObjectiveConditions(s, 'Waterview Estates');
    assert('enforcer is idempotent (no duplicate condition)', again.enforced.length === 0);
    const other = { decision: 'APPROVE', items: [{ type: 'Stone Veneer Repair', disposition: 'APPROVE', requirements: [] }] };
    assert('enforcer is community-scoped (no rule for another HOA)', enforceObjectiveConditions(other, 'Some Other HOA').enforced.length === 0);
    const nonmatch = { decision: 'APPROVE', items: [{ type: 'Exterior Paint', disposition: 'APPROVE', requirements: [] }] };
    assert('enforcer does not fire on a non-matching item type', enforceObjectiveConditions(nonmatch, 'Waterview Estates').enforced.length === 0);
  }

  // --- assemble a real (READY) masonry package, then detect the conflict ---
  const pkg = await assembleEvidencePackage(masonryRow, mkDeps(), { attempts: 3 });
  assert('base package is READY before conflict detection', pkg.readiness === READINESS.READY);

  const det = await detectConflicts(pkg, { callModel: detectorCaller });
  assert('conflict detected (exactly one)', det.ok && det.conflicts.length === 1);
  assert('conflict topic identified', det.conflicts[0].topic === 'stone_veneer_scope');

  // determinism of the ask
  const q1 = renderQuestion({ topic_label: 'the existing stone veneer', assertion_a: { claim: 'stays' }, assertion_b: { claim: 'replaced' } });
  const q2 = renderQuestion({ topic_label: 'the existing stone veneer', assertion_a: { claim: 'stays' }, assertion_b: { claim: 'replaced' } });
  assert('clarification question is deterministic (same conflict -> same ask)', q1 === q2 && det.conflicts[0].question === det.conflicts[0].question);

  // no-conflict detector -> nothing changes
  const none = await detectConflicts(pkg, { callModel: noConflictCaller });
  assert('no false conflict on a clean read', none.ok && none.conflicts.length === 0 && withConflicts(pkg, none.conflicts) === pkg);

  // LIVE-CAUGHT REGRESSION: model over-splits one fact into two conflicts ->
  // canonicalized to ONE, so there is one clarification and resume reaches READY.
  {
    const split = await detectConflicts(pkg, { callModel: splitDetectorCaller });
    assert('over-split (2 raw) collapses to ONE canonical conflict', split.ok && split.conflicts.length === 1);
    const cpkg = withConflicts(pkg, split.conflicts);
    const resolved = applyClarification(cpkg, { topic: split.conflicts[0].topic, answer: 'The existing stone veneer will remain in place.' });
    assert('resolving the one canonical conflict -> readiness READY (no phantom twin left open)', resolved.readiness === READINESS.READY && !resolved.conflicts.some((c) => c.status === 'OPEN'));
  }

  // --- CONFLICT package + gate semantics ---
  const pkgC = withConflicts(pkg, det.conflicts);
  assert('withConflicts -> readiness CONFLICT, frozen', pkgC.readiness === READINESS.CONFLICT && Object.isFrozen(pkgC));
  const gate = evidenceReadinessGate(pkgC, { comms_enabled: false, autonomy_state: 'shadow' });
  assert('gate: business NEED_INFO', gate.business_decision === 'NEED_INFO');
  assert('gate: reason EVIDENCE_CONFLICT', gate.reason_code === 'EVIDENCE_CONFLICT');
  assert('gate: action REQUEST_CLARIFICATION', gate.action === 'REQUEST_CLARIFICATION');
  assert('gate: NOT a DECISION_REQUIRED Ed exception', gate.notification_level !== NOTE.DECISION_REQUIRED);
  const gateLive = evidenceReadinessGate(pkgC, { comms_enabled: true, autonomy_state: 'assist' });
  assert('gate: EXECUTE (send clarification) when comms enabled + autonomy permits', gateLive.execution === EXEC.EXECUTE);

  // conflict package must NEVER reach reasoning
  {
    let called = false;
    const rec = await evaluateApplication({ evidencePackage: pkgC, community_name: 'Waterview Estates', human_decision_type: 'approved_with_conditions' }, { callModel: async () => { called = true; return { ok: true, text: accJSON }; } });
    assert('CONFLICT package: no model call reached', called === false);
    assert('CONFLICT package: rec reason EVIDENCE_CONFLICT, gated', rec.reason_code === 'EVIDENCE_CONFLICT' && rec.gated_before_reasoning === true);
  }

  // --- BOTH clarification branches resolve + version + reach READY ---
  for (const [label, answer] of [['stays', 'The existing stone veneer will remain in place as-is.'], ['replaced', 'The stone veneer will be removed and replaced with matching material.']]) {
    const resolved = applyClarification(pkgC, { topic: 'stone_veneer_scope', answer });
    assert(`branch[${label}]: conflict RESOLVED`, resolved.conflicts[0].status === 'RESOLVED');
    assert(`branch[${label}]: package versioned (v2) with new hash`, resolved.version === 2 && resolved.content_hash !== pkgC.content_hash);
    assert(`branch[${label}]: readiness back to READY`, resolved.readiness === READINESS.READY);
    assert(`branch[${label}]: homeowner answer is now evidence`, resolved.manifest.some((m) => m.source === 'homeowner_clarification' && m.state === STATE.PRESENT_READABLE) && resolved.bundle_text.includes(answer));

    // resume: reasoning runs, and the objective condition is deterministically attached
    const rec = await evaluateApplication({ evidencePackage: resolved, community_name: 'Waterview Estates', human_decision_type: 'approved_with_conditions' }, { callModel: accCaller });
    assert(`branch[${label}]: resumes to reasoning (not gated)`, !rec.gated_before_reasoning && rec.shadow_status === 'ok');
    assert(`branch[${label}]: objective condition enforced on resume`, (rec.objective_conditions_enforced || []).some((e) => e.requirement_id === 'WVE-STONE-VENEER-MATCH'));
    const stone = (rec.primary_structured.items || []).find((i) => /stone/i.test(i.type));
    assert(`branch[${label}]: stone item now APPROVE_WITH_CONDITIONS with the match-existing condition`, stone && stone.disposition === 'APPROVE_WITH_CONDITIONS' && (stone.requirements || []).some((r) => /match|substitution/i.test(r.condition || '')));
  }

  console.log(failed ? `\nEVIDENCE CONFLICT PHASE 2 FAILED: ${failed}\n` : '\nEVIDENCE CONFLICT PHASE 2 PASSED.\n');
  process.exit(failed ? 1 : 0);
})();
