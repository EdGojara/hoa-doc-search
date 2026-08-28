// =============================================================================
// tests/test_insurance_renewal.js — the parity re-quote reply, rendered
// =============================================================================
//
// Given the Lakes of Pine Forest comparison, the autonomous flow must produce
// the same reply written by hand: correct the building to its real replacement
// value, quote to the full property schedule, confirm the dropped auto line, and
// name the "cheaper because thinner" reality. Rendered from the structured
// comparison, so every figure is exact and nothing is freestyled.
//
// Also proves detection: an insurance proposal with a PDF is recognized; a
// message without a PDF, or without insurance content, is not.
//
// Run: node tests/test_insurance_renewal.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { compareInsurancePrograms } = require('../lib/insurance_compare');
const { renderRenewalRecommendation, looksLikeInsuranceProposal } = require('../lib/insurance_renewal_review');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

const CURRENT = {
  coverages: [
    { line: 'General Liability', annual_premium: '$5,579', limits: [{ label: 'Each Occurrence', amount: '$1,000,000' }] },
    { line: 'Commercial Property', annual_premium: '$9,360.85', limits: [{ label: 'Blanket Building', amount: '$455,216' }], key_terms: ['80% coinsurance'] },
    { line: 'Directors & Officers', annual_premium: '$4,053', limits: [{ label: 'Aggregate', amount: '$1,000,000' }] },
    { line: 'Crime/Fidelity', annual_premium: '$644', limits: [{ label: 'Employee Theft', amount: '$100,000' }] },
    { line: 'Umbrella/Excess Liability', annual_premium: '$1,395', limits: [{ label: 'Each Occurrence', amount: '$1,000,000' }] },
    { line: 'Hired/Non-Owned Auto', annual_premium: null, limits: [{ label: 'Each Accident', amount: '$2,000,000' }] },
  ],
  statement_of_values: [
    { description: 'Building (Clubhouse)', value: '$455,216' },
    { description: 'Monuments', value: '$100,000' },
    { description: 'Fence', value: '$70,000' },
    { description: 'Pool', value: '$30,000' },
  ],
};
const PROPOSED = {
  coverages: [
    { line: 'General Liability', annual_premium: '$6,622', limits: [{ label: 'Each Occurrence', amount: '$2,000,000' }] },
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

const comparison = compareInsurancePrograms(CURRENT, PROPOSED);
const { subject, body } = renderRenewalRecommendation(comparison, { communityName: 'Lakes of Pine Forest', currentProgram: CURRENT, senderName: 'Ramsey' });

console.log('\nInsurance renewal reply — rendered from the comparison\n');

check('addresses the sender and names the community', () => {
  assert.ok(/^Ramsey,/.test(body), 'no greeting');
  assert.ok(/Lakes of Pine Forest/.test(body), 'community not named');
});
check('corrects the building to its real replacement value ($455,216)', () => {
  assert.ok(/re-quote the building at \$455,216\.00/.test(body), 'building correction missing');
  assert.ok(/coinsurance penalty/i.test(body), 'coinsurance exposure not stated');
});
check('quotes the full property schedule to re-price at parity', () => {
  assert.ok(/Monuments: \$100,000/.test(body), 'schedule bullet missing');
  assert.ok(/Fence: \$70,000/.test(body) && /Pool: \$30,000/.test(body), 'schedule incomplete');
});
check('flags the dropped hired/non-owned auto line', () => {
  assert.ok(/Hired\/Non-Owned Auto/.test(body) && /confirm/i.test(body) && /add it/i.test(body), 'auto ask missing');
});
check('names the "cheaper because thinner" reality', () => {
  assert.ok(/thinner than what the association carries/i.test(body), 'premium attribution missing');
});
check('subject is a parity re-quote request', () => {
  assert.ok(/parity/i.test(subject) && /Lakes of Pine Forest/.test(subject), `subject: ${subject}`);
});

console.log('\nDetection');
check('insurance proposal with a PDF is recognized', () => {
  assert.strictEqual(looksLikeInsuranceProposal({ subject: 'Insurance renewal proposal', body: 'quote attached' }, [{ mime: 'application/pdf' }]), true);
});
check('no PDF is not a proposal to auto-review', () => {
  assert.strictEqual(looksLikeInsuranceProposal({ subject: 'Insurance renewal', body: 'call me' }, []), false);
});
check('non-insurance message with a PDF is not a proposal', () => {
  assert.strictEqual(looksLikeInsuranceProposal({ subject: 'Pool party flyer', body: 'see attached' }, [{ mime: 'application/pdf' }]), false);
});

console.log('');
if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
console.log('All insurance renewal cases passed.\n');
