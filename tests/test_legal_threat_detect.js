// ============================================================================
// tests/test_legal_threat_detect.js  (Ed 2026-08-29)
// ----------------------------------------------------------------------------
// The litigation-threat detector is safety-critical: a "we're going to sue you"
// or "we've retained counsel" note must escalate loudly (needs_review at the
// urgent tier), whichever teammate catches it — AND it must NOT trip on the many
// benign uses of the word "attorney" this domain is full of (a closing attorney,
// power of attorney, "have your attorney send the payoff"). This test locks both
// halves: every real threat fires, every benign line stays quiet, and a threat
// forces confidence to 'low' through classifyDisposition.
// ============================================================================

const { detectLegalThreat, classifyDisposition, LEGAL_THREAT_REASON } = require('../lib/team/exception_router');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  PASS  ' + label); } else { fail++; console.log('  FAIL  ' + label); } }

// --- Must FIRE: real litigation intent -------------------------------------
const THREATS = [
  'Your fines are illegal harassment. We are going to sue the association for damages.',
  "I've retained an attorney and you'll be hearing from my lawyer.",
  'Consider this a formal demand letter before we file a complaint.',
  'This is a cease and desist. Stop all contact.',
  "I'll take you to court over this.",
  'See you in court.',
  'We are pursuing legal action against the board and management.',
  'This violates the DTPA and my counsel will be in touch.',
  'I have hired a lawyer to deal with the HOA.',
  'I am filing a claim in small claims court next week.',
  'This is a breach of fiduciary duty by the board.',
];
console.log('\nLitigation threats must fire:');
for (const t of THREATS) ok(detectLegalThreat(t) === LEGAL_THREAT_REASON, `fires: "${t.slice(0, 52)}..."`);

// --- Must STAY QUIET: benign uses of attorney/legal/court vocabulary --------
const BENIGN = [
  'Please have the closing attorney send the payoff to First American Title.',
  'My daughter has power of attorney and will handle my account going forward.',
  'The attorney handling our estate needs a statement of account for the sale.',
  'Can you confirm the legal description of the lot for our resale certificate?',
  'I would like to request a hearing before the board about my fine.',
  'What is the legal name of the association for our closing documents?',
  'Our title company attorney requested the estoppel; who do they contact?',
  'I paid the assessment, please update my account.',
];
console.log('\nBenign legal/closing vocabulary must NOT fire:');
for (const b of BENIGN) ok(detectLegalThreat(b) === null, `quiet: "${b.slice(0, 52)}..."`);

// --- A threat forces the urgent tier through the classifier -----------------
console.log('\nA threat drives disposition + tier:');
const withThreat = classifyDisposition({
  gateAllowed: true, grounded: true, audience: 'homeowner',
  escalationReasons: [LEGAL_THREAT_REASON],
});
ok(withThreat.disposition === 'needs_review', 'threat -> needs_review even when grounded + in-bounds + verified');
ok(withThreat.confidence === 'low', 'threat -> urgent (low) tier, not medium');

const clean = classifyDisposition({ gateAllowed: true, grounded: true, audience: 'homeowner', escalationReasons: [] });
ok(clean.disposition === 'auto_ok' && clean.confidence === 'high', 'no threat, all-nominal -> auto_ok/high (no false escalation)');

console.log(`\n${fail ? 'FAILED' : 'All'} legal-threat detector cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
process.exit(fail ? 1 : 0);
