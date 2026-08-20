// ============================================================================
// tests/test_signature_identity.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Everyone signs their email as the person the roster says they are.
//
// Ed asked a simple question — "do all of these have their full signature like
// amanda that says sr community manager?" — and the answer was no, in four
// different ways, none of them visible from inside any one file:
//
//   * Kat signed "Katherine Reed". The roster, the team board and every other
//     surface call her Kat Reed. A board member meets Kat on the platform and
//     gets email from Katherine.
//   * Emma's title was the bare word "Accounting", not a role, and hers was the
//     only signature that never named the community, because the send path
//     called her builder without passing one. A vendor bill about Waterview
//     never said Waterview.
//   * Reese had no phone number, on the one lane where the caller is a title
//     company chasing an estoppel against a closing date.
//   * There were ELEVEN copies of who works here: nine signature files, the
//     drafter's own persona table, and the roster that was supposed to be the
//     source of truth.
//
// roster.js was created for exactly this and its header says it: "A
// hand-mirrored list is not a source of truth, it is a promise to remember."
// The signature files were written before it and never folded in.
//
// So the agreement is asserted rather than remembered.
//
//   node tests/test_signature_identity.js
// ============================================================================
const assert = require('assert');
const { ROSTER } = require('../lib/team/roster');
const { identity, buildPersonaEmail } = require('../lib/email/persona_signature');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// The nine who send email. Isabella routes to Claire's queue and General is a
// bucket, so neither signs anything.
const SIGNERS = ['claire', 'emma', 'kat', 'annie', 'miranda', 'amanda', 'reese', 'paige', 'tessa'];

// Rendered signature text, tags stripped, the way a recipient reads it.
function renderText(persona, community) {
  const { html } = buildPersonaEmail(persona, 'Body.', community);
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|td|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
}

console.log('\nEvery signer matches the roster');

for (const persona of SIGNERS) {
  const m = ROSTER.find((r) => r.persona === persona);
  check(persona + ' signs as the roster name and title', () => {
    assert.ok(m, 'no roster entry for ' + persona);
    assert.ok(m.signature_title, persona + ' has no signature_title on the roster');
    const text = renderText(persona, 'Waterview');
    assert.ok(text.includes(m.name), persona + ' signature does not carry "' + m.name + '"');
    assert.ok(text.includes(m.signature_title), persona + ' signature does not carry "' + m.signature_title + '"');
    // identity() is what the drafter and the signature both read.
    const id = identity(persona);
    assert.strictEqual(id.name, m.name);
    assert.strictEqual(id.title, m.signature_title);
  });
}

console.log('\nThe four specific gaps Ed asked about');

check('Kat is Kat Reed, never Katherine Reed', () => {
  const text = renderText('kat', 'Waterview');
  assert.ok(text.includes('Kat Reed'), 'Kat does not sign as Kat Reed');
  assert.ok(!/Katherine Reed/.test(text), 'Kat is still signing as Katherine Reed');
});

check('Emma has a real job title, not a department word', () => {
  const m = ROSTER.find((r) => r.persona === 'emma');
  assert.notStrictEqual(m.signature_title, 'Accounting', 'Emma\'s title is still the bare word "Accounting"');
  assert.ok(/Accounts Payable/i.test(m.signature_title), 'Emma\'s title should name her lane: ' + m.signature_title);
});

check('every signer names the community when one is known', () => {
  for (const persona of SIGNERS) {
    // Tessa is Ed's private EA and is called without a community on purpose,
    // but must still render one when given one.
    const text = renderText(persona, 'Waterview');
    assert.ok(text.includes('Bedrock Association Management — Waterview'),
      persona + ' drops the community from the signature');
  }
});

check('everyone customer-facing carries a phone number', () => {
  for (const persona of SIGNERS) {
    const m = ROSTER.find((r) => r.persona === persona);
    // Tessa is owner-only and deliberately has no public number.
    if (persona === 'tessa') { assert.strictEqual(m.signature_phone, null); continue; }
    assert.ok(m.signature_phone, persona + ' has no phone on the roster');
    assert.ok(renderText(persona, 'Waterview').includes(m.signature_phone),
      persona + ' signature does not show the phone');
  }
});

console.log('\nStructure holds');

check('the soft AI mark is present and never leads', () => {
  for (const persona of SIGNERS) {
    const text = renderText(persona, 'Waterview');
    assert.ok(/Powered by Bedrock Intelligence/.test(text), persona + ' lost the Bedrock Intelligence line');
    // Ed's rule: present, not announced. It belongs under the signature, never
    // above the name.
    assert.ok(text.indexOf('Powered by Bedrock Intelligence') > text.indexOf('Bedrock Association Management'),
      persona + ' leads with the AI mark instead of closing with it');
  }
});

check('the inline logo is attached for every signer', () => {
  for (const persona of SIGNERS) {
    const { attachments } = buildPersonaEmail(persona, 'Body.', 'Waterview');
    assert.ok(attachments.length && attachments[0].contentId === 'bedrocklogo',
      persona + ' is missing the inline logo attachment');
  }
});

check('a persona with no roster entry fails loudly', () => {
  assert.throws(() => identity('nobody'), /no roster entry/,
    'an unknown persona should throw, not render a nameless signature');
});

check('adding a teammate without a signature_title fails here', () => {
  const emailers = ROSTER.filter((r) => r.self_mailbox && r.email_board !== false);
  const missing = emailers.filter((r) => !r.signature_title).map((r) => r.persona);
  assert.deepStrictEqual(missing, [],
    'these teammates can send email but have no signature_title: ' + missing.join(', '));
});

if (!process.exitCode) console.log('\n✓ Signature identity: all ' + passed + ' checks passed.\n');
else console.error('\nSignature identity: FAILURES above.\n');
