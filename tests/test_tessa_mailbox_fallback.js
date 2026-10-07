// ============================================================================
// tests/test_tessa_mailbox_fallback.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// When Tessa's address book has nobody for a name, she looks in recent mail
// before saying "not on file": exactly one credible person -> use them and save
// them; several -> ask which; none -> ask for the address. Every existing
// protection (known identities, group words, board groups, an address Ed gave,
// the address book) still runs first and is never bypassed.
//
// Scar: "Email Alishba Khan…" failed with "I do not have anyone on file" although
// her Indeed message ("New Message from Alishba Khan - Part-Time Community
// Operations Assistant") was in Ed's mailbox. (Sanitized relay address below.)
//
//   node tests/test_tessa_mailbox_fallback.js
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';   // module load only; nothing here touches a DB
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/ea/tessa_request');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}
const ED = 'egojara@bedrocktx.com'; const TESSA = 'tessa@bedrocktx.com';
const RELAY = 'conversation-alishbakhan-xxxx@indeedemail.com';
const msg = (from, to = [ED], extra = {}) => ({ subject: 'New Message from Alishba Khan - Part-Time Community Operations Assistant', from, to: to.map((e) => (typeof e === 'string' ? { name: 'Ed Gojara', email: e } : e)), cc: [], received_at: '2026-10-04T15:00:00Z', ...extra });

console.log('\nName matching (display name, word for word)');
check('first name or full name matches the display name; partial words and domains never do', () => {
  assert.strictEqual(T.nameMatchesHint('Alishba Khan', 'Alishba'), true);
  assert.strictEqual(T.nameMatchesHint('Alishba Khan', 'Alishba Khan'), true);
  assert.strictEqual(T.nameMatchesHint('Alishba Khan', 'alishba khan'), true);
  assert.strictEqual(T.nameMatchesHint('Ed Hyde', 'Ed'), true);
  assert.strictEqual(T.nameMatchesHint('Bedrock Team', 'Ed'), false, 'the "ed" in Bedrock is not Ed');
  assert.strictEqual(T.nameMatchesHint('Alishba Khan', 'Alish'), false, 'no partial words');
  assert.strictEqual(T.nameMatchesHint(null, 'Alishba'), false, 'no display name, no match (the address is never matched)');
});

console.log('\nCandidates from mail');
check('one person, deduped across messages, with evidence; our own mailboxes and automated senders never count', () => {
  const msgs = [
    msg({ name: 'Alishba Khan', email: RELAY }),
    msg({ name: 'Alishba Khan', email: RELAY }, [ED], { received_at: '2026-10-05T12:00:00Z', subject: 'Re: interview' }),
    msg({ name: 'Ed Gojara', email: ED }, [{ name: 'Alishba Khan', email: RELAY }]),
    msg({ name: 'Alishba Notifications', email: 'no-reply@indeed.com' }),
  ];
  const c = T.mailboxCandidates('Alishba', msgs, [ED, TESSA]);
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual([c[0].email, c[0].messages, c[0].subject], [RELAY, 3, 'Re: interview']);
});
check('two different people with the name are both returned (so Tessa asks)', () => {
  const c = T.mailboxCandidates('Alishba', [msg({ name: 'Alishba Khan', email: RELAY }), msg({ name: 'Alishba Rahman', email: 'arahman@example.com' })], [ED]);
  assert.strictEqual(c.length, 2);
});

console.log('\nresolveOne: the fallback runs only when nobody is found, and never guesses');
const noBook = async () => ({ best: null, matches: [] });
const mailCtx = (messages) => ({ mailboxes: [ED, TESSA], searchMailbox: async (mb) => ({ messages: mb === ED ? messages : [] }) });
check('address book empty + exactly one person in mail -> use them, save them, say where she found them', async () => {
  const r = await T.resolveOne('Alishba', noBook, mailCtx([msg({ name: 'Alishba Khan', email: RELAY })]));
  assert.deepStrictEqual(r.people.map((p) => [p.name, p.email, p.source]), [['Alishba Khan', RELAY, 'mailbox_history']]);
  assert.strictEqual(r.picked_by, 'mailbox_history');
  assert.deepStrictEqual(r.save_contact, { name: 'Alishba Khan', email: RELAY });
  assert.match(r.evidence, /Found Alishba Khan .* in your mail \("New Message from Alishba Khan/);
  assert.strictEqual(r.question, null);
});
check('several people in mail -> a question with the options, nobody picked', async () => {
  const r = await T.resolveOne('Alishba', noBook, mailCtx([msg({ name: 'Alishba Khan', email: RELAY }), msg({ name: 'Alishba Rahman', email: 'arahman@example.com' })]));
  assert.strictEqual(r.people.length, 0);
  assert.match(r.question, /more than one "Alishba"/);
  assert.strictEqual(r.options.length, 2);
});
check('nobody in mail either -> ask for the email address', async () => {
  const r = await T.resolveOne('Alishba', noBook, mailCtx([]));
  assert.strictEqual(r.people.length, 0);
  assert.match(r.question, /could not find them in your recent mail\. What is their email address\?/);
});
check('an address-book match wins; mail is not even searched', async () => {
  let searched = false;
  const r = await T.resolveOne('Alishba', async () => ({ best: { name: 'Alishba Khan', email: 'alishba@example.com', source: 'address_book' }, matches: [] }),
    { mailboxes: [ED], searchMailbox: async () => { searched = true; return { messages: [] }; } });
  assert.strictEqual(r.people[0].email, 'alishba@example.com');
  assert.strictEqual(searched, false);
});
check('an address Ed gave wins over mail', async () => {
  const r = await T.resolveOne('Alishba Khan', noBook, mailCtx([msg({ name: 'Alishba Khan', email: RELAY })]), { 'alishba khan': 'given@example.com' });
  assert.strictEqual(r.people[0].email, 'given@example.com');
});
check('a group word ("staff") never falls through to a mail search for a person', async () => {
  let searched = false;
  const r = await T.resolveOne('staff', noBook, { mailboxes: [ED], searchMailbox: async () => { searched = true; return { messages: [msg({ name: 'Stafford Beck', email: 'sbeck@vendor.com' })] }; } });
  assert.ok(r.kind === 'group');
  assert.strictEqual(searched, false);
});
check('no mailboxes configured -> the original "not on file" behavior, no search', async () => {
  const r = await T.resolveOne('Alishba', noBook, null);
  assert.match(r.question, /I do not have anyone on file for "Alishba"/);
});

console.log('\nWiring');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_request.js'), 'utf8');
check('a person found in mail is saved to the address book (via create_contacts) and the drafter is told who they are', () => {
  assert.match(src, /if \(r\.save_contact && !list\.some/);
  assert.match(src, /r\.picked_by === 'mailbox_history' && r\.evidence/);
});
check('the mail fallback sits after the address-book lookup and only when it found nobody', () => {
  const book = src.indexOf('const r = await resolveRecipient(hint);'); const fb = src.indexOf('const mh = await resolveFromMailbox(hint, mailCtx);');
  assert.ok(book > 0 && fb > book);
  assert.match(src.slice(fb - 200, fb), /if \(!matches\.length\) \{/);
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
