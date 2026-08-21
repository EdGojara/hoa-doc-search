// ============================================================================
// tests/test_draft_attachments.js — the file an agent generated must survive.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "ok add that feature" — Paige offering a document she could
// not hand over.
//
// The generator was never missing. handleNominationRequest has always built the
// call-for-nominations PDF and returned it on `attachments`. graph_ingest stored
// the draft as
//
//     { subject, body, careful, status, persona, review_hint }
//
// and `attachments` is not in that list. Every PDF Paige ever generated was
// built, dropped one line later, and her reply still said "attached". That is
// why the honest wording had to be "I can generate one".
//
// Verified live end to end before shipping: 170kb PDF generated from the real
// Lakes of Pine Forest cycle, persisted, reloaded, byte-identical.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { safeName, mimeFor } = require('../lib/email/draft_attachments');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('\nThe draft keeps what it generated');
check('graph_ingest copies attachments onto the draft', () => {
  const s = src('lib/email/graph_ingest.js');
  assert.ok(/draft\.attachments = await persistDraftAttachments/.test(s),
    'the Paige branch must persist what the drafter returned — dropping it is the original bug');
});
check('one renderer for both paths', () => {
  // A reviewed replacement and a generated original must not drift into being
  // two different letters.
  const nom = src('lib/nominations/paige_nominations.js');
  const rev = src('lib/board_package/paige_doc_review.js');
  assert.ok(/async function buildCallForNominations/.test(nom), 'the renderer must be extracted');
  assert.ok(/buildCallForNominations,/.test(nom), 'and exported');
  assert.ok(/buildCallForNominations/.test(rev), 'the reviewer must use that same renderer');
});
check('the send path attaches them', () => {
  const s = src('api/email_triage.js');
  assert.ok(/loadDraftAttachments/.test(s), 'send must reload the generated files');
  assert.ok(/\(\(m\.extracted \|\| \{\}\)\.draft \|\| \{\}\)\.attachments/.test(s),
    'and read them from where the draft stored them');
});

console.log('\nBytes stay out of the row');
check('storage holds the file, the row holds a path', () => {
  // extracted is JSONB on email_messages, and the triage list selects it for
  // every message on screen. A base64 PDF in there is dragged along by every
  // read of that table.
  // Scope to persist only. loadDraftAttachments legitimately produces base64 —
  // that is its whole job at send time — so scanning the file as a whole tests
  // the wrong function.
  const s = src('lib/email/draft_attachments.js');
  const persist = s.slice(s.indexOf('async function persistDraftAttachments'), s.indexOf('async function loadDraftAttachments'));
  assert.ok(/\.upload\(path, buf/.test(persist), 'must upload the bytes to the documents bucket');
  assert.ok(/storage_path: path/.test(persist), 'and return a path');
  assert.ok(!/contentBytes/.test(persist), 'persist must not hand base64 back to the caller');
  assert.ok(!/base64/.test(persist), 'nothing base64 belongs in the descriptor that lands in JSONB');
});

console.log('\nIt fails toward sending, not toward silence');
check('a missing file skips rather than throwing', () => {
  // A reply that goes without its attachment is recoverable. A reply that does
  // not go at all, because a storage object vanished, is not.
  const s = src('lib/email/draft_attachments.js');
  const load = s.slice(s.indexOf('async function loadDraftAttachments'));
  assert.ok(/continue;/.test(load), 'a missing object must be skipped');
  assert.ok(/console\.warn/.test(load), 'and logged, never silent');
});
check('the send path warns when a file did not make it', () => {
  const s = src('api/email_triage.js');
  assert.ok(/generated attachments: \$\{files\.length\}\/\$\{generated\.length\}/.test(s),
    'a partial attach must be visible in the logs, not silently fewer files');
});
check('nothing is generated at send time', () => {
  // Only what was produced at draft time and reviewed by the person clicking
  // send. Generating fresh here would mail a document nobody looked at.
  const s = src('api/email_triage.js');
  const block = s.slice(s.indexOf('Files the AGENT generated'), s.indexOf('Documents the operator picked'));
  assert.ok(!/buildCallForNominations|letterPdf|renderCall/.test(block),
    'the send path must attach, never generate');
});

console.log('\nShe only claims an attachment she has');
check('the reviewer words the reply from what came back', () => {
  const s = src('lib/board_package/paige_doc_review.js');
  assert.ok(/} else if \(replacement\.length\) \{/.test(s),
    '"I\'ve attached" must be behind a check that something was actually built');
  assert.ok(/I can generate a replacement/.test(s),
    'and there must be a fallback wording for when the build failed');
});
check('a correct document gets no replacement at all', () => {
  // Handing Martha a replacement for a document that is right on every
  // checkable point is wrong, and the fastest way to get an assistant ignored.
  const s = src('lib/board_package/paige_doc_review.js');
  assert.ok(/if \(blocking\.length \|\| checks\.length\) \{[\s\S]{0,400}buildCallForNominations/.test(s),
    'the replacement must only be built when something was found');
});

console.log('\nNames and types');
check('filenames are made safe for a mail header', () => {
  assert.strictEqual(safeName('Call for Nominations LOPF.2026.docx'), 'Call for Nominations LOPF.2026.docx');
  assert.ok(!/[/\\]/.test(safeName('../../etc/passwd')), 'path separators must not survive');
  assert.strictEqual(safeName('', 'fallback.pdf'), 'fallback.pdf');
});
check('mime types follow the extension', () => {
  assert.strictEqual(mimeFor('x.pdf'), 'application/pdf');
  assert.strictEqual(mimeFor('x.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.strictEqual(mimeFor('x.unknown'), 'application/octet-stream');
});

console.log(`\ndraft_attachments: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
