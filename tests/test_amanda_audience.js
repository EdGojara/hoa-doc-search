// =============================================================================
// tests/test_amanda_audience.js — who Amanda thinks she is writing to
// =============================================================================
//
// Audience is not a tone setting, it is the confidentiality-and-authority gate.
// A board member may be shown a delinquent owner's balance and is given options
// plus a recommendation because they are the fiduciary who decides. A homeowner
// may see only their own data. Misclassify a homeowner as a board member and
// Amanda could disclose a neighbor's account; misclassify a board member as a
// homeowner and she stonewalls the people who are supposed to get real answers.
//
// pickAudience is the pure mapping from resolved signals to audience, so the
// rule that governs disclosure is testable with no database. resolveAudience
// (which gathers the signals) is exercised live before shipping; this locks the
// decision the signals feed.
//
// Run: node tests/test_amanda_audience.js   (wired into npm test)
// =============================================================================

const assert = require('assert');
const { pickAudience } = require('../lib/community/amanda_reply');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures += 1; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

console.log('\nAmanda — audience classification\n');

const CASES = [
  // [signals, expected, why]
  [{ senderEmail: 'martha@bedrocktx.com', isBoardMember: false, isOwner: false }, 'staff',     'internal domain is staff'],
  [{ senderEmail: 'ED@BEDROCKTX.COM',     isBoardMember: true,  isOwner: true  }, 'staff',     'staff wins even if also flagged board/owner (case-insensitive)'],
  [{ senderEmail: 'pres@gmail.com',       isBoardMember: true,  isOwner: true  }, 'board',     'board member on a personal email is board, and outranks owner'],
  [{ senderEmail: 'dave@gmail.com',       isBoardMember: false, isOwner: true  }, 'homeowner', 'resolved lot owner is a homeowner'],
  [{ senderEmail: 'stranger@gmail.com',   isBoardMember: false, isOwner: false }, 'other',     'unresolved sender is other, never assumed into a trusted tier'],
  [{ senderEmail: '',                     isBoardMember: false, isOwner: false }, 'other',     'no sender resolves to other'],
];

for (const [signals, expected, why] of CASES) {
  check(`${expected.padEnd(9)} — ${why}`, () => {
    assert.strictEqual(pickAudience(signals), expected, `got "${pickAudience(signals)}"`);
  });
}

// The disclosure invariant that matters most: an unresolved or owner sender must
// NEVER be classified into a tier that widens disclosure (board/staff).
console.log('\nDisclosure safety — never over-trust an unproven sender');
for (const s of [
  { senderEmail: 'unknown@x.com', isBoardMember: false, isOwner: false },
  { senderEmail: 'owner@x.com',   isBoardMember: false, isOwner: true  },
]) {
  check(`"${s.senderEmail}" is not board/staff`, () => {
    const a = pickAudience(s);
    assert.ok(a !== 'board' && a !== 'staff', `classified as "${a}" — would widen disclosure without proof`);
  });
}

console.log('');
if (failures) { console.log(`FAILED — ${failures} case(s)\n`); process.exit(1); }
console.log('All Amanda audience cases passed.\n');
