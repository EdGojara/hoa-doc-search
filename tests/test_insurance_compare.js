// =============================================================================
// tests/test_insurance_compare.js — the renewal analysis, encoded
// =============================================================================
//
// The golden case: Lakes of Pine Forest, 2026 renewal. The current USLI program
// ($21,031.85) versus an Acrisure/Chubb proposal ($18,363.76). Done by hand, the
// right answer was NOT "it's $2,668 cheaper, switch." It was: the lower premium
// is bought by insuring a $455k brick building for $221k under an 80% coinsurance
// clause, dropping $539k of scheduled property, and dropping the hired/non-owned
// auto line, while the liability and crime limits actually improve. This test
// proves the comparator reaches those same conclusions from the structured data,
// so the judgment is a repeatable check and not a one-time human read.
//
// Run: node tests/test_insurance_compare.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { compareInsurancePrograms } = require('../lib/insurance_compare');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

// Current in-force program (USLI 2025-2026). Property carries the clubhouse at
// full replacement cost plus the outdoor schedule; total insured property $785,216.
const CURRENT = {
  entity: { named_insured: 'Lakes of Pine Forest HOA' },
  coverages: [
    { line: 'General Liability', annual_premium: '$5,579', limits: [{ label: 'Each Occurrence', amount: '$1,000,000' }, { label: 'General Aggregate', amount: '$2,000,000' }] },
    { line: 'Commercial Property', annual_premium: '$9,360.85', limits: [{ label: 'Blanket Building', amount: '$455,216' }], key_terms: ['80% coinsurance', 'special form'] },
    { line: 'Directors & Officers', annual_premium: '$4,053', limits: [{ label: 'Aggregate', amount: '$1,000,000' }] },
    { line: 'Crime/Fidelity', annual_premium: '$644', limits: [{ label: 'Employee Theft', amount: '$100,000' }] },
    { line: 'Umbrella/Excess Liability', annual_premium: '$1,395', limits: [{ label: 'Each Occurrence', amount: '$1,000,000' }] },
    { line: 'Hired/Non-Owned Auto', annual_premium: null, limits: [{ label: 'Each Accident', amount: '$2,000,000' }] },
  ],
  statement_of_values: [
    { description: 'Building (Clubhouse)', value: '$455,216' },
    { description: 'Monuments', value: '$100,000' },
    { description: 'Fence', value: '$70,000' },
    { description: 'Light poles and signs', value: '$40,000' },
    { description: 'Underground utilities', value: '$40,000' },
    { description: 'Playground equipment', value: '$40,000' },
    { description: 'Pool', value: '$30,000' },
    { description: 'Other structures', value: '$10,000' },
  ],
};

// Proposed program (Acrisure / Chubb + CFC 2026-2027). Building at $221,321, no
// outdoor schedule, no auto — but GL and crime limits are higher.
const PROPOSED = {
  entity: { named_insured: 'Lakes of Pine Forest HOA' },
  coverages: [
    { line: 'General Liability', annual_premium: '$6,622', limits: [{ label: 'Each Occurrence', amount: '$2,000,000' }, { label: 'General Aggregate', amount: '$4,000,000' }] },
    { line: 'Commercial Property', annual_premium: '$2,327', limits: [{ label: 'Blanket Building', amount: '$221,321' }], key_terms: ['80% coinsurance'] },
    { line: 'Directors & Officers', annual_premium: '$7,810.76', limits: [{ label: 'Aggregate', amount: '$1,000,000' }] },
    { line: 'Crime/Fidelity', annual_premium: '$1,000', limits: [{ label: 'Employee Theft', amount: '$1,000,000' }] },
    { line: 'Umbrella/Excess Liability', annual_premium: '$604', limits: [{ label: 'Each Occurrence', amount: '$1,000,000' }] },
  ],
  statement_of_values: [
    { description: 'Building', value: '$221,321' },
    { description: 'Business Personal Property', value: '$25,000' },
  ],
};

const r = compareInsurancePrograms(CURRENT, PROPOSED);
console.log('\nInsurance renewal comparator — Lakes of Pine Forest golden case\n');

check('premium totals: $21,031.85 current, $18,363.76 proposed', () => {
  assert.ok(Math.abs(r.premium.current - 21031.85) < 0.01, `current ${r.premium.current}`);
  assert.ok(Math.abs(r.premium.proposed - 18363.76) < 0.01, `proposed ${r.premium.proposed}`);
  assert.ok(Math.abs(r.premium.delta - -2668.09) < 0.01, `delta ${r.premium.delta}`);
});

check('coinsurance/ITV trap flagged (building $221,321 < 80% of $455,216)', () => {
  assert.strictEqual(r.property.coinsuranceExposure, true, 'exposure not flagged');
  assert.strictEqual(r.property.coinsurance, 80);
});

check('property reduction detected (~$538,895 less insured property)', () => {
  assert.ok(r.property.totalDelta < -500000, `totalDelta ${r.property.totalDelta}`);
  assert.ok(Math.abs(r.property.curTotal - 785216) < 1 && Math.abs(r.property.propTotal - 246321) < 1);
});

check('hired/non-owned auto flagged as dropped', () => {
  assert.ok(r.dropped.some((d) => /auto/i.test(d)), `dropped: ${JSON.stringify(r.dropped)}`);
});

check('commercial property building limit flagged as reduced', () => {
  const propRed = r.limitReductions.find((l) => /property/i.test(l.line));
  assert.ok(propRed && propRed.reductions.some((x) => /building/i.test(x.label)), `limitReductions: ${JSON.stringify(r.limitReductions)}`);
});

check('improved lines are NOT flagged as reductions (GL up, Crime up)', () => {
  const glRed = r.limitReductions.find((l) => /general liability/i.test(l.line));
  const crimeRed = r.limitReductions.find((l) => /crime/i.test(l.line));
  assert.ok(!glRed, 'GL wrongly flagged as reduced');
  assert.ok(!crimeRed, 'Crime wrongly flagged as reduced');
});

check('headline finding is the coinsurance high-severity item; premium framed as coverage-cut', () => {
  assert.strictEqual(r.findings[0].category, 'coinsurance', `first finding: ${r.findings[0].category}`);
  const prem = r.findings.find((f) => f.category === 'premium');
  assert.ok(prem && prem.severity === 'high', 'premium delta not flagged high (coverage cut)');
  assert.ok(/not a like-for-like/i.test(prem.detail), 'premium finding did not attribute the saving to reduced coverage');
});

console.log('');
if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
console.log('All insurance comparator cases passed.\n');
