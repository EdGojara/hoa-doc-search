// ============================================================================
// tests/test_attachment_names_intent.js — what you attach is part of what you said.
// ----------------------------------------------------------------------------
// Ed 2026-08-21 ran a live test: "i just had martha send email to paige to test
// whether paige can prepare request for nomination form like we built", then
// clarified "actually i meant martha sent forms she prepared for paige to look
// at."
//
// Martha's email to paige@ said:
//
//     Annual meeting is coming up for Lakes of Pine Forest. One position is
//     open. Please create a board packet and help me create the timeline. I
//     also need to set up online voting.
//
// and attached:
//
//     Call for Nominations LOPF.2026.docx
//     Minutes of Annual Meeting LOPF.2025.pdf
//
// Paige replied with a generic board-package readiness report listing
//
//     • Prior open-session minutes — no finalized prior minutes on record
//
// while holding those minutes, attached to that same email.
//
// The cause was one line, and it was general rather than a Paige problem: every
// intent detector in the repo reads [subject, body, body_preview] and nothing
// else. Martha's body never types "minutes" or "nominations" — both words are
// in the FILENAMES, and no code path had ever looked at a filename. So the
// nominations path declined, the document path declined, and she fell through
// to the generic report.
//
// Filenames now travel with the email (metadata only — fetchAttachmentNames
// does not download file bodies) and every detector reads them.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { detectNominationIntent, extractStatedSeats } = require('../lib/nominations/paige_nominations');
const { detectBoardDocIntent } = require('../lib/board_package/doc_intake');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// Verbatim from the live test.
const BODY = 'Lakes of Pine Forest\nAnnual meeting is coming up for Lakes of Pine Forest. '
  + 'One position is open. Please create a board packet for and help me create the timeline. '
  + 'I also need to set up online voting.';
const NAMES = ['Call for Nominations LOPF.2026.docx', 'Minutes of Annual Meeting LOPF.2025.pdf'];
const WITH = BODY + '\n' + NAMES.join('\n');

console.log('\nMartha\'s real email');
check('the body alone gives nothing away', () => {
  // Not a bug in her writing — this is how people actually send documents.
  assert.strictEqual(/nominat/i.test(BODY), false, 'she never types "nominations"');
  assert.strictEqual(/minutes/i.test(BODY), false, 'she never types "minutes"');
});
check('so both detectors declined, and that is why Paige missed it', () => {
  assert.strictEqual(detectNominationIntent(BODY), false);
  assert.strictEqual(detectBoardDocIntent(BODY).wants, false);
});
check('with the filenames, the nomination request is obvious', () => {
  assert.strictEqual(detectNominationIntent(WITH), true,
    '"Call for Nominations LOPF.2026.docx" IS the request');
});
check('and so is the document she sent to be filed', () => {
  const d = detectBoardDocIntent(WITH);
  assert.strictEqual(d.wants, true);
  assert.strictEqual(d.docTypeHint, 'minutes');
});
check('the seat count still reads from her words', () => {
  assert.strictEqual(extractStatedSeats(WITH), 1, '"One position is open"');
});

console.log('\nThe plumbing is connected end to end');
check('ingest fetches the names', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.ok(/fetchAttachmentNames/.test(src), 'graph_ingest must fetch attachment names');
  assert.ok(/email\.attachment_names\s*=/.test(src), 'and put them on the email object');
});
check('names only — no file bodies downloaded for this', () => {
  // This runs on every message with an attachment, so it must stay metadata.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_attachments.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchAttachmentNames'), src.indexOf('async function fetchAllAttachmentBuffers'));
  assert.ok(/\$select=name,contentType,size/.test(fn), 'must $select metadata rather than pull contentBytes');
  assert.ok(!/contentBytes/.test(fn), 'must not read file bodies');
});
check('Paige reads them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_reply.js'), 'utf8');
  assert.ok(/attachment_names/.test(src), 'paige_reply must include filenames in its detector text');
});
check('the nominations handler reads them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nominations', 'paige_nominations.js'), 'utf8');
  assert.ok(/attachment_names/.test(src), 'handleNominationRequest must include filenames');
});

console.log('\nNoise stays out');
check('inline signature images are not treated as documents', () => {
  // Martha's mail also carried image.png — an inline signature logo. Feeding
  // "image001.png" to an intent detector is pure noise.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_attachments.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchAttachmentNames'), src.indexOf('async function fetchAllAttachmentBuffers'));
  assert.ok(/image\|logo\|signature\|outlook-/.test(fn), 'must filter inline images out by name');
});

console.log('\nShe does not ask for what the platform already holds');
check('an existing cycle supplies the meeting date', () => {
  // Normalise line endings first — this repo is CRLF and an exact-newline
  // match here silently fails on the anchor rather than on the behaviour.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nominations', 'paige_nominations.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const askIdx = src.indexOf('Paige: nominations request, no meeting date');
  const lookupIdx = src.indexOf("from('nomination_cycles')");
  assert.ok(askIdx > -1, 'the "no meeting date" ask should still exist as a last resort');
  assert.ok(lookupIdx > -1, 'the handler must look for an existing cycle');
  assert.ok(lookupIdx < askIdx,
    'the cycle lookup must run BEFORE asking staff for a date the platform already holds');
});

console.log(`\nattachment_names_intent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
