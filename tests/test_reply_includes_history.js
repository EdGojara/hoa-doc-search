// ============================================================================
// tests/test_reply_includes_history.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// A reply carries the message it is replying to.
//
// Ed: "i know we've talked about this before but we should be including the
// email history." The "before" is why this is a test and not another fix.
//
// Martha wrote to Tessa and got back a two-line reply, subject "Re: (none)",
// with nothing underneath it. Two separate defects:
//
//   1. No quoted thread. Every persona send built body + signature and stopped.
//      A recipient gets an answer with no sign of what it answered, which is
//      unhelpful on a normal thread and actively damaging on the ones that get
//      forwarded to a vendor, a bank or an attorney.
//   2. "Re: (none)". The placeholder the SCREEN uses for a message with no
//      subject was being sent as though it were a subject.
//
// Both are the same underlying mistake: something written for a person looking
// at trustEd escaped into a message a customer reads.
//
//   node tests/test_reply_includes_history.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { quotedOriginal, replySubject } = require('../lib/email/quote_original');
const { buildPersonaEmail } = require('../lib/email/persona_signature');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

const ORIGINAL = {
  fromName: 'Martha Bravo',
  fromEmail: 'mbravo@bedrocktx.com',
  sentAt: '2026-08-20T21:50:00Z',
  to: 'Tessa McCall',
  subject: '',
  bodyText: 'Hi tessa, how are you doing today?',
};

console.log('\nThe quoted block');

check('carries who wrote it, when, and what they said', () => {
  const q = quotedOriginal(ORIGINAL);
  assert.ok(q.includes('Martha Bravo'), 'missing the sender');
  assert.ok(q.includes('mbravo@bedrocktx.com'), 'missing the address');
  assert.ok(q.includes('how are you doing today'), 'missing the message');
  // Central, the way a person in Texas reads it.
  assert.ok(/August 20, 2026/.test(q), 'missing a readable date: ' + q.slice(0, 200));
});

check('a message with no subject prints no Subject line', () => {
  const q = quotedOriginal(ORIGINAL);
  assert.ok(!/Subject:/.test(q), 'printed an empty Subject line');
  assert.ok(!/\(none\)|\(no subject\)/i.test(q), 'leaked a UI placeholder into the quote');
});

check('nothing to quote produces nothing, not an empty box', () => {
  assert.strictEqual(quotedOriginal({ ...ORIGINAL, bodyText: '' }), '');
  assert.strictEqual(quotedOriginal({ ...ORIGINAL, bodyText: '   ' }), '');
  assert.strictEqual(quotedOriginal(), '');
});

check('a long thread is trimmed and says so', () => {
  const q = quotedOriginal({ ...ORIGINAL, bodyText: 'x'.repeat(30000), maxChars: 1000 });
  assert.ok(q.includes('earlier messages trimmed'), 'trimmed silently');
});

check('the original is escaped, not injected', () => {
  const q = quotedOriginal({ ...ORIGINAL, bodyText: '<script>alert(1)</script>' });
  assert.ok(!q.includes('<script>'), 'raw HTML from an inbound message reached the output');
  assert.ok(q.includes('&lt;script&gt;'), 'expected the tags escaped');
});

console.log('\nThe reply subject');

check('never sends "Re: (none)"', () => {
  // The exact string that went to Martha.
  assert.strictEqual(replySubject('(none)'), 'Re:');
  assert.strictEqual(replySubject('(no subject)'), 'Re:');
  assert.strictEqual(replySubject(''), 'Re:');
  assert.strictEqual(replySubject(null), 'Re:');
});

check('does not double up an existing Re:', () => {
  assert.strictEqual(replySubject('Re: Staffing help'), 'Re: Staffing help');
  assert.strictEqual(replySubject('RE: Staffing help'), 'RE: Staffing help');
  assert.strictEqual(replySubject('Staffing help'), 'Re: Staffing help');
});

console.log('\nThe assembled email');

check('the quote lands BELOW the signature, where clients put it', () => {
  const q = quotedOriginal(ORIGINAL);
  const { html } = buildPersonaEmail('tessa', 'I am doing well, thanks!', null, q);
  const sig = html.indexOf('Tessa McCall');
  const quote = html.indexOf('how are you doing today');
  assert.ok(sig > -1 && quote > -1, 'signature or quote missing entirely');
  assert.ok(quote > sig, 'the quoted thread rendered above the signature');
});

check('a first-contact email still builds without a quote', () => {
  const { html } = buildPersonaEmail('tessa', 'Reaching out about the account.', null);
  assert.ok(html.includes('Tessa McCall'), 'signature missing');
  assert.ok(!/border-left:2px solid/.test(html), 'rendered an empty quote block');
});

console.log('\nEvery reply path passes one');

check('the persona reply chain and Tessa\'s inbox both quote', () => {
  const root = path.join(__dirname, '..');
  const triage = fs.readFileSync(path.join(root, 'api', 'email_triage.js'), 'utf8');
  const tessa = fs.readFileSync(path.join(root, 'api', 'tessa.js'), 'utf8');

  // Every teammate in the reply chain, not just the one that was reported.
  const builders = triage.match(/build[A-Z][a-zA-Z]+Email\(String\(body\)\.trim\(\), commName[^)]*\)/g) || [];
  assert.ok(builders.length >= 8, 'expected the full persona chain, found ' + builders.length);
  const bare = builders.filter((b) => !b.includes('quoted'));
  assert.deepStrictEqual(bare, [],
    'these persona replies send with no thread attached: ' + bare.join(', '));

  assert.ok(/buildTessaEmail\([^)]*quoted/.test(tessa),
    'Tessa\'s inbox reply sends with no thread attached');
  assert.ok(tessa.includes('replySubject('),
    'Tessa\'s inbox reply can still send a placeholder subject');
});

if (!process.exitCode) console.log('\n✓ Reply history: all ' + passed + ' checks passed.\n');
else console.error('\nReply history: FAILURES above.\n');
