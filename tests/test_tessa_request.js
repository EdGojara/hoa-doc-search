// ============================================================================
// tests/test_tessa_request.js — Tessa's "just tell her what you want" box.
// ----------------------------------------------------------------------------
// Ed 2026-08-21 asked for one box he can talk to: "tessa please send email to
// canyon gate board and ask if they want us to set up a follow up virtual
// meeting with security company the one with Grant as the contact."
//
// Three things must never regress, each of which already went wrong once:
//
//  1. CONTEXT FIELD NAMES. findContext read m.receivedDateTime /
//     m.conversationId / m.bodyPreview — the raw Graph names. searchMailbox
//     already maps those to received_at / conversation_id / preview, so every
//     read returned undefined: empty previews, a recency sort that did nothing,
//     and dedup falling through to message id. The draft still looked fine
//     because the contact book supplied the names, which is exactly how a
//     silent context failure hides. Same family as the never-destructure-data-
//     without-error scar in CLAUDE.md: the failure is a plausible answer.
//
//  2. NEVER INVENT AN ADDRESS. An unresolved reference comes back as a
//     question. Guessing a board distribution list puts confidential
//     association business in a stranger's inbox.
//
//  3. WHO WE ACTUALLY DEAL WITH. Ed: "yeah maybe not grant, need to find who
//     have been communicating with at that company." A company reference is
//     answered from correspondence, not from whichever name surfaced first.
// ============================================================================
require('dotenv').config();
const assert = require('assert');

const { parseGroupHint, tokens, matchCommunity } = require('../lib/ea/tessa_resolve');
const { findContext, resolveOne } = require('../lib/ea/tessa_request');

let passed = 0;
const results = [];
function check(group, name, fn) {
  results.push({ group, name, fn });
}
function ok(name) { passed++; console.log('  ✓ ' + name); }

// ---------------------------------------------------------------------------
check('Group references', 'recognises the shapes Ed actually says', async () => {
  assert.ok(parseGroupHint('canyon gate board'), '"canyon gate board"');
  assert.ok(parseGroupHint('the board at waterview'), '"the board at waterview"');
  assert.ok(parseGroupHint('Waterview board members'), '"Waterview board members"');
  assert.strictEqual(parseGroupHint('Grant Gerber'), null, 'a person is not a group');
  assert.strictEqual(parseGroupHint('Melody at New First'), null, 'a person at a company is not a group');
});

check('Group references', 'pulls the community out of the phrase', async () => {
  assert.strictEqual(parseGroupHint('canyon gate board').community, 'canyon gate');
  assert.strictEqual(parseGroupHint('the board at waterview').community, 'waterview');
  assert.strictEqual(parseGroupHint('board for Lakes of Pine Forest').community, 'Lakes of Pine Forest');
});

check('Group references', 'strips filler that carries no signal', async () => {
  assert.deepStrictEqual(tokens('Canyon Gate at Cinco Ranch'), ['canyon', 'gate', 'cinco', 'ranch']);
  assert.deepStrictEqual(tokens('the HOA board'), []);
});

// ---------------------------------------------------------------------------
check('Community matching', 'a partial name still finds the community', async () => {
  const r = await matchCommunity('canyon gate');
  assert.ok(r.community, 'expected a match for "canyon gate"');
  assert.match(r.community.name, /Canyon Gate/i);
});

check('Community matching', 'reports ambiguity instead of picking one', async () => {
  // "creek" is in more than one community name. Picking the first row here is
  // how mail lands at the wrong association.
  const r = await matchCommunity('creek');
  if (r.community) {
    // Only acceptable if exactly one community genuinely contains "creek".
    assert.ok(!r.ambiguous.length, 'a single match must report no ambiguity');
  } else {
    assert.ok(r.ambiguous.length > 1, 'no community picked means the alternatives must be listed');
  }
});

check('Community matching', 'a name we do not have resolves to nothing', async () => {
  const r = await matchCommunity('Nonexistent Shores Estates');
  assert.strictEqual(r.community, null);
  assert.strictEqual(r.ambiguous.length, 0);
});

// ---------------------------------------------------------------------------
// A stand-in for searchMailbox that returns the shape the REAL one returns.
// If findContext ever goes back to reading raw Graph field names, these come
// through as undefined and the assertions below fail.
function fakeMailbox(byTerm) {
  return async (mailbox, term) => ({
    messages: (byTerm[term] || []).map((m) => ({
      id: m.id,
      subject: m.subject,
      from: { name: m.fromName, email: m.fromEmail },
      to: m.to || [],
      cc: [],
      received_at: m.received,          // NOT receivedDateTime
      preview: m.preview,               // NOT bodyPreview
      conversation_id: m.conv,          // NOT conversationId
    })),
    query: term,
    count: (byTerm[term] || []).length,
  });
}

check('Reading Ed\'s mail', 'carries the preview and date through', async () => {
  const searchMailbox = fakeMailbox({
    ups: [{ id: '1', conv: 'c1', subject: 'Security Proposal', fromName: 'Haley', fromEmail: 'h@u.com', received: '2026-08-10T12:00:00Z', preview: 'Attached is the proposal for Canyon Gate.' }],
  });
  const { threads } = await findContext(['ups'], { searchMailbox, mailboxes: ['ed@x.com'] });
  assert.strictEqual(threads.length, 1);
  assert.strictEqual(threads[0].preview, 'Attached is the proposal for Canyon Gate.',
    'preview came back empty — findContext is reading the wrong field name again');
  assert.strictEqual(threads[0].received, '2026-08-10T12:00:00Z',
    'received came back null — findContext is reading the wrong field name again');
  assert.strictEqual(threads[0].from, 'Haley');
});

check('Reading Ed\'s mail', 'ranks the thread matching the most terms first', async () => {
  // The real failure: one broad term ("canyon gate") floods the list with budget
  // and ACC mail, burying the thread that matched three terms.
  const searchMailbox = fakeMailbox({
    'canyon gate': [
      { id: '1', conv: 'budget', subject: 'Budget | Canyon Gate', fromName: 'A', fromEmail: 'a@x.com', received: '2026-08-19T00:00:00Z', preview: 'budget' },
      { id: '2', conv: 'ups', subject: 'Security Proposal - UPS', fromName: 'B', fromEmail: 'b@x.com', received: '2026-08-10T00:00:00Z', preview: 'proposal' },
    ],
    'united protective': [
      { id: '3', conv: 'ups', subject: 'Security Proposal - UPS', fromName: 'B', fromEmail: 'b@x.com', received: '2026-08-10T00:00:00Z', preview: 'proposal' },
    ],
  });
  const { threads } = await findContext(['canyon gate', 'united protective'], { searchMailbox, mailboxes: ['ed@x.com'] });
  assert.strictEqual(threads[0].subject, 'Security Proposal - UPS',
    'the two-term thread must outrank the newer one-term thread');
  assert.strictEqual(threads[0].hits, 2);
  assert.strictEqual(threads.length, 2, 'the same conversation across two terms is one thread');
});

check('Reading Ed\'s mail', 'a blocked mailbox is reported, not silently empty', async () => {
  const searchMailbox = async () => { throw new Error('AppOnly AccessPolicy blocks this mailbox'); };
  const { threads, errors } = await findContext(['anything'], { searchMailbox, mailboxes: ['ed@x.com'] });
  assert.strictEqual(threads.length, 0);
  assert.strictEqual(errors.length, 1, 'a configuration failure must not read as "nothing on file"');
  assert.match(errors[0].error, /AccessPolicy/);
});

// ---------------------------------------------------------------------------
check('Never invent an address', 'an unknown person comes back as a question', async () => {
  const resolveRecipient = async (hint) => ({ best: null, matches: [], hint });
  const r = await resolveOne('Somebody We Have Never Emailed', resolveRecipient);
  assert.strictEqual(r.people.length, 0, 'no address may be produced for an unknown person');
  assert.ok(r.question, 'she has to ask');
  assert.strictEqual(r.reason, 'not_found');
});

check('Never invent an address', 'an unknown community board comes back as a question', async () => {
  const resolveRecipient = async (hint) => ({ best: null, matches: [], hint });
  const r = await resolveOne('Nonexistent Shores board', resolveRecipient);
  assert.strictEqual(r.people.length, 0);
  assert.ok(r.question, 'she has to ask rather than guess a distribution list');
});

check('Never invent an address', 'two candidates produce a choice, not a coin flip', async () => {
  const resolveRecipient = async (hint) => ({
    best: null,
    matches: [
      { name: 'Chris Lee', org: 'Acme', email: 'chris@acme.com', source: 'address_book' },
      { name: 'Chris Ng', org: 'Beta', email: 'chris@beta.com', source: 'address_book' },
    ],
    hint,
  });
  // No mail context, so there is no evidence to break the tie.
  const r = await resolveOne('Chris', resolveRecipient, null);
  assert.strictEqual(r.people.length, 0, 'without evidence she must not choose');
  assert.strictEqual(r.reason, 'ambiguous');
  assert.strictEqual(r.options.length, 2);
});

// ---------------------------------------------------------------------------
check('Who we deal with there', 'the recent correspondent wins, with evidence', async () => {
  // Ed 2026-08-21: he said "Grant", but Haley is who has actually been on the
  // thread. The mail decides.
  const resolveRecipient = async (hint) => ({
    best: null,
    matches: [
      { name: 'Grant Gerber', org: 'United Protective', email: 'grant@u.com', source: 'address_book' },
      { name: 'Haley Bellanger', org: 'United Protective', email: 'haley@u.com', source: 'address_book' },
    ],
    hint,
  });
  const searchMailbox = async () => ({
    messages: [
      { id: '1', conv: 'c1', subject: 'Proposal', from: { name: 'Haley', email: 'haley@u.com' }, to: [], cc: [], received_at: '2026-08-10T00:00:00Z', preview: 'x' },
      { id: '2', conv: 'c2', subject: 'Proposal', from: { name: 'Grant', email: 'grant@u.com' }, to: [], cc: [], received_at: '2026-08-06T00:00:00Z', preview: 'x' },
    ],
    count: 2,
  });
  const r = await resolveOne('united protective', resolveRecipient,
    { searchMailbox, mailboxes: ['ed@x.com'], terms: ['united protective'] });
  assert.strictEqual(r.people.length, 1);
  assert.strictEqual(r.people[0].email, 'haley@u.com', 'the more recent correspondent must win');
  assert.strictEqual(r.picked_by, 'correspondence');
  assert.ok(r.evidence, 'she has to show why she picked them');
  assert.strictEqual(r.alternates.length, 1, 'the other person stays visible so Ed can switch');
  assert.strictEqual(r.alternates[0].email, 'grant@u.com');
});

check('Who we deal with there', 'no correspondence means no invented ranking', async () => {
  const resolveRecipient = async (hint) => ({
    best: null,
    matches: [
      { name: 'A Person', org: 'Nowhere', email: 'a@n.com', source: 'address_book' },
      { name: 'B Person', org: 'Nowhere', email: 'b@n.com', source: 'address_book' },
    ],
    hint,
  });
  const searchMailbox = async () => ({ messages: [], count: 0 });
  const r = await resolveOne('nowhere inc', resolveRecipient,
    { searchMailbox, mailboxes: ['ed@x.com'], terms: ['nowhere inc'] });
  assert.strictEqual(r.people.length, 0, 'with no evidence she asks rather than ranks');
  assert.ok(r.question);
});

// ---------------------------------------------------------------------------
(async () => {
  let group = null;
  let failed = 0;
  for (const t of results) {
    if (t.group !== group) { group = t.group; console.log('\n' + group); }
    try { await t.fn(); ok(t.name); }
    catch (e) { failed++; console.log('  ✗ ' + t.name + '\n      ' + e.message); }
  }
  console.log('');
  if (failed) {
    console.log('✗ Tessa request: ' + failed + ' of ' + results.length + ' checks failed.');
    process.exit(1);
  }
  console.log('✓ Tessa request: all ' + passed + ' checks passed.');
})();
