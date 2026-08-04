// ============================================================================
// tests/test_acc_application_matching.js
// ----------------------------------------------------------------------------
// The ACC inbound-email → open-application matcher (lib/acc/match_open_application).
// These are the exact shapes that stranded the Lopez patio across three rows:
//   - homeowner writes from a different address than the one on her form
//   - the reply's address string differs only in punctuation/case
//   - follow-ups thread under one Graph conversation
// Plus guardrails: a shared surname alone must NOT attach a stranger's email.
//
// Pure scoring, no DB. Wired into `npm test`.
// ============================================================================
const assert = require('assert');
const { scoreCandidate, pickBestOpenApp, normAddr } = require('../lib/acc/match_open_application');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

// The real open case for 9202 Floral Crest, as it sat when the 7/20 follow-up
// arrived: on file from her YAHOO address, punctuation-different address, one
// sibling message already on the case.
const LOPEZ_CASE = {
  id: 'case-lopez',
  submitter_email: 'LPZMAR555@yahoo.com',
  homeowner_address: '9202 Floral Crest Dr, Houston, TX 77083',
  homeowner_name: 'Simon and Maria Lopez',
  reference_number: 'EAG-ARC-2026-0001',
  source_email_refs: ['email:AAA-original-627'],
  correspondent_emails: [],
  created_at: '2026-07-13T00:00:00Z',
};

// A different open case in the same community — a real second Lopez elsewhere,
// used to prove name-overlap alone never mis-attaches.
const OTHER_LOPEZ = {
  id: 'case-other',
  submitter_email: 'jlopez@example.com',
  homeowner_address: '4501 Canyon Bluff Ln, Houston, TX 77083',
  homeowner_name: 'Jorge Lopez',
  reference_number: 'EAG-ARC-2026-0002',
  source_email_refs: ['email:BBB-other'],
  correspondent_emails: [],
  created_at: '2026-07-15T00:00:00Z',
};

console.log('ACC application matcher:');

// 1) THREAD — the exact miss. Different sender email, punctuation-different
//    address, BUT the follow-up shares the conversation (a sibling ref is on
//    the case). Must match on thread alone.
check('thread match wins despite different email + address punctuation', () => {
  const sig = {
    referenceText: 'Re: ARCHITECTURAL REVIEW COMMITTEE - 9202 FLORAL CREST DR',
    emails: ['lpzmartaxes@gmail.com'],                 // NOT the on-file yahoo
    name: 'Maria Lopez',
    address: '9202 FLORAL CREST DR. HOUSTON, TX 77083', // "DR." vs "Dr,"
    siblingRefs: new Set(['email:AAA-original-627', 'email:CCC-followup-720']),
  };
  const best = pickBestOpenApp([LOPEZ_CASE, OTHER_LOPEZ], sig);
  assert(best && best.cand.id === 'case-lopez', 'should match the Lopez case');
  assert(best.reasons.includes('thread'), 'should cite thread');
});

// 2) ADDRESS — no thread signal (fresh conversation), different email. The
//    normalized address must still match; raw ilike would have missed.
check('normalized address matches across punctuation with no thread', () => {
  const sig = {
    referenceText: 'architectural documents',
    emails: ['lpzmartaxes@gmail.com'],
    name: 'Maria',
    address: '9202 FLORAL CREST DR. HOUSTON, TX 77083',
    siblingRefs: new Set(),
  };
  const best = pickBestOpenApp([LOPEZ_CASE, OTHER_LOPEZ], sig);
  assert(best && best.cand.id === 'case-lopez', 'address should carry the match');
  assert(best.reasons.includes('address'));
  assert.strictEqual(normAddr('9202 FLORAL CREST DR. HOUSTON, TX 77083'),
                     normAddr('9202 Floral Crest Dr, Houston, TX 77083'));
});

// 3) REFERENCE — the case number in the subject line matches.
check('reference number in subject matches', () => {
  const sig = {
    referenceText: 'Re: your application EAG-ARC-2026-0001 update',
    emails: ['someone-else@gmail.com'],
    name: null, address: null, siblingRefs: new Set(),
  };
  const best = pickBestOpenApp([LOPEZ_CASE, OTHER_LOPEZ], sig);
  assert(best && best.cand.id === 'case-lopez');
  assert(best.reasons.includes('reference'));
});

// 4) KNOWN EMAIL — once her gmail is captured onto the case, the NEXT email
//    from it self-matches even with no thread/address.
check('captured correspondent email self-matches later', () => {
  const withGmail = { ...LOPEZ_CASE, correspondent_emails: ['lpzmartaxes@gmail.com'] };
  const sig = { referenceText: '', emails: ['LPZMARTAXES@GMAIL.COM'], name: null, address: null, siblingRefs: new Set() };
  const best = pickBestOpenApp([withGmail, OTHER_LOPEZ], sig);
  assert(best && best.cand.id === 'case-lopez');
  assert(best.reasons.includes('email'));
});

// 5) GUARDRAIL — shared surname but different property, different thread,
//    unknown email. Name alone (25) must stay below the 70 bar: NO match.
check('shared surname alone does not attach a stranger', () => {
  const sig = {
    referenceText: 'new patio question',
    emails: ['random.lopez@gmail.com'],
    name: 'Ana Lopez',
    address: '9999 Nowhere St, Houston, TX 77000',
    siblingRefs: new Set(),
  };
  const best = pickBestOpenApp([LOPEZ_CASE, OTHER_LOPEZ], sig);
  assert(best === null, 'name overlap must not cross the threshold');
});

// 6) GUARDRAIL — generic placeholder names never match each other.
check('generic homeowner names never match on name', () => {
  const genericCase = { ...LOPEZ_CASE, homeowner_name: 'Not Listed', homeowner_address: null, submitter_email: null, source_email_refs: [] };
  const { score, reasons } = scoreCandidate(genericCase, { name: 'Homeowner', emails: [], siblingRefs: new Set() });
  assert.strictEqual(score, 0, 'generic vs generic = no signal');
  assert(!reasons.includes('name'));
});

// 7) Most-recent tiebreak among equal scores.
check('ties break toward the most recent open case', () => {
  const a = { ...LOPEZ_CASE, id: 'a', created_at: '2026-07-10T00:00:00Z', source_email_refs: ['email:x'] };
  const b = { ...LOPEZ_CASE, id: 'b', created_at: '2026-07-20T00:00:00Z', source_email_refs: ['email:x'] };
  const sig = { emails: [], name: null, address: null, referenceText: '', siblingRefs: new Set(['email:x']) };
  const best = pickBestOpenApp([a, b], sig);
  assert(best && best.cand.id === 'b', 'newer case wins the tie');
});

console.log(`\nACC matcher: ${passed}/7 passed`);
if (passed !== 7) { process.exit(1); }
