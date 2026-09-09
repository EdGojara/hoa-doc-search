// Locks the fabricated-"confirmed with the team" scrub (Ed 2026-09-08). The
// drafter kept opening compliance answers with an invented team confirmation
// that a system-prompt rule could not stop (the Waterview corner-lot tree
// thread). The scrub excises a CLEAN leading clause and flags anything riskier
// without mangling the sentence.
require('dotenv').config();
const assert = require('assert');
const { scrubFabricatedConfirmation } = require('../lib/email/draft_reply');
let p = 0, f = 0;
const ck = (n, fn) => { try { fn(); console.log('  PASS ', n); p++; } catch (e) { console.log('  FAIL ', n, '\n    ' + e.message); f++; } };

ck('strips a clean leading "I\'ve confirmed with the team, and ..." opener', () => {
  const r = scrubFabricatedConfirmation("I've confirmed with the team, and the minimum for a corner lot is four trees.");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.text, 'The minimum for a corner lot is four trees.');
});

ck('keeps the greeting, strips the clause after it, capitalizes the answer', () => {
  const r = scrubFabricatedConfirmation("Hi Noreen,\n\nI've confirmed with the team, and corner lots require four trees.");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.text, 'Hi Noreen,\n\nCorner lots require four trees.');
});

ck('handles "I have checked with our team" phrasing', () => {
  const r = scrubFabricatedConfirmation('I have checked with our team, the setback is 10 feet.');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.text, 'The setback is 10 feet.');
});

ck('does NOT mangle: a mid-body claim is flagged but left intact (no dangling fragment)', () => {
  const src = 'Corner lots require four trees. I confirmed with the team on the caliper spec.';
  const r = scrubFabricatedConfirmation(src);
  assert.strictEqual(r.hit, true);       // flagged for the reviewer
  assert.strictEqual(r.text, src);       // but NOT cut — no broken sentence
});

ck('leaves a clean, honest answer untouched', () => {
  const src = 'Corner lots require four trees: two in the front yard and two along the side street.';
  const r = scrubFabricatedConfirmation(src);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.text, src);
});

ck('does not create a leading-fragment when the clause runs into "by ..."', () => {
  const r = scrubFabricatedConfirmation("I've confirmed with the team by reviewing the file, corner lots need four trees.");
  assert.strictEqual(r.hit, true);
  assert.ok(!/^Documents|^by |^,/.test(r.text), 'no dangling fragment at the start');
  assert.ok(/corner lots need four trees/i.test(r.text));
});

console.log(`\nfabricated_confirmation_scrub: ${p} passed, ${f} failed`);
if (f) process.exit(1);
