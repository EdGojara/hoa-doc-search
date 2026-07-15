// ============================================================================
// tests/test_forward_note_voice.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// A forward goes out FROM claire@bedrocktx.com, so the note is Claire's own
// words. It used to be written "as a Bedrock manager", which produced a note
// signed by Claire that talked about "Claire's drafted reply" — she referred to
// herself in the third person in her own email. Ed: "i want you to write in
// claires voice when she forwards it to team member she wouldnt refer to herself
// in the third person".
//
// Worse, it pointed at a draft that ISN'T THERE. Forwards stopped carrying the
// draft (Claire forwards precisely when she can't answer, so the draft is a
// non-answer that just adds noise) — but the note writer was still handed
// draft_body, so it told Martha to "review the drafted reply below" and sent her
// looking for something that didn't exist.
//
// Both of those are voice/copy bugs, which are exactly the kind that rot back in
// silently: nothing throws, the email just reads wrong to a human. Hence a test.
//
// Costs a few model calls. Run: npm run test:forward-note
// ============================================================================
require('dotenv').config({ override: true });
const { draftForwardNote } = require('../lib/email/compose_draft');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
};

const EMAIL = {
  subject: 'Re: Pool Access Request- 17702 Windsor Grove Ln',
  sender_name: 'Azalia Fuenmayor',
  ai_summary: 'Azalia Fuenmayor is following up on her request for a pool access card to be mailed to her address.',
};

(async () => {
  console.log('\n\x1b[1mClaire\'s forward note — voice\x1b[0m\n');
  if (!process.env.ANTHROPIC_API_KEY) { console.log('  (skipped — ANTHROPIC_API_KEY not set)\n'); return; }

  const cases = [
    ['no shorthand', ''],
    ['with shorthand', 'can she get a card mailed? check the roster'],
    // The trap: shorthand that says "Claire" back at her. She still must not
    // write about herself in the third person in her own email.
    ['shorthand that names Claire', 'did claire already answer this one?'],
  ];

  for (const [label, thoughts] of cases) {
    const { note } = await draftForwardNote({ thoughts, toName: 'Martha Bravo', email: EMAIL });
    console.log(`  \x1b[2m${label}: ${String(note).replace(/\n+/g, ' ').slice(0, 96)}…\x1b[0m`);
    // She is the sender. "Claire" in her own note = third person.
    check(`[${label}] does not refer to "Claire" in the third person`,
      !/\bclaire'?s?\b/i.test(note), note);
    // No draft is included in the forward, so the note must not point at one.
    check(`[${label}] does not point at a draft that isn't in the forward`,
      !/\bdraft(ed|s)?\b/i.test(note), note);
    check(`[${label}] opens with "Hi Martha,"`, /^\s*Hi Martha,/i.test(note), note);
    check(`[${label}] first person (says "I" or "my")`, /\b(I|I'm|my|me)\b/.test(note), note);
    check(`[${label}] no em-dashes`, !/—/.test(note), note);
    check(`[${label}] no sign-off (the signature is added separately)`,
      !/\b(thanks|regards|best|sincerely)\b[\s,]*$/i.test(String(note).trim()), note);
  }

  console.log('');
  if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
  else console.log('\x1b[32m\x1b[1m✓ Forward note voice: all checks passed.\x1b[0m\n');
})();
