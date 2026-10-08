// ============================================================================
// tests/test_tessa_bounced_address.js  (Ed 2026-10-07)
// ----------------------------------------------------------------------------
// SCAR (Nicole Hill): Tessa's book held "Nicole Hill" <nicoleholtzhiII@aol.com>,
// a hand-typed address with capital I's for l's. The first phone-interview email
// to it bounced ("552 ... mailbox not found"), Tessa resent to
// nicoleholtzhill@aol.com, and Nicole replied from that address. The next day
// "Confirmed: Phone Interview Tomorrow at 3:00 PM" went to the typo again and
// bounced again: the resolver matched the name to the row and knew nothing about
// the bounce or the reply.
//
// Ed's regression, step by step, with the real NDR wording:
//   1. Nicole stored with the bad address
//   2. a send bounces
//   3. Nicole later replies from the correct address
//   4. Tessa schedules / confirms another interview
//   5. the recipient is the corrected address ONLY
// Plus the rules around it: the old address is kept in history, a bounced
// address is never used again unless a human restores it, several plausible
// replacements are a question (never a guess), a soft bounce is not a bounce,
// and recent two-way correspondence ranks first.
// ============================================================================
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || undefined, quiet: true });
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';   // module-load only; nothing here calls the database
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const AS = require('../lib/ea/address_status');
const { runRequest } = require('../lib/ea/tessa_request');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const TESSA = 'tessa@bedrocktx.com'; const ED = 'egojara@bedrocktx.com';
const BAD = 'nicoleholtzhiII@aol.com'; const GOOD = 'nicoleholtzhill@aol.com';
const SUBJ = 'Phone Interview - Community Operations Assistant Position';

// The mailbox, as Graph search returns it (graph_search shape).
const firstSendGood = { id: 'm-1006', subject: SUBJ, from: { email: TESSA, name: 'Tessa McCall' }, to: [{ email: GOOD, name: GOOD }], received_at: '2026-10-06T12:30:47Z', preview: 'Hi Nicole, Thanks for your interest...' };
const sendBad = { id: 'm-bad', subject: SUBJ, from: { email: TESSA, name: 'Tessa McCall' }, to: [{ email: BAD.toLowerCase(), name: 'Nicole Hill' }], received_at: '2026-10-07T01:13:40Z', preview: 'Hi Nicole, Thanks for your interest...' };
const ndr = { id: 'ndr-1', subject: 'Undeliverable: ' + SUBJ, from: { email: 'MAILER-DAEMON@server565.appriver.com'.toLowerCase(), name: 'Mail Delivery Subsystem' }, to: [{ email: BAD.toLowerCase(), name: BAD }], received_at: '2026-10-07T01:14:46Z',
  preview: "Failed to deliver to 'nicoleholtzhiII@aol.com' SMTP module(domain aol.com) reports: message text rejected by mx-aol.mail.gm0.yahoodns.net: 552 1 Requested mail action aborted, mailbox not found" };
const resend = { id: 'm-resend', subject: SUBJ, from: { email: TESSA, name: 'Tessa McCall' }, to: [{ email: GOOD, name: GOOD }], received_at: '2026-10-07T01:30:49Z', preview: "Hi Nicole, ... We'd like to set up a quick phone interview" };
const reply = { id: 'm-reply', subject: 'Re: ' + SUBJ, from: { email: GOOD, name: GOOD }, to: [{ email: TESSA, name: 'Tessa McCall' }], received_at: '2026-10-07T12:14:49Z', preview: 'Good Morning I am available on Friday with exception of 10:30 to 11:00. Thank You Nicole Hill 832.701.3900' };

// Graph's $search, approximately: the term anywhere in subject / preview / parties.
function mailbox(messages) {
  return async (mb, term) => {
    const t = String(term).toLowerCase();
    return { messages: messages.filter((m) => [m.subject, m.preview, m.from && m.from.email, ...(m.to || []).map((x) => x.email)].join(' ').toLowerCase().includes(t)) };
  };
}

const parsed = (hint) => ({ action: 'email_and_meeting', to_hints: [hint], cc_hints: [], mention_hints: [], provided_emails: {}, create_contacts: [], search_terms: [], unclear: [],
  instruction: `Confirm the phone interview with ${hint}`, meeting: { direct_invite: true, date: 'friday', start_time: '3:00 PM', end_time: null, title: 'Phone interview', topic: null, message: null, wants_intro: false, location: null } });

// The address book, as api/tessa.js resolveRecipient reads it: by name, then the
// known delivery evidence applied (the same applyStatus the API uses).
function bookResolver(store) {
  return async (hint) => {
    const want = String(hint).toLowerCase();
    let cands = store.contacts.filter((c) => c.name.toLowerCase().includes(want) && c.email).map((c) => ({ name: c.name, email: c.email, source: 'address_book' }));
    for (const c of store.contacts.filter((x) => x.name.toLowerCase().includes(want) && !x.email && x.superseded_by_contact_id)) {
      const t = store.contacts.find((x) => x.id === c.superseded_by_contact_id); if (t) cands.push({ name: t.name, email: t.email, source: 'address_book' });
    }
    const evs = await store.events([...cands.map((c) => c.email), ...store.evs.filter((e) => e.kind === 'supersede').map((e) => e.related_email)]);
    const all = [...new Set([...cands.map((c) => c.email), ...evs.map((e) => e.email), ...evs.map((e) => e.related_email).filter(Boolean)])];
    cands = AS.applyStatus(cands, AS.statusMap(all, await store.events(all))).kept;
    return { best: cands.length === 1 ? cands[0] : null, matches: cands, hint };
  };
}

async function confirmNicole(store, messages) {
  const drafted = [];
  const out = await runRequest('Confirm Nicole Hill for a phone interview Friday at 3 PM.', {
    parser: async () => parsed('Nicole Hill'),
    resolveRecipient: bookResolver(store),
    searchMailbox: mailbox(messages), mailboxes: [ED, TESSA],
    addressStore: store, ownAddresses: [ED, TESSA],
    drafter: async (args) => { drafted.push(args); return { subject: 'Confirmed: Phone Interview Friday at 3:00 PM', body: 'Hi Nicole' }; },
  });
  return { out, drafted };
}

// ------------------------------------------------------------------ Ed's 5 steps
check('REGRESSION (Ed’s 5 steps): bad address stored, send bounces, Nicole replies from the right one, Tessa confirms -> corrected address ONLY', async () => {
  // 1. Nicole stored with the bad address.
  const store = AS.memoryStore({ contacts: [{ id: 'c-hill', name: 'Nicole Hill', email: BAD }] });
  // 2 + 3. The mailbox holds the bounce and, later, her reply from the correct address.
  const messages = [sendBad, ndr, resend, reply];
  // 4. Tessa schedules / confirms another interview.
  const { out } = await confirmNicole(store, messages);
  // 5. Expected recipient: the corrected address only.
  assert.deepStrictEqual(out.to.map((p) => p.email), [GOOD]);
  assert.ok(![...out.to, ...out.cc].some((p) => p.email.toLowerCase() === BAD.toLowerCase()), 'the bounced address is never a recipient');
  assert.deepStrictEqual(out.questions, [], 'nothing to ask: the evidence settles it');
  // The book now holds the corrected address as the default...
  assert.strictEqual(store.contacts[0].email, GOOD);
  // ...and the old one is preserved in history, with the evidence.
  assert.deepStrictEqual(store.history, [{ contact_id: 'c-hill', old_email: BAD, new_email: GOOD }]);
  const sup = store.evs.find((e) => e.kind === 'supersede');
  assert.deepStrictEqual([sup.email, sup.related_email, sup.detail.inbound_ref, sup.detail.link], [BAD.toLowerCase(), GOOD, 'm-reply', 'near_typo']);
  const st = AS.statusFromEvents(BAD, store.evs);
  assert.deepStrictEqual([st.bounced, st.superseded_by, st.bounce_count], [true, GOOD, 1]);
});

check('the second confirmation (the actual scar) also goes only to the corrected address, with no mailbox access at all', async () => {
  const store = AS.memoryStore({ contacts: [{ id: 'c-hill', name: 'Nicole Hill', email: BAD }] });
  await confirmNicole(store, [sendBad, ndr, resend, reply]);   // learns
  const { out } = await confirmNicole(store, []);               // Graph unavailable: evidence on file still governs
  assert.deepStrictEqual(out.to.map((p) => p.email), [GOOD]);
});

check('both rows on file (Nicole’s real book): the typo row points at "Nicole Holtzhill", email cleared, history kept', async () => {
  const store = AS.memoryStore({ contacts: [{ id: 'c-holtz', name: 'Nicole Holtzhill', email: GOOD }, { id: 'c-hill', name: 'Nicole Hill', email: BAD }] });
  const { out } = await confirmNicole(store, [firstSendGood, sendBad, ndr, resend, reply]);
  assert.deepStrictEqual(out.to.map((p) => p.email), [GOOD]);
  const hill = store.contacts.find((c) => c.id === 'c-hill');
  assert.deepStrictEqual([hill.email, hill.superseded_by_contact_id], [null, 'c-holtz']);
  assert.deepStrictEqual(store.history, [{ contact_id: 'c-hill', old_email: BAD, new_email: GOOD, merged_into_contact_id: 'c-holtz' }]);
  // Next time the book itself resolves "Nicole Hill" to the right person.
  const r = await bookResolver(store)('Nicole Hill');
  assert.deepStrictEqual(r.best && r.best.email, GOOD);
});

// ------------------------------------------------------------------ never revert
check('a bounced address with NO verified replacement is dropped and Tessa asks; it is never sent to', async () => {
  const store = AS.memoryStore({ contacts: [{ id: 'c-hill', name: 'Nicole Hill', email: BAD }] });
  const { out } = await confirmNicole(store, [sendBad, ndr]);   // no reply yet
  assert.deepStrictEqual(out.to, []);
  assert.strictEqual(out.questions.length, 1);
  // 01:14 UTC on Oct 7 is 8:14 PM on Oct 6 in Central, which is how Ed reads it.
  assert.strictEqual(out.questions[0].ask, "nicoleholtzhiii@aol.com bounced on Oct 6 (mailbox not found), and I don't have a working address for Nicole Hill yet. What's the right one?");
  assert.strictEqual(store.contacts[0].email, BAD, 'no evidence, no change to the book');
});

check('never reverts: re-adding / re-resolving the bounced address stays blocked until a HUMAN restores it', async () => {
  const store = AS.memoryStore({ contacts: [{ id: 'c-x', name: 'Dana Typo', email: 'dana@exampel.com' }] });
  await store.addEvents(AS.eventsFromMessages('dana@exampel.com', [{ ...ndr, id: 'ndr-d', preview: "Failed to deliver to 'dana@exampel.com' 550 5.1.1 user unknown" }], [TESSA]));
  assert.deepStrictEqual((await AS.bouncedAmong(['dana@exampel.com'], { store })).map((b) => b.email), ['dana@exampel.com']);
  // An inbound from the bounced address later does NOT un-bounce it on its own.
  await store.addEvents([{ email: 'dana@exampel.com', kind: 'inbound', message_ref: 'in-1', occurred_at: '2026-10-08T00:00:00Z' }]);
  assert.strictEqual(AS.statusFromEvents('dana@exampel.com', store.evs).bounced, true);
  await assert.rejects(() => store.restore('dana@exampel.com', 'system'), /must name the person/);
  await store.restore('dana@exampel.com', 'egojara@bedrocktx.com');
  assert.deepStrictEqual(await AS.bouncedAmong(['dana@exampel.com'], { store }), []);
  // A NEW bounce after the restore bounces it again.
  await store.addEvents([{ email: 'dana@exampel.com', kind: 'bounce', message_ref: 'ndr-later', occurred_at: '2099-01-01T00:00:00Z', detail: { reason: '550 user unknown' } }]);
  assert.strictEqual(AS.statusFromEvents('dana@exampel.com', store.evs).bounced, true);
});

check('a supersede is refused when the old address never bounced or the replacement has bounced too', async () => {
  const store = AS.memoryStore();
  await assert.rejects(() => store.supersede({ bad: 'a@x.com', good: 'b@x.com', message_ref: 'r', occurred_at: '2026-10-07T00:00:00Z' }), /no unrestored bounce/);
  await store.addEvents([{ email: 'a@x.com', kind: 'bounce', message_ref: 'n1', occurred_at: '2026-10-07T00:00:00Z' }, { email: 'b@x.com', kind: 'bounce', message_ref: 'n2', occurred_at: '2026-10-07T00:00:00Z' }]);
  await assert.rejects(() => store.supersede({ bad: 'a@x.com', good: 'b@x.com', message_ref: 'r', occurred_at: '2026-10-07T00:00:00Z' }), /bounced too/);
});

// ------------------------------------------------------------------ evidence rules
check('several plausible replacements = ambiguous: nothing is superseded, Tessa asks', () => {
  const st = AS.statusFromEvents(BAD, AS.eventsFromMessages(BAD, [ndr], [TESSA]));
  const other = 'nicoleholtzhil@aol.com';
  const msgs = [resend, reply, { ...resend, id: 'm-r2', to: [{ email: other }] }, { ...reply, id: 'm-rep2', from: { email: other, name: other } }];
  const r = AS.findReplacement({ bounced: BAD, status: st, messages: msgs, ownAddresses: [TESSA], contactNames: ['Nicole Hill'] });
  assert.deepStrictEqual(r && r.ambiguous && r.ambiguous.sort(), [GOOD, other].sort());
});

check('another applicant replying on the same subject is NOT Nicole (no typo link, no name link)', () => {
  const st = AS.statusFromEvents(BAD, AS.eventsFromMessages(BAD, [ndr], [TESSA]));
  const juan = 'jramsey@example.com';
  const msgs = [{ ...resend, id: 'm-j', to: [{ email: juan }] }, { ...reply, id: 'm-jr', from: { email: juan, name: 'Juanita Ramsey' } }];
  assert.strictEqual(AS.findReplacement({ bounced: BAD, status: st, messages: msgs, ownAddresses: [TESSA], contactNames: ['Nicole Hill'] }), null);
});

check('a reply that came BEFORE the bounce, or one we never wrote to, does not count', () => {
  const st = AS.statusFromEvents(BAD, AS.eventsFromMessages(BAD, [ndr], [TESSA]));
  const early = { ...reply, received_at: '2026-10-06T20:00:00Z' };
  assert.strictEqual(AS.findReplacement({ bounced: BAD, status: st, messages: [resend, early], ownAddresses: [TESSA] }), null);
  assert.strictEqual(AS.findReplacement({ bounced: BAD, status: st, messages: [reply], ownAddresses: [TESSA] }), null);
});

check('name link: an unrelated-looking address carrying the contact’s name supersedes', () => {
  const st = AS.statusFromEvents(BAD, AS.eventsFromMessages(BAD, [ndr], [TESSA]));
  const work = 'nhill@newjob.com';
  const msgs = [{ ...resend, id: 'm-w', to: [{ email: work }] }, { ...reply, id: 'm-wr', from: { email: work, name: 'Nicole Hill' } }];
  const r = AS.findReplacement({ bounced: BAD, status: st, messages: msgs, ownAddresses: [TESSA], contactNames: ['Nicole Hill'] });
  assert.deepStrictEqual([r.email, r.evidence.link], [work, 'name']);
});

check('NDR parsing: AppRiver / Exchange / Gmail hard bounces name the address; a full mailbox or delay is NOT a bounce', () => {
  const hard = AS.parseNdr(ndr, [TESSA]);
  assert.deepStrictEqual([hard.failed, hard.hard, hard.original_subject, hard.reason], [[BAD.toLowerCase()], true, SUBJ, '552 1 Requested mail action aborted, mailbox not found']);
  const exch = AS.parseNdr({ id: 'e', subject: 'Undeliverable: Hello', from: { email: 'postmaster@outlook.com', name: 'Microsoft Outlook' }, to: [{ email: TESSA }], preview: "Your message to bob@contoso.com couldn't be delivered. bob wasn't found at contoso.com. 550 5.1.10 RESOLVER.ADR.RecipientNotFound" }, [TESSA]);
  assert.deepStrictEqual([exch.failed, exch.hard], [['bob@contoso.com'], true]);
  const gm = AS.parseNdr({ id: 'g', subject: 'Delivery Status Notification (Failure)', from: { email: 'mailer-daemon@googlemail.com', name: 'Mail Delivery Subsystem' }, to: [{ email: TESSA }], preview: "Address not found. Your message wasn't delivered to sam@gmial.com because the address couldn't be found" }, [TESSA]);
  assert.ok(gm.failed.includes('sam@gmial.com') && gm.hard, JSON.stringify(gm));
  const full = AS.parseNdr({ id: 'f', subject: 'Delivery delayed: Hello', from: { email: 'postmaster@outlook.com', name: 'Microsoft Outlook' }, to: [{ email: TESSA }], preview: "Delivery to bob@contoso.com has been delayed. The recipient's mailbox is full. 452 4.2.2 will retry" }, [TESSA]);
  assert.ok(!full || !full.hard, 'soft');
  assert.deepStrictEqual(AS.eventsFromMessages('bob@contoso.com', [{ ...full, id: 'f', from: { email: 'postmaster@outlook.com', name: 'Microsoft Outlook' }, subject: 'Delivery delayed: Hello', preview: "Delivery to bob@contoso.com has been delayed. The recipient's mailbox is full. 452 4.2.2 will retry" }], [TESSA]), []);
  assert.strictEqual(AS.parseNdr(reply, [TESSA]), null, 'a person is not a bounce');
});

check('the same NDR seen twice (inbox poll + live lookup) is one event', async () => {
  const store = AS.memoryStore();
  const evs = AS.eventsFromMessages(BAD, [ndr], [TESSA]);
  await store.addEvents(evs); await store.addEvents(evs);
  assert.strictEqual(AS.statusFromEvents(BAD, store.evs).bounce_count, 1);
});

check('ranking: among several good addresses, the most recent two-way correspondent comes first; unknowns keep their order', () => {
  const st = AS.statusMap(['a@x.com', 'b@x.com', 'c@x.com'], [
    { email: 'b@x.com', kind: 'inbound', message_ref: '1', occurred_at: '2026-10-01T00:00:00Z' },
    { email: 'c@x.com', kind: 'inbound', message_ref: '2', occurred_at: '2026-10-05T00:00:00Z' },
  ]);
  const { kept } = AS.applyStatus([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }], st);
  assert.deepStrictEqual(kept.map((c) => c.email), ['c@x.com', 'b@x.com', 'a@x.com']);
  const none = AS.applyStatus([{ email: 'a@x.com' }, { email: 'd@x.com' }], {}).kept;
  assert.deepStrictEqual(none.map((c) => c.email), ['a@x.com', 'd@x.com']);
});

check('send-time guard names the bounce and the working address (the last line of defense)', async () => {
  const store = AS.memoryStore({ contacts: [{ id: 'c-hill', name: 'Nicole Hill', email: BAD }] });
  const list = await AS.bouncedAmong([BAD, 'ok@x.com'], { store, searchMailbox: mailbox([sendBad, ndr, resend, reply]), mailboxes: [TESSA], ownAddresses: [ED] });
  assert.deepStrictEqual(list.map((b) => [b.email, b.superseded_by]), [[BAD.toLowerCase(), GOOD]]);
  assert.ok(/nicoleholtzhiii@aol\.com bounced on Oct 6 \(mailbox not found\); use nicoleholtzhill@aol\.com, which they replied from\. Nothing was sent\./.test(AS.bouncedMessage(list)), AS.bouncedMessage(list));
});

check('wiring is in place: every Tessa send path checks for bounced recipients; the resolver and inbox record/apply evidence', () => {
  const fs = require('fs');
  const api = fs.readFileSync(require.resolve('../api/tessa.js'), 'utf8');
  assert.strictEqual((api.match(/await refuseBounced\(res,/g) || []).length, 5, '/send, /inbox/:id/send, /meeting, outbox email, outbox meeting');
  assert.ok(/AS\.applyStatus\(cands,/.test(api), 'resolveRecipient applies delivery evidence');
  assert.ok(/addressStore: require\('\.\.\/lib\/ea\/address_status'\)\.supabaseStore\(supabase\)/.test(api), '/request passes the store');
  assert.ok(/bouncedGate\(res, email, b, owner\)/.test(api) && /bouncedGate\(res, upd\.email, b, owner\)/.test(api), 'contact saves are gated');
  const inbox = fs.readFileSync(require.resolve('../lib/ea/tessa_inbox.js'), 'utf8');
  assert.ok(/AS\.parseNdr\(msg, own\)/.test(inbox), 'the inbox poll records bounces');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); pass++; console.log('PASS ', n); }
    catch (e) { fail++; console.log('FAIL ', n, '\n   ', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
