// ============================================================================
// tests/test_tessa_board_command.js — "reply to all board".
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "okay says came in before update but cant we add — i want to be
// able to give tessa command to reply to all board."
//
// He was pushing back on an honest but useless answer. Reply-all rebuilt from a
// stored recipient list only works for mail polled after migration 380, and it
// copies whoever happened to be on that one message. "Reply to the board" is a
// better instruction: it means the BOARD, from the roster, regardless.
//
// To obey it she must know WHICH association, and getting that wrong sends an
// association's business to a different association's directors. So the rule is
// resolve-or-ask, never resolve-by-guess.
//
// THE DANGEROUS HALF is telling a recipient DIRECTION from a stated FACT. A
// first cut matched with a loose gap and fired on
//
//     "tell him the board meets on the 15th"
//
// which is Ed dictating a sentence for the body. It would have silently
// re-addressed his reply to five directors. Every negative case below is load-
// bearing.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const { wantsBoard, communityForThread, domainOf } = require('../lib/ea/tessa_thread_community');

let pass = 0; let fail = 0;
const results = [];
const check = (group, name, fn) => results.push({ group, name, fn });

// Communities are injected so these tests never depend on live data.
const COMMUNITIES = [
  { id: 'c1', name: 'Canyon Gate at Cinco Ranch' },
  { id: 'c2', name: 'Waterview Estates' },
  { id: 'c3', name: 'Drama Creek Estates' },
  { id: 'c4', name: 'Still Creek Ranch' },
  { id: 'c5', name: 'Lakes of Pine Forest' },
];
const listCommunities = async () => COMMUNITIES;
const noMembers = async () => null;
const deps = { listCommunities, communityForMember: noMembers };

// ---------------------------------------------------------------------------
check('It hears the direction', 'the phrasings Ed actually uses', () => {
  for (const s of [
    'reply to all board',
    'reply to the whole board',
    'copy the board',
    'send this to all board members',
    'let the board know we can do the 15th',
    'reply to the Canyon Gate board',
    'include the entire board',
    'cc the board',
  ]) assert.strictEqual(wantsBoard(s), true, `"${s}" must address the board`);
});

check('It hears the direction', 'a named community between verb and board still counts', () => {
  // This regressed once: the gap only allowed articles and prepositions, so
  // naming the community broke the very phrase that names it unambiguously.
  assert.strictEqual(wantsBoard('reply to the Canyon Gate board'), true);
  assert.strictEqual(wantsBoard('send to the lakes of pine forest board'), true);
});

// ---------------------------------------------------------------------------
check('It does NOT hijack a stated fact', 'a pronoun means somebody else is the recipient', () => {
  // The one that matters. Ed is dictating body text; the board is the SUBJECT
  // of his sentence, not the audience. Firing here silently re-addresses his
  // reply to five directors.
  for (const s of [
    'tell him the board meets on the 15th',
    'let her know the board decided already',
    'tell them the board will vote next week',
    'reply to him, the board is fine with it',
  ]) assert.strictEqual(wantsBoard(s), false, `"${s}" must NOT re-address the reply`);
});

check('It does NOT hijack a stated fact', 'the board as subject of a sentence', () => {
  for (const s of [
    'the board decided to go with option 2',
    'say the board approved it',
    'politely decline',
    'ask for their timeline',
    '',
  ]) assert.strictEqual(wantsBoard(s), false, `"${s}" must NOT address the board`);
});

// ---------------------------------------------------------------------------
check('It works out which association', 'a role alias in the domain is decisive', async () => {
  const r = await communityForThread({ from_email: 'director@canyongateatcincoranch.com', subject: 'Re: follow-up' }, deps);
  assert.ok(r.community, 'must resolve');
  assert.strictEqual(r.community.name, 'Canyon Gate at Cinco Ranch');
  assert.strictEqual(r.confident, true);
});

check('It works out which association', 'a board member on file identifies the thread', async () => {
  // The rescue case. "Contract deputy for 2027" opens "Hi Board" and then says
  // only "the MUD" and "the community" — nothing in the text names Waterview.
  // Alexis and Megan being on the roster is the only signal there is.
  const withMembers = {
    listCommunities,
    communityForMember: async (e) => (e === 'alexisfiloromo@gmail.com'
      ? { id: 'c2', name: 'Waterview Estates', member: 'Alexis Geissler' } : null),
  };
  const r = await communityForThread({
    from_email: 'alexisfiloromo@gmail.com',
    subject: 'Re: Contract deputy for 2027, decision needed before August 28th',
    body_full: 'Hi Board, the MUD will be providing less money this year and the community has a big decision.',
  }, withMembers);
  assert.ok(r.community, 'a known board member must identify the community');
  assert.strictEqual(r.community.name, 'Waterview Estates');
  assert.strictEqual(r.confident, true);
});

check('It works out which association', 'one distinctive word is enough in text', async () => {
  // Mail about Waterview Estates says "Waterview", never the full legal name.
  // Requiring every word resolved the whole thread to nothing.
  const r = await communityForThread({ from_email: 'someone@gmail.com', subject: 'Waterview pool hours' }, deps);
  assert.ok(r.community, '"Waterview" alone must resolve');
  assert.strictEqual(r.community.name, 'Waterview Estates');
});

check('It works out which association', 'a body mention resolves but is flagged unconfident', async () => {
  const r = await communityForThread({
    from_email: 'kot253@hotmail.com', subject: 'Re: follow-up',
    body_full: 'I am on the Canyon Gate at Cinco Ranch board and can make that work.',
  }, deps);
  assert.ok(r.community);
  assert.strictEqual(r.confident, false, 'a passing mention must be flagged for a look');
});

// ---------------------------------------------------------------------------
check('It asks rather than guesses', 'a shared word resolves to nothing', async () => {
  // "creek" belongs to Drama Creek AND Still Creek. Picking one is how mail
  // reaches the wrong association.
  const r = await communityForThread({ from_email: 'x@gmail.com', subject: 'creek fence question' }, deps);
  assert.strictEqual(r.community, null, 'an ambiguous word must resolve to nobody');
});

check('It asks rather than guesses', 'two communities named means neither', async () => {
  const r = await communityForThread({
    from_email: 'x@gmail.com',
    subject: 'Waterview Estates and Canyon Gate at Cinco Ranch joint meeting',
  }, deps);
  assert.strictEqual(r.community, null);
});

check('It asks rather than guesses', 'a generic mailbox says nothing', async () => {
  const r = await communityForThread({ from_email: 'someone@gmail.com', subject: 'quick question' }, deps);
  assert.strictEqual(r.community, null, 'gmail must not be treated as a community domain');
});

check('It asks rather than guesses', 'our own domain says nothing', async () => {
  // Every community's mail comes through bedrocktx.com.
  assert.strictEqual(domainOf('egojara@bedrocktx.com'), 'bedrocktx.com');
  const r = await communityForThread({ from_email: 'egojara@bedrocktx.com', subject: 'Meeting' }, deps);
  assert.strictEqual(r.community, null);
});

check('It asks rather than guesses', 'empty input does not crash', async () => {
  const r = await communityForThread({}, deps);
  assert.strictEqual(r.community, null);
  const r2 = await communityForThread(null, deps);
  assert.strictEqual(r2.community, null);
});

// ---------------------------------------------------------------------------
check('The wiring is connected', 'the endpoint resolves the group', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'tessa.js'), 'utf8');
  assert.ok(/wantsBoard\(instruction\)/.test(src), '/handle must check for a board direction');
  assert.ok(/resolveBoardGroup/.test(src), 'and resolve it through the shared board resolver');
});

check('The wiring is connected', 'the screen re-addresses and says so', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'tessa.html'), 'utf8');
  assert.ok(/j\.group/.test(src), 'the client must read the resolved group');
  assert.ok(/Addressed to the/.test(src), 'and state who it re-addressed to — a silent change of five recipients is the failure mode');
});

// ---------------------------------------------------------------------------
(async () => {
  let group = null;
  for (const t of results) {
    if (t.group !== group) { group = t.group; console.log('\n' + group); }
    try { await t.fn(); pass++; console.log('  ✓ ' + t.name); }
    catch (e) { fail++; console.log('  ✗ ' + t.name + '\n      ' + e.message); }
  }
  console.log(`\ntessa_board_command: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
