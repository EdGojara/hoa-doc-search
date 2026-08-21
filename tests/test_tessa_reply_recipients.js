// ============================================================================
// tests/test_tessa_reply_recipients.js — who a reply actually reaches.
// ----------------------------------------------------------------------------
// Ed 2026-08-21, looking at the reply screen: "how do i know tessa is replying
// to all or just sender?"
//
// He could not, and the answer was worse than the question. api/tessa.js did:
//
//     const to = parseAddrs(b.to || item.from_email);
//     const cc = parseAddrs(b.cc);
//
// Sender only, always — and the UI had no Cc field at all, so b.cc was
// permanently empty. The screen showed one unlabelled address box with the
// sender prefilled and said nothing about who was being left off.
//
// Reply-all was not switched off, it was IMPOSSIBLE: lib/ea/tessa_inbox.js asks
// Graph for toRecipients and ccRecipients, builds both lists to decide whether
// Ed was on the To or the Cc line, then kept the one-word conclusion and threw
// the lists away. ea_inbox had nowhere to put them until migration 380.
//
// Why it matters beyond convenience: the Canyon Gate thread reached five board
// aliases plus Martha plus Ed. Answering director@ alone means four directors
// and the manager never see it, and the association's record of its own
// correspondence has a hole in exactly the place those aliases exist to
// protect. See project_canyon_gate_role_aliases.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const { replyOptions, describeRecipients } = require('../lib/ea/tessa_reply_recipients');

const GS = { TESSA_MAILBOX: 'tessa@bedrocktx.com', ED_MAILBOX: 'egojara@bedrocktx.com' };

const BOARD = {
  from_email: 'director@canyongateatcincoranch.com',
  to_recipients: [
    'tessa@bedrocktx.com',
    'president@canyongateatcincoranch.com',
    'vicepresident@canyongateatcincoranch.com',
    'secretary@canyongateatcincoranch.com',
    'treasurer@canyongateatcincoranch.com',
  ],
  cc_recipients: ['mbravo@bedrocktx.com', 'egojara@bedrocktx.com'],
};

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

console.log('\nReply-all reaches the whole thread');
check('the sender is on the To line', () => {
  const o = replyOptions(BOARD, GS);
  assert.ok(o.all, 'reply-all must be offered');
  assert.ok(o.all.to.includes('director@canyongateatcincoranch.com'));
});
check('the other four board aliases are not dropped', () => {
  const o = replyOptions(BOARD, GS);
  for (const a of ['president', 'vicepresident', 'secretary', 'treasurer']) {
    assert.ok(o.all.to.includes(`${a}@canyongateatcincoranch.com`), `${a}@ must be on the reply`);
  }
});
check('Martha stays on Cc', () => {
  const o = replyOptions(BOARD, GS);
  assert.ok(o.all.cc.includes('mbravo@bedrocktx.com'));
});

console.log('\nOur own addresses never appear');
check('Tessa is not mailed by Tessa', () => {
  // Her own mailbox is polled. A reply addressed to it loops: the reply lands
  // in tessa@, gets drafted, and Ed reviews a reply to what he just sent.
  const o = replyOptions(BOARD, GS);
  const every = [...o.all.to, ...o.all.cc];
  assert.ok(!every.includes('tessa@bedrocktx.com'), 'tessa@ must be stripped or the queue feeds itself');
});
check('Ed is not Cc\'d on his own assistant\'s reply', () => {
  const o = replyOptions(BOARD, GS);
  assert.ok(![...o.all.to, ...o.all.cc].includes('egojara@bedrocktx.com'));
});

console.log('\nSender-only stays sender-only');
check('the sender option never grows a Cc', () => {
  const o = replyOptions(BOARD, GS);
  assert.deepStrictEqual(o.sender.to, ['director@canyongateatcincoranch.com']);
  assert.deepStrictEqual(o.sender.cc, []);
});
check('it says how many people are being left out', () => {
  const o = replyOptions(BOARD, GS);
  const label = describeRecipients('sender', o);
  assert.match(label, /will not see it/, 'the cost of sender-only must be stated');
  assert.ok(o.others >= 4, `expected 4+ others, got ${o.others}`);
});

console.log('\nUnknown is not the same as nobody');
check('a pre-380 row cannot offer reply-all', () => {
  // NULL means the lists were never recorded. Rendering an empty reply-all
  // there would be a confident lie.
  const o = replyOptions({ from_email: 'x@y.com', to_recipients: null, cc_recipients: null }, GS);
  assert.strictEqual(o.known, false);
  assert.strictEqual(o.all, null, 'must not invent a reply-all from missing data');
});
check('and the label admits it', () => {
  const o = replyOptions({ from_email: 'x@y.com', to_recipients: null, cc_recipients: null }, GS);
  assert.match(describeRecipients('sender', o), /not recorded/);
});
check('an empty array IS a real answer', () => {
  // [] means we looked and there was nobody else. Different from NULL.
  const o = replyOptions({ from_email: 'x@y.com', to_recipients: [], cc_recipients: [] }, GS);
  assert.strictEqual(o.known, true);
  assert.strictEqual(o.all, null, 'nobody else on the thread means no second option');
});

console.log('\nNo pointless second option');
check('a one-to-one message offers only sender', () => {
  const o = replyOptions({ from_email: 'haley@united-protective.com', to_recipients: ['tessa@bedrocktx.com'], cc_recipients: [] }, GS);
  assert.strictEqual(o.all, null, 'reply-all that reaches nobody new must not be offered');
  assert.strictEqual(o.others, 0);
});

console.log('\nMessy input does not break it');
check('case and whitespace are normalised', () => {
  const o = replyOptions({
    from_email: '  Director@CanyonGateAtCincoRanch.com ',
    to_recipients: ['TESSA@bedrocktx.com', 'President@canyongateatcincoranch.com'],
    cc_recipients: [],
  }, GS);
  assert.ok(!o.all.to.includes('TESSA@bedrocktx.com'), 'self-match must be case-insensitive');
  assert.ok(o.all.to.includes('president@canyongateatcincoranch.com'));
});
check('duplicates collapse', () => {
  const o = replyOptions({
    from_email: 'a@b.com',
    to_recipients: ['a@b.com', 'c@d.com', 'c@d.com'],
    cc_recipients: ['c@d.com'],
  }, GS);
  const every = [...o.all.to, ...o.all.cc];
  assert.strictEqual(new Set(every).size, every.length, 'no address twice');
});
check('a missing from_email does not crash', () => {
  const o = replyOptions({ from_email: null, to_recipients: ['x@y.com'], cc_recipients: null }, GS);
  assert.ok(o, 'must return something rather than throw');
});

console.log('\nThe wiring is actually connected');
check('the poller stores the lists', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ea', 'tessa_inbox.js'), 'utf8');
  assert.ok(/to_recipients:\s*toList/.test(src), 'tessa_inbox must persist toList');
  assert.ok(/cc_recipients:\s*ccList/.test(src), 'tessa_inbox must persist ccList');
});
check('the reply screen sends Cc', () => {
  // The Cc field existing is useless if ibSend does not pass it. That was the
  // original defect one layer up.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'tessa.html'), 'utf8');
  assert.ok(/JSON\.stringify\(\{to, cc,/.test(src), 'ibSend must send cc to the server');
});

console.log(`\ntessa_reply_recipients: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
