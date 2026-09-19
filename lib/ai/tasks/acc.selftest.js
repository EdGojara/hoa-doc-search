// lib/ai/tasks/acc.selftest.js — proves the corrected ACC gate semantics with
// synthetic structured decisions (no API). The crux (ChatGPT/Ed 2026-09-19):
// GATE_CATASTROPHIC must mean "APPROVE despite a hard violation", NOT "a hard
// violation exists." A correct DENY of a noncompliant item is right, not catastrophic.
//   node lib/ai/tasks/acc.selftest.js
const acc = require('./acc');
const { route, EXEC } = require('../decide');
const { policyFor } = require('../policy');

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };

const shedReq = (complies) => ({ rule: 'Section 7.4', source_document: 'ACC Guidelines', requirement: 'min 5ft rear setback', submitted_value: '3 feet', submitted_value_num: 3, threshold_num: 5, operator: '>=', complies });

const correctDeny = { decision: 'DENY', items: [{ type: 'shed', disposition: 'DENY', requirements: [shedReq(false)] }], variance_required: false };
const dangerousApprove = { decision: 'APPROVE', items: [{ type: 'shed', disposition: 'APPROVE', requirements: [shedReq(false)] }], variance_required: false };
const modelLies = { decision: 'APPROVE', items: [{ type: 'shed', disposition: 'APPROVE', requirements: [shedReq(true)] }], variance_required: false }; // says complies:true though 3<5

console.log('\n=== ACC structured-contract selftest ===');

// severity keys on action/error, not on the violation existing
assert('correct DENY of a violation -> severity null (not catastrophic)', acc.severity(correctDeny) === null);
assert('APPROVE of a violation -> catastrophic', acc.severity(dangerousApprove) === 'catastrophic');

// deterministic code overrides a model that miscalls a numeric rule
const fixed = acc.applyDeterministicChecks(JSON.parse(JSON.stringify(modelLies)));
assert('deterministic check overrides model (3>=5 is false)', fixed.overrides.length === 1 && fixed.overrides[0].computed === false);
assert('after override, APPROVE-over-violation -> catastrophic', acc.severity(fixed.struct) === 'catastrophic');

// structured agreement, field-by-field
assert('primary DENY vs verifier APPROVE on shed -> disagree', acc.agree(correctDeny, dangerousApprove).agree === false);
assert('two matching correct DENYs -> agree', acc.agree(correctDeny, JSON.parse(JSON.stringify(correctDeny))).agree === true);

// end-to-end through route(): the correct DENY must NOT become GATE_CATASTROPHIC
const policy = policyFor('acc.review.general');
const ctxFor = (struct, verifierStruct) => ({
  subclass: 'acc.review.general', task_type: 'acc', policy,
  retrieval: { complete: true },
  primary: { ok: true, text: '', structured: { business_decision: struct.decision, basis: 'objective' }, gate: { worst_fail: acc.severity(struct) }, meta: {} },
  verifier: { ran: true, ok: true, structured: { business_decision: (verifierStruct || struct).decision } },
  action_unsafe: false,
});
const rDeny = route(ctxFor(correctDeny));
assert('route(correct DENY) is NOT GATE_CATASTROPHIC', rDeny.reason_code !== 'GATE_CATASTROPHIC');
assert('route(correct DENY) holds at shadow REVIEW (AUTONOMY_STATE)', rDeny.execution === EXEC.REVIEW && rDeny.reason_code === 'AUTONOMY_STATE');
const rApprove = route(ctxFor(dangerousApprove, dangerousApprove));
assert('route(APPROVE-over-violation) IS GATE_CATASTROPHIC', rApprove.reason_code === 'GATE_CATASTROPHIC');
assert('route(APPROVE-over-violation) does NOT execute', rApprove.execution !== EXEC.EXECUTE);

console.log(failed ? `\nACC SELFTEST FAILED: ${failed}\n` : '\nACC SELFTEST PASSED: catastrophic == approve-over-violation, not the violation itself.\n');
process.exit(failed ? 1 : 0);
