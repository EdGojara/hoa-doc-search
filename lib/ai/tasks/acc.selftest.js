// lib/ai/tasks/acc.selftest.js — proves the corrected ACC gate semantics AND the
// evidence-completeness rule with synthetic structured decisions (no API).
// Crux 1 (gate): GATE_CATASTROPHIC == "APPROVE despite a hard violation", NOT
//   "a hard violation exists." A correct DENY of a noncompliant item is right.
// Crux 2 (evidence): a model may not claim compliance without the evidence its
//   rule_type requires; an APPROVE resting on missing evidence -> EVIDENCE_INCOMPLETE.
//   node lib/ai/tasks/acc.selftest.js
const acc = require('./acc');
const { route, EXEC } = require('../decide');
const { policyFor } = require('../policy');

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };

const shedReq = (complies, extra) => Object.assign({ rule: 'Section 7.4', source_document: 'ACC Guidelines', requirement: 'min 5ft rear setback', rule_type: 'NUMERIC', submitted_value: '3 feet', submitted_value_num: 3, threshold_num: 5, operator: '>=', complies }, extra || {});

const correctDeny = { decision: 'DENY', items: [{ type: 'shed', disposition: 'DENY', requirements: [shedReq(false)] }], variance_required: false };
const dangerousApprove = { decision: 'APPROVE', items: [{ type: 'shed', disposition: 'APPROVE', requirements: [shedReq(false)] }], variance_required: false };
const modelLies = { decision: 'APPROVE', items: [{ type: 'shed', disposition: 'APPROVE', requirements: [shedReq(true)] }], variance_required: false }; // says complies:true though 3<5
// APPROVE resting on a NUMERIC requirement with the numbers withheld -> not evaluable
const evidenceMissing = { decision: 'APPROVE', items: [{ type: 'shed', disposition: 'APPROVE', requirements: [{ rule: 'Section 7.4', requirement: 'min 5ft setback', rule_type: 'NUMERIC', submitted_value: 'not stated', submitted_value_num: null, threshold_num: null, operator: null, complies: true }] }], variance_required: false };
// APPROVE resting on a subjective standard the model self-approved
const subjectiveApprove = { decision: 'APPROVE', items: [{ type: 'paint', disposition: 'APPROVE', requirements: [{ rule: 'Section 8.3', requirement: 'consistent with the neighborhood', rule_type: 'SUBJECTIVE', submitted_value: 'Iron Ore', complies: true }] }], subjective_judgments: ['color harmony'], variance_required: false };

console.log('\n=== ACC structured-contract selftest ===');

assert('correct DENY of a violation -> severity null', acc.severity(correctDeny) === null);
assert('APPROVE of a violation -> catastrophic', acc.severity(dangerousApprove) === 'catastrophic');

const fixed = acc.applyDeterministicChecks(JSON.parse(JSON.stringify(modelLies)));
assert('deterministic check overrides model (3>=5 is false)', fixed.overrides.length === 1 && fixed.overrides[0].computed === false);
assert('after override, APPROVE-over-violation -> catastrophic', acc.severity(fixed.struct) === 'catastrophic');

// evidence completeness
assert('NUMERIC without numbers is not evidenceOk', acc.evidenceOk({ rule_type: 'NUMERIC', submitted_value_num: null }) === false);
assert('APPROVE on missing-evidence NUMERIC -> evidence_incomplete', acc.assess(evidenceMissing).evidence_incomplete === true);
assert('APPROVE on missing-evidence NUMERIC -> NOT catastrophic (can\'t confirm a violation either)', acc.assess(evidenceMissing).severity === null);
assert('self-approved SUBJECTIVE standard -> evidence_incomplete', acc.assess(subjectiveApprove).evidence_incomplete === true);

// agreement
assert('primary DENY vs verifier APPROVE on shed -> disagree', acc.agree(correctDeny, dangerousApprove).agree === false);
assert('two matching correct DENYs -> agree', acc.agree(correctDeny, JSON.parse(JSON.stringify(correctDeny))).agree === true);

// end-to-end through route()
const policy = policyFor('acc.review.general');
const ctxFor = (struct, verifierStruct) => {
  const a = acc.assess(struct);
  return {
    subclass: 'acc.review.general', task_type: 'acc', policy, retrieval: { complete: true },
    primary: { ok: true, text: '', structured: { business_decision: struct.decision, basis: 'objective' }, gate: { worst_fail: a.severity }, meta: {} },
    verifier: { ran: true, ok: true, structured: { business_decision: (verifierStruct || struct).decision } },
    evidence_incomplete: a.evidence_incomplete, action_unsafe: false,
  };
};
assert('route(correct DENY) is NOT GATE_CATASTROPHIC', route(ctxFor(correctDeny)).reason_code !== 'GATE_CATASTROPHIC');
assert('route(correct DENY) holds at shadow REVIEW', route(ctxFor(correctDeny)).reason_code === 'AUTONOMY_STATE');
assert('route(APPROVE-over-violation) IS GATE_CATASTROPHIC', route(ctxFor(dangerousApprove, dangerousApprove)).reason_code === 'GATE_CATASTROPHIC');
assert('route(evidence-missing APPROVE) -> EVIDENCE_INCOMPLETE', route(ctxFor(evidenceMissing, evidenceMissing)).reason_code === 'EVIDENCE_INCOMPLETE');
assert('none of the bad ACC cases EXECUTE', [correctDeny, dangerousApprove, evidenceMissing, subjectiveApprove].every((s) => route(ctxFor(s, s)).execution !== EXEC.EXECUTE));

console.log(failed ? `\nACC SELFTEST FAILED: ${failed}\n` : '\nACC SELFTEST PASSED.\n');
process.exit(failed ? 1 : 0);
