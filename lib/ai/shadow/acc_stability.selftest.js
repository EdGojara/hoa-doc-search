// lib/ai/shadow/acc_stability.selftest.js — proves the stability classifier
// distinguishes the cases that matter, OFFLINE with synthetic runs (no API).
// The crux (GPT 2026-09-19): a steady Miranda with a flapping verifier is the
// VERIFIER's operational instability, NOT Miranda's — and harmless generative
// wording variation must never be mislabeled as decision instability.
//   node lib/ai/shadow/acc_stability.selftest.js
const { summarizeRuns, extractRun } = require('./acc_stability');

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };

// build a synthetic shadow rec
const rec = (o) => ({
  shadow_status: 'ok',
  primary_decision: o.p, verifier_decision: o.v, business_decision: o.b, reason_code: o.rc || null,
  execution: o.exec || 'REVIEW', severity: o.sev || null,
  administrative_status: o.admin || 'COMPLETE',
  primary_structured: { items: [{ type: 'pergola', disposition: o.disp || 'APPROVE_WITH_CONDITIONS', requirements: [
    { rule: 'metal must be painted', rule_type: 'SUBJECTIVE', condition: o.cond || 'paint the frame an approved color', complies: false },
    { rule: 'max height 12ft', rule_type: 'NUMERIC', complies: true },
  ] }] },
});
const runN = (n, o) => Array.from({ length: n }, () => extractRun(rec(o)));

console.log('\n=== ACC stability classifier selftest ===');

// 1) fully stable — identical everything
assert('identical runs -> FULLY_STABLE',
  summarizeRuns(runN(5, { p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })).classification === 'FULLY_STABLE');

// 2) generative variation — same decisions, only condition wording differs
(() => {
  const runs = [
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS', cond: 'paint the frame an approved color' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS', cond: 'the metal frame must be painted an HOA-approved color' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS', cond: 'frame painted, approved palette' })),
  ];
  const s = summarizeRuns(runs);
  assert('same decisions + different condition wording -> GENERATIVE_VARIATION_ONLY (harmless)', s.classification === 'GENERATIVE_VARIATION_ONLY' && s.kind === 'harmless');
})();

// 3) THE crux — Miranda steady 5/5, verifier flip-flops, routing flaps to ESCALATE
(() => {
  const runs = [
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'DENY', b: 'ESCALATE', rc: 'VERIFY_DISAGREEMENT' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'DENY', b: 'ESCALATE', rc: 'VERIFY_DISAGREEMENT' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })),
  ];
  const s = summarizeRuns(runs);
  assert('Miranda steady + verifier flapping -> OPERATIONAL_INSTABILITY_FROM_VERIFIER', s.classification === 'OPERATIONAL_INSTABILITY_FROM_VERIFIER');
  assert('  ...and Miranda is reported STABLE (5/5)', s.primary.stable === true && s.primary.stability === 1);
  assert('  ...and the verifier is reported UNSTABLE', s.verifier.stable === false);
  assert('  ...classified must_fix', s.kind === 'must_fix');
})();

// 3b) THE smoke finding — stable headline, but the safety gate flips
// GATE_CATASTROPHIC on some identical runs and not others.
(() => {
  const runs = [
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS', rc: 'EVIDENCE_INCOMPLETE', sev: null })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS', rc: 'GATE_CATASTROPHIC', exec: 'BLOCK', sev: 'catastrophic' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS', rc: 'EVIDENCE_INCOMPLETE', sev: null })),
  ];
  const s = summarizeRuns(runs);
  assert('stable headline but gate fires catastrophic on some runs -> GATE_SEVERITY_INSTABILITY (must_fix)', s.classification === 'GATE_SEVERITY_INSTABILITY' && s.kind === 'must_fix');
  assert('  ...intermittent_catastrophic flagged', s.intermittent_catastrophic === true);
  assert('  ...Miranda top-line still reported stable', s.primary.stable === true);
})();

// 4) Miranda herself unstable — the serious one
(() => {
  const runs = [
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })),
    extractRun(rec({ p: 'DENY', v: 'APPROVE_WITH_CONDITIONS', b: 'ESCALATE', rc: 'VERIFY_DISAGREEMENT' })),
    extractRun(rec({ p: 'ESCALATE', v: 'APPROVE_WITH_CONDITIONS', b: 'ESCALATE' })),
  ];
  const s = summarizeRuns(runs);
  assert('Miranda decision swings -> DECISION_INSTABILITY_PRIMARY (must_fix)', s.classification === 'DECISION_INSTABILITY_PRIMARY' && s.kind === 'must_fix');
})();

// 5) consistent cross-provider disagreement — both stable, always ESCALATE
(() => {
  const runs = runN(5, { p: 'APPROVE_WITH_CONDITIONS', v: 'DENY', b: 'ESCALATE', rc: 'VERIFY_DISAGREEMENT' });
  const s = summarizeRuns(runs);
  assert('both stable but always disagree -> not instability; flagged consistent_cross_provider_disagreement',
    s.consistent_cross_provider_disagreement === true && s.classification !== 'OPERATIONAL_INSTABILITY_FROM_VERIFIER');
})();

// 6) verifier varies but routing absorbs it (no operational impact yet)
(() => {
  const runs = [
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE', b: 'APPROVE_WITH_CONDITIONS' })),
    extractRun(rec({ p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' })),
  ];
  const s = summarizeRuns(runs);
  assert('verifier varies, routing steady -> VERIFIER_VARIES_ROUTING_ABSORBS (watch)', s.classification === 'VERIFIER_VARIES_ROUTING_ABSORBS' && s.kind === 'watch');
})();

// 7) expected-match passthrough
(() => {
  const s = summarizeRuns(runN(4, { p: 'APPROVE_WITH_CONDITIONS', v: 'APPROVE_WITH_CONDITIONS', b: 'APPROVE_WITH_CONDITIONS' }), { substantive_decision: 'APPROVE_WITH_CONDITIONS' });
  assert('expected-decision match recorded', s.primary_matches_expected === true);
})();

console.log(failed ? `\nACC STABILITY SELFTEST FAILED: ${failed}\n` : '\nACC STABILITY SELFTEST PASSED.\n');
process.exit(failed ? 1 : 0);
