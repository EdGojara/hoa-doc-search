// ============================================================================
// tests/test_tessa_voice.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Tessa sends her own email. Invoking Ed is the exception.
//
// Two corrections on the same day, and they are different corrections:
//
//   "i don't want tessa send as me she can say i asked her to send it"
//   "send on my behalf would be saying i asked her not signing as me
//    it should default to her sending it though"
//
// The first killed the ghostwriting path: she used to write in Ed's first
// person, from Ed's own mailbox, with nothing marking it as assistant-written.
// The second is subtler. Her voice then told her to write "on Ed's behalf" on
// EVERY email, so "Ed asked me to follow up on..." became a formula rather than
// a fact, opening messages that had nothing to do with Ed. Martha asking Tessa
// how she is does not warrant an invocation of the owner.
//
// So: default is her own message, no explanation of why she and not Ed is
// writing. When the content genuinely came from Ed she MAY say so, once, in the
// sentence where it belongs.
//
// These assert the PROMPT, not the model's prose. The prompt is the part that
// is deterministic and the part that regressed.
//
//   node tests/test_tessa_voice.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa.js'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'tessa.js'), 'utf8');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('\nShe never signs as Ed');

check('the ghostwriting voice is gone, not merely unused', () => {
  assert.ok(!/const ED_VOICE\s*=/.test(SRC),
    'ED_VOICE still exists; an unused voice is one a caller re-enables by passing a string');
  assert.ok(!/ghostwriting an email AS Ed/i.test(SRC), 'the ghostwrite instruction is still in the file');
});

check('no code path can still select an as-Ed mode', () => {
  const leftovers = (SRC + API).match(/mode:\s*'ed'|===\s*'ed'\s*\?\s*'ed'/g) || [];
  assert.deepStrictEqual(leftovers, [],
    'these still route to an as-Ed mode: ' + leftovers.join(', '));
});

check('every send goes from her own mailbox', () => {
  // asEd is pinned false at both send sites rather than read from the request.
  const asEdReads = API.match(/const asEd = String\(/g) || [];
  assert.deepStrictEqual(asEdReads, [],
    'a send path still takes the sender identity from the request body');
});

console.log('\nInvoking Ed is a permission, not an instruction');

check('the voice does not mandate "Ed asked me to"', () => {
  assert.ok(!/Write the email AS Tessa, on Ed's behalf \(for example "Ed asked me/.test(SRC),
    'the voice still instructs her to attribute every email to Ed');
  assert.ok(/It is your email and you are sending it/.test(SRC),
    'the voice no longer states the default');
  assert.ok(/is NOT a standard opening line/.test(SRC),
    'nothing stops the attribution becoming a formula again');
});

check('the permission exists and is off by default', () => {
  assert.ok(/function onBehalfBlock\(/.test(SRC), 'onBehalfBlock is missing');
  assert.ok(/onEdsBehalf = false/.test(SRC), 'draftEmail should default the permission OFF');
  assert.ok(/if \(!onEdsBehalf\) return ''/.test(SRC),
    'onBehalfBlock should add nothing at all when the permission is off');
});

check('it is granted exactly where the content came from Ed', () => {
  // Ed forwarded it.
  assert.ok(/onBehalfBlock\(!!sender\.forwardedByEd\)/.test(SRC),
    'a forward from Ed should grant the permission');
  // Ed forwarded it AND told her what to do with it.
  assert.ok(/onBehalfBlock\(true\)/.test(SRC),
    'handleForwarded should grant the permission');
  // Ed typed or dictated it.
  assert.ok(/onEdsBehalf: true/.test(API),
    'composing from Ed\'s own thought should grant the permission');
});

check('answering someone who wrote to HER grants nothing', () => {
  // draftReply keys the permission off forwardedByEd only. An inbound message
  // addressed to Tessa leaves it false, which is the Martha case.
  const m = SRC.match(/const voice = TESSA_VOICE \+ onBehalfBlock\(([^)]*)\);/g) || [];
  assert.ok(m.length >= 3, 'expected the permission wired at all three drafting entry points');
  assert.ok(!m.some((x) => /onBehalfBlock\(\s*true\s*\)/.test(x) && /sender/.test(x)),
    'draftReply must not hard-grant the permission');
});

console.log('\nThe sign-off');

check('she closes as Tessa and does not repeat the title', () => {
  assert.ok(/Close simply with "Tessa"/.test(SRC), 'the sign-off rule went missing');
  assert.ok(/do not repeat the title or\s*\n?\s*company yourself/.test(SRC),
    'nothing stops her duplicating the signature block');
});

if (!process.exitCode) console.log('\n✓ Tessa voice: all ' + passed + ' checks passed.\n');
else console.error('\nTessa voice: FAILURES above.\n');
