// ============================================================================
// tests/test_contact_mining.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Guards the rule that decides WHOSE phone number goes in Ed's address book.
//
// The first run of build_contacts_from_email.js wrote 537 contacts and got the
// names wrong on the ones Ed uses most:
//
//   mbravo@bedrocktx.com                  -> "Ramsey Gonzalez"
//   jjetton@bedrocktx.com                 -> "Phil Lang"
//   president@canyongateatcincoranch.com  -> "Martha Bravo"
//
// Cause: signature blocks sit at the BOTTOM of a message, so the parser read
// the bottom. On a forwarded or replied thread the bottom is the OLDEST
// message, and its signature belongs to whoever started the thread. Martha
// forwards a vendor proposal and the vendor's name, title and phone get filed
// under Martha.
//
// The no-AI run had these names RIGHT, from Outlook's display name. The clever
// step made it worse, which is the part worth keeping a test around for.
//
// The rule: Outlook's display name wins, because it is what the mailbox is
// called rather than something inferred. A signature is believed only when it
// agrees about who it is, and when it disagrees the phone and address in it are
// dropped along with the name — a number filed under the wrong person is worse
// than a blank field, because it is the one that gets dialled.
//
//   node tests/test_contact_mining.js
// ============================================================================
const assert = require('assert');
const { signatureMatchesSender, normName, categoryFor, isNoise } = require('../scripts/build_contacts_from_email');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\nSignature must belong to the sender');

// The four real misattributions from the first run.
check('a forwarded vendor signature is not the forwarder', () => {
  assert.strictEqual(signatureMatchesSender('Ramsey Gonzalez', 'Martha Bravo'), false);
});
check('one staffer’s signature is not another staffer', () => {
  assert.strictEqual(signatureMatchesSender('Phil Lang', 'Jacey Jetton'), false);
  assert.strictEqual(signatureMatchesSender('Jacey Jetton', 'A Pitarra'), false);
});
check('the manager who forwards is not the board role she forwards from', () => {
  assert.strictEqual(signatureMatchesSender('Martha Bravo', 'President HOA'), false);
});

check('the person’s own signature is accepted', () => {
  assert.strictEqual(signatureMatchesSender('Martha Bravo', 'Martha Bravo'), true);
  assert.strictEqual(signatureMatchesSender('Haley Bellanger', 'Haley Bellanger'), true);
});

check('Exchange "Last,First" display names still match', () => {
  // Real: NewFirst's Melody Hess arrives as "Hess,Melody".
  assert.strictEqual(signatureMatchesSender('Melody Hess', 'Hess,Melody'), true);
  assert.strictEqual(signatureMatchesSender('Bravo, Martha', 'Martha Bravo'), true);
});

check('an initial matches, a different first name does not', () => {
  assert.strictEqual(signatureMatchesSender('M. Bravo', 'Martha Bravo'), true);
  // Shared surname is not identity. Spouses and siblings share inboxes.
  assert.strictEqual(signatureMatchesSender('John Smith', 'Jane Smith'), false);
});

check('credential suffixes do not break the match', () => {
  assert.strictEqual(signatureMatchesSender('Martha Bravo, CMCA', 'Martha Bravo'), true);
  assert.strictEqual(signatureMatchesSender('Melody Hess, CPA', 'Hess, Melody'), true);
});

check('an empty side never counts as agreement', () => {
  assert.strictEqual(signatureMatchesSender('', 'Martha Bravo'), false);
  assert.strictEqual(signatureMatchesSender('Martha Bravo', ''), false);
  assert.strictEqual(signatureMatchesSender(null, null), false);
});

check('normName is stable on punctuation and case', () => {
  assert.strictEqual(normName('  MARTHA   BRAVO '), 'martha bravo');
  assert.strictEqual(normName('Hess,Melody'), 'melody hess');
});

console.log('\nWho belongs in the book');

check('departed staff are kept out', () => {
  // Laurie left 2026-08-13 and still ranks high on a year of mail.
  assert.strictEqual(isNoise('laurie@bedrocktx.com', 'Laurie Vrvilo'), true);
});
check('automated senders are kept out on address, name or domain', () => {
  assert.strictEqual(isNoise('no-reply@vantaca.com', 'Vantaca'), true);
  assert.strictEqual(isNoise('someone@bounces.mailchimp.com', 'Bob'), true);
  assert.strictEqual(isNoise('news@example.com', 'Chase Alert Notification'), true);
});
check('real people are let in', () => {
  assert.strictEqual(isNoise('mbravo@bedrocktx.com', 'Martha Bravo'), false);
  assert.strictEqual(isNoise('haley.bellanger@united-protective.com', 'Haley Bellanger'), false);
});

check('board role aliases are categorised as board, not vendor', () => {
  assert.strictEqual(categoryFor('president@canyongateatcincoranch.com', null, null), 'board');
  assert.strictEqual(categoryFor('mbravo@bedrocktx.com', null, null), 'staff');
});

if (!process.exitCode) console.log('\n✓ Contact mining: all ' + passed + ' checks passed.\n');
else console.error('\nContact mining: FAILURES above.\n');
