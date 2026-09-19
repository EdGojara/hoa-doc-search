// lib/ai/tasks/acc.fixtures.test.js — executable regression over the SIX
// adjudicated ACC cases (Ed/ChatGPT 2026-09-19). Deterministic, NO API calls:
// each fixture's canonical `structured` contract is run through the live
// framework and the invariants we adjudicated are asserted. This locks in
// "everything we learned" so a future prompt/framework change can't silently
// regress it. Model behavior is checked separately (livecheck); this file
// checks the FRAMEWORK's treatment of a correct decision.
//   node lib/ai/tasks/acc.fixtures.test.js
const fs = require('fs');
const path = require('path');
const acc = require('./acc');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'acc.fixtures.json'), 'utf8')).fixtures;

let failed = 0;
const assert = (n, c) => { if (!c) { failed++; console.log('  FAIL: ' + n); } else console.log('  ok:   ' + n); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const hasCuringCondition = (s) => (s.items || []).some((i) => (i.requirements || []).some((r) => r.condition && String(r.condition).trim().length > 0));

console.log('\n=== ACC adjudicated-fixtures regression (' + fixtures.length + ' cases) ===');

for (const fx of fixtures) {
  console.log('\n[' + fx.id + '] ' + fx.project);
  if (!fx.structured) { assert('has a `structured` contract to test', false); continue; }
  const exp = fx.expected;
  // deterministic numeric checks first (as the live path does), so any NUMERIC
  // rule is verified in code, not taken on the model's word.
  const { struct, overrides } = acc.applyDeterministicChecks(clone(fx.structured));

  assert('deterministic checks find no miscalled numbers', overrides.length === 0);
  assert('decision == adjudicated substantive_decision (' + exp.substantive_decision + ')', struct.decision === exp.substantive_decision);
  assert('administrative_status == adjudicated (' + exp.administrative_status + ')', acc.administrativeStatus(struct) === exp.administrative_status);

  // THE safety invariant: no adjudicated-correct outcome lets an uncured
  // objective violation stand.
  assert('severity is null (no uncured objective violation)', acc.severity(struct) === null);

  // V2 thesis: all six were RESOLVABLE — none should read as an unconfirmable approval.
  assert('assess.evidence_incomplete === false (resolvable)', acc.assess(struct).evidence_incomplete === false);

  // conditional approvals must actually carry a curing condition
  if (struct.decision === 'APPROVE_WITH_CONDITIONS') {
    assert('APPROVE_WITH_CONDITIONS carries at least one curing condition', hasCuringCondition(struct));
  }

  // administrative isolation: an administrative gap never forces a hold/denial
  if (exp.administrative_status !== 'COMPLETE') {
    assert('administrative gap did NOT push decision to ESCALATE/NEED_INFO/DENY', !['ESCALATE', 'NEED_INFO', 'DENY'].includes(struct.decision));
  }

  // self-consistency of the comparator on an identical pair
  assert('agree(struct, struct) is true', acc.agree(struct, clone(struct)).agree === true);
}

// --- The administrative-isolation proof (the whole point of administrative_status) ---
// The unsigned-application fixture is safe ONLY because the signature requirement
// is flagged administrative. Strip that flag and the SAME structure must flip to
// catastrophic — proving the flag (not luck) is what isolates admin from substantive.
console.log('\n[administrative isolation proof]');
const oak = fixtures.find((f) => f.id === 'oaktree-resod-UNSIGNED');
if (oak && oak.structured) {
  const withFlag = acc.applyDeterministicChecks(clone(oak.structured)).struct;
  assert('unsigned app WITH administrative flag -> severity null (safe)', acc.severity(withFlag) === null);
  const stripped = clone(oak.structured);
  for (const i of stripped.items) for (const r of (i.requirements || [])) delete r.administrative;
  assert('same app WITHOUT the flag -> catastrophic (proves the flag is what isolates admin)', acc.severity(acc.applyDeterministicChecks(stripped).struct) === 'catastrophic');
} else { assert('found the unsigned-application fixture', false); }

console.log(failed ? `\nACC FIXTURES REGRESSION FAILED: ${failed}\n` : `\nACC FIXTURES REGRESSION PASSED: all ${fixtures.length} adjudicated cases hold.\n`);
process.exit(failed ? 1 : 0);
