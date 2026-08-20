// ============================================================================
// tests/test_persona_routing.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Mail sent to a teammate's OWN mailbox belongs to that teammate.
//
// Obvious, and it was not true. lib/email/persona.js had mailbox rules for
// Tessa, Ed, Miranda, Annie and Claire, and none for Amanda, Kat, Paige or
// Reese. Those four only ever received a message when its CONTENT matched a
// keyword further down the function, so their own inboxes fell through to
// Claire.
//
// What that looked like in practice: Martha emailed Amanda directly asking for
// help with a board reply. Amanda read the thread and wrote a good answer. It
// was filed under Claire. Amanda's queue showed exactly one email, a mailing
// address update caught by the roster keyword, and the reply she had actually
// written was not in her queue at all.
//
// Ed found it by looking at the screen and saying "i dont see anything from
// amanda to be sent out that relates to a response." A drafted reply nobody can
// find is indistinguishable from one that was never written, and every check we
// had was green, because the draft WAS produced and WAS saved. Nothing failed.
// It was just filed under the wrong name.
//
// So the routing gets a test of its own: every persona with a mailbox routes
// its own mail to itself, and adding a teammate without a rule fails here
// rather than quietly emptying their queue.
//
//   node tests/test_persona_routing.js
// ============================================================================
const assert = require('assert');
const graphSend = require('../lib/email/graph_send');
const { personaForMessage } = require('../lib/email/persona');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// Every teammate who owns a mailbox, and the persona their mail must carry.
const OWNED = [
  ['amanda',  'AMANDA_MAILBOX'],
  ['kat',     'KAT_MAILBOX'],
  ['paige',   'PAIGE_MAILBOX'],
  ['reese',   'REESE_MAILBOX'],
  ['miranda', 'MIRANDA_MAILBOX'],
  ['annie',   'ANNIE_MAILBOX'],
  ['emma',    'EMMA_MAILBOX'],
  ['claire',  'CLAIRE_MAILBOX'],
  ['tessa',   'TESSA_MAILBOX'],
];

console.log('\nA teammate owns the mail sent to their own box');

for (const [persona, envKey] of OWNED) {
  const mailbox = graphSend[envKey];
  check(persona + ' owns ' + (mailbox || '(' + envKey + ' unset)'), () => {
    assert.ok(mailbox, envKey + ' is not set, so nothing can route to ' + persona);
    // A plain internal note with no keyword in it. This is the case that broke:
    // routing must come from the MAILBOX, not from what the message happens to
    // say.
    const got = personaForMessage({
      mailbox,
      subject: 'Quick question',
      sender_email: 'mbravo@bedrocktx.com',
      sender_name: 'Martha Bravo',
      classification: 'internal',
      body_preview: 'Hi, can you take a look at this when you get a chance.',
      extracted: {},
    });
    assert.strictEqual(got, persona,
      mailbox + ' routed to "' + got + '" instead of "' + persona + '"');
  });
}

console.log('\nThe exact message that exposed it');

check('Martha asking Amanda for help lands with Amanda', () => {
  const got = personaForMessage({
    mailbox: graphSend.AMANDA_MAILBOX,
    subject: 'Fw: Vendor Recommendation-Amenity Field Electrical & Drainage Repairs |Urgent| Please Vote',
    sender_email: 'mbravo@bedrocktx.com',
    sender_name: 'Martha Bravo',
    classification: 'internal',
    body_preview: 'Hi Amanda, Please help me with a response to Alexis.',
    extracted: {},
  });
  assert.strictEqual(got, 'amanda', 'routed to ' + got);
});

check('a vendor writing to a specialist does not get pulled to AP', () => {
  // The vendor branch runs on classification and would otherwise claim this.
  const got = personaForMessage({
    mailbox: graphSend.AMANDA_MAILBOX,
    subject: 'Invoice 43444',
    sender_email: 'billing@superiorlawncare.com',
    classification: 'vendor_financial',
    resolved_vendor_id: 'some-vendor-id',
    body_preview: 'Please remit payment.',
    extracted: {},
  });
  assert.strictEqual(got, 'amanda', 'mail addressed to Amanda routed to ' + got);
});

console.log('\nNobody new is left without a rule');

check('every persona with a *_MAILBOX constant has a routing rule', () => {
  const declared = Object.keys(graphSend)
    .filter((k) => /_MAILBOX$/.test(k) && graphSend[k])
    // ED_MAILBOX is Tessa's ghostwriting box, BILLING_MAILBOX is a pipeline
    // rather than a person; both are covered elsewhere.
    .filter((k) => !['ED_MAILBOX', 'BILLING_MAILBOX'].includes(k));
  const covered = new Set(OWNED.map((o) => o[1]));
  const missing = declared.filter((k) => !covered.has(k));
  assert.deepStrictEqual(missing, [],
    'these mailboxes have no routing assertion, so their queue could be silently empty: ' + missing.join(', '));
});

if (!process.exitCode) console.log('\n✓ Persona routing: all ' + passed + ' checks passed.\n');
else console.error('\nPersona routing: FAILURES above.\n');
