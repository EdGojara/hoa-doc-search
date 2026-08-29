// =============================================================================
// tests/test_persona_configs.js — every teammate's config is well-formed
// =============================================================================
//
// The operator engine drives each persona from its config. A typo that drops a
// system prompt, a fallback, or the reserved-boundary language would make a
// persona quietly worse the moment it is turned on. This locks the shape: each
// config produces a real system prompt that names its HARD boundary, a real
// fallback, and a roster-derived signature to strip. It does not call the model
// or the DB — it validates the data every lane composes over the shared core.
//
// Run: node tests/test_persona_configs.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { CONFIGS } = require('../lib/team/persona_configs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

console.log('\nTeam operator configs\n');

const expected = ['claire', 'annie', 'miranda', 'emma', 'kat', 'reese'];
check(`configs present: ${expected.join(', ')}`, () => {
  for (const p of expected) assert.ok(CONFIGS[p], `missing config for ${p}`);
});

for (const [persona, c] of Object.entries(CONFIGS)) {
  check(`${persona}: well-formed`, () => {
    assert.strictEqual(c.persona, persona, 'persona key mismatch');
    assert.strictEqual(typeof c.systemPromptFor, 'function', 'systemPromptFor must be a function');
    assert.strictEqual(typeof c.fallback, 'function', 'fallback must be a function');
    assert.ok(Array.isArray(c.sigNames) && c.sigNames.length, 'sigNames must be a non-empty array (roster identity)');
    assert.ok(c.reviewHintLabel, 'reviewHintLabel required');

    const prompt = c.systemPromptFor('homeowner', 'Test Community');
    assert.ok(typeof prompt === 'string' && prompt.length > 200, 'system prompt too short');
    assert.ok(/HARD RULE/i.test(prompt), 'system prompt must state its HARD boundary');
    assert.ok(/Test Community/.test(prompt), 'system prompt must bind the community name');

    const fb = c.fallback('Dave', 'Test Community');
    assert.ok(typeof fb === 'string' && /Dave/.test(fb), 'fallback must greet the sender');
  });
}

// The reserved boundary must actually appear as a refusal-to-decide instruction,
// per lane. This is the safety half: not just "HARD RULE" text, but the specific
// authority each lane must never exercise.
console.log('\nEach lane names the authority it must not exercise');
const boundary = {
  claire: /waive|adjust a balance|grant or deny|legal position|move money/i,
  annie: /never approve or deny|committee/i,
  miranda: /never waive|decide a violation|chapter 209|deadline/i,
  emma: /never approve|promise a payment|commit funds/i,
  kat: /never post|move money|report.*reconcile.*recommend/i,
  reese: /never waive|release a lien|legal position on title|right of first refusal/i,
};
for (const [persona, re] of Object.entries(boundary)) {
  check(`${persona}: prompt states its reserved boundary`, () => {
    assert.ok(re.test(CONFIGS[persona].systemPromptFor('homeowner', 'X')), `boundary language missing for ${persona}`);
  });
}

console.log('');
if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
console.log('All persona config cases passed.\n');
