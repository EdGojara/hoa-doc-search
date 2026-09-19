// lib/ai/selftest.js — proves the decision pipeline's safety invariants with
// synthetic contexts (no API calls, deterministic, CI-able). The one that
// matters: ERROR / BLOCK / REVIEW / verifier-disagreement can NEVER return
// EXECUTE. Run:  node lib/ai/selftest.js
const { route, EXEC } = require('./decide');

let failed = 0;
function assert(name, cond) { if (!cond) { failed++; console.log('  FAIL: ' + name); } else { console.log('  ok:   ' + name); } }

const basePolicy = { policy_version: 'test', autonomy_state: 'autonomous', verify: true, human_floor: false, retrieval_required: false, max_execution: 'EXECUTE' };
const cleanPrimary = () => ({ ok: true, text: 'x', structured: { business_decision: 'APPROVE', basis: 'objective' }, gate: { worst_fail: null }, meta: {} });
const cleanVerifier = () => ({ ran: true, ok: true, structured: { business_decision: 'APPROVE' } });
const ctx = (over) => Object.assign({ subclass: 't', task_type: 'acc', policy: { ...basePolicy }, retrieval: { complete: true }, primary: cleanPrimary(), verifier: cleanVerifier(), action_unsafe: false }, over || {});

console.log('\n=== lib/ai decision-pipeline selftest ===');

// The one clean path that SHOULD execute
assert('clean + autonomous + agree -> EXECUTE', route(ctx()).execution === EXEC.EXECUTE);
assert('clean + assist -> EXECUTE', route(ctx({ policy: { ...basePolicy, autonomy_state: 'assist' } })).execution === EXEC.EXECUTE);

// Every failure mode must NOT execute
const cases = {
  'model error -> ERROR': ctx({ primary: { ok: false, error: 'boom' } }),
  'empty/health -> ERROR': ctx({ primary: { ok: false, error: 'empty output' } }),
  'retrieval incomplete -> REVIEW': ctx({ policy: { ...basePolicy, retrieval_required: true }, retrieval: { complete: false } }),
  'catastrophic gate -> REVIEW': ctx({ primary: { ...cleanPrimary(), gate: { worst_fail: 'catastrophic' } } }),
  'compliance gate -> REVIEW': ctx({ primary: { ...cleanPrimary(), gate: { worst_fail: 'compliance' } } }),
  'financial gate -> REVIEW': ctx({ primary: { ...cleanPrimary(), gate: { worst_fail: 'financial' } } }),
  'subjective DENY -> ESCALATE': ctx({ primary: { ...cleanPrimary(), structured: { business_decision: 'DENY', basis: 'subjective' } } }),
  'verifier unavailable -> REVIEW (fail closed)': ctx({ verifier: { ran: true, ok: false, reason: 'down' } }),
  'verifier missing -> REVIEW (fail closed)': ctx({ verifier: null }),
  'verifier disagreement -> REVIEW': ctx({ verifier: { ran: true, ok: true, structured: { business_decision: 'DENY' } } }),
  'action unsafe -> BLOCK': ctx({ action_unsafe: true }),
  'human floor -> REVIEW': ctx({ policy: { ...basePolicy, human_floor: true } }),
  'shadow -> REVIEW (even when clean)': ctx({ policy: { ...basePolicy, autonomy_state: 'shadow' } }),
  'max_execution cap -> REVIEW': ctx({ policy: { ...basePolicy, max_execution: 'REVIEW' } }),
};

const expected = {
  'model error -> ERROR': EXEC.ERROR, 'empty/health -> ERROR': EXEC.ERROR,
  'retrieval incomplete -> REVIEW': EXEC.REVIEW, 'catastrophic gate -> REVIEW': EXEC.REVIEW,
  'compliance gate -> REVIEW': EXEC.REVIEW, 'financial gate -> REVIEW': EXEC.REVIEW,
  'subjective DENY -> ESCALATE': EXEC.REVIEW, 'verifier unavailable -> REVIEW (fail closed)': EXEC.REVIEW,
  'verifier missing -> REVIEW (fail closed)': EXEC.REVIEW, 'verifier disagreement -> REVIEW': EXEC.REVIEW,
  'action unsafe -> BLOCK': EXEC.BLOCK, 'human floor -> REVIEW': EXEC.REVIEW,
  'shadow -> REVIEW (even when clean)': EXEC.REVIEW, 'max_execution cap -> REVIEW': EXEC.REVIEW,
};

for (const [name, c] of Object.entries(cases)) {
  const v = route(c);
  assert(name + ' [' + v.execution + (v.reason_code ? '/' + v.reason_code : '') + ']', v.execution === expected[name]);
  // the invariant that guards autonomy: none of these may EXECUTE
  assert(name + ' does NOT execute', v.execution !== EXEC.EXECUTE);
}

console.log(failed ? `\nSELFTEST FAILED: ${failed} assertion(s)\n` : '\nSELFTEST PASSED: no failure mode can reach EXECUTE.\n');
process.exit(failed ? 1 : 0);
