// =============================================================================
// tests/test_amanda_disposition.js — routine vs exception
// =============================================================================
//
// The primitive that lets the gate move from "review every draft" to "review
// the exceptions." Amanda classifies her own work: auto_ok is routine, grounded,
// in-bounds, verified-sender work a supervisor would wave through; needs_review
// means a human must look, and the reason says why. This is the operator model
// in one function — the system handles the routine, humans supervise exceptions.
//
// It does NOT auto-send anything (the manual hold stands). But it is the exact
// gate a future auto-send must check, so its conservatism is a safety property:
// anything uncertain, ungrounded, reserved, charged, or from an unverified
// sender must land in needs_review, never auto_ok.
//
// Run: node tests/test_amanda_disposition.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { classifyDisposition } = require('../lib/community/amanda_reply');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

console.log('\nAmanda — exception router (disposition)\n');

check('routine grounded verified-sender answer is auto_ok / high', () => {
  const d = classifyDisposition({ gateAllowed: true, grounded: true, escalationReasons: [], audience: 'homeowner' });
  assert.strictEqual(d.disposition, 'auto_ok');
  assert.strictEqual(d.confidence, 'high');
});

check('a reserved-decision ask is always needs_review / low', () => {
  const d = classifyDisposition({ gateAllowed: false, grounded: true, escalationReasons: [], audience: 'homeowner' });
  assert.strictEqual(d.disposition, 'needs_review');
  assert.strictEqual(d.confidence, 'low');
  assert.ok(/reserved/.test(d.reason));
});

check('an ungrounded (fallback) answer is needs_review / low', () => {
  const d = classifyDisposition({ gateAllowed: true, grounded: false, escalationReasons: [], audience: 'homeowner' });
  assert.strictEqual(d.disposition, 'needs_review');
  assert.strictEqual(d.confidence, 'low');
});

check('a charged / hardship thread is needs_review (grounded but flagged)', () => {
  const d = classifyDisposition({ gateAllowed: true, grounded: true, escalationReasons: ['hardship'], audience: 'homeowner' });
  assert.strictEqual(d.disposition, 'needs_review');
  assert.strictEqual(d.confidence, 'medium');
  assert.ok(/hardship/.test(d.reason));
});

check('an unverified sender is never auto_ok', () => {
  const d = classifyDisposition({ gateAllowed: true, grounded: true, escalationReasons: [], audience: 'other' });
  assert.strictEqual(d.disposition, 'needs_review');
  assert.ok(/not verified/.test(d.reason));
});

check('board and vendor routine answers can be auto_ok', () => {
  for (const audience of ['board', 'vendor', 'staff']) {
    const d = classifyDisposition({ gateAllowed: true, grounded: true, escalationReasons: [], audience });
    assert.strictEqual(d.disposition, 'auto_ok', `${audience} should be auto_ok when clean`);
  }
});

// The safety invariant: no combination of flags ever downgrades a problem to
// auto_ok. If anything is off, it is an exception.
console.log('\nSafety invariant — anything off is an exception');
for (const c of [
  { gateAllowed: false, grounded: true, escalationReasons: [], audience: 'board' },
  { gateAllowed: true, grounded: false, escalationReasons: [], audience: 'board' },
  { gateAllowed: true, grounded: true, escalationReasons: ['charged/legal-adjacent language'], audience: 'board' },
  { gateAllowed: false, grounded: false, escalationReasons: ['hardship'], audience: 'other' },
]) {
  check(`off-nominal → needs_review (${JSON.stringify(c).slice(0, 60)})`, () => {
    assert.strictEqual(classifyDisposition(c).disposition, 'needs_review');
  });
}

console.log('');
if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
console.log('All Amanda disposition cases passed.\n');
