#!/usr/bin/env node
// ============================================================================
// test_amanda_review.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// Guards Amanda's staff document review. Deterministic only: routing, document
// extraction, and the prompt guardrails. It does NOT call the model, because a
// per-run API call in npm test is slow, costs money, and flaps.
//
// THE TWO DEFECTS THIS EXISTS TO PREVENT, both real, both in the first draft
// this feature ever produced:
//
//   1. INVENTED PRAISE. It opened by congratulating Martha for writing
//      "ownership and maintenance responsibility was discussed" — wording she
//      had not written; it was the FIX being suggested. Six paragraphs later it
//      correctly flagged the sentence she actually wrote. One email, two
//      contradictory claims, and the contradiction sat in the part meant to
//      build a junior manager's confidence.
//   2. WRONG SIGNATURE. It signed off "Martha", the recipient's name.
//
// Both are prompt-level, so the prompt is what gets asserted.
//
//   node tests/test_amanda_review.js     # or: npm run test:amanda-review
// ============================================================================
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lib', 'community', 'amanda_review.js');
const src = fs.readFileSync(SRC, 'utf8');
const { classifyDocument, draftAmandaDocumentReview } = require(SRC);

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + '\n      ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\nAmanda staff document review\n');

check('the prompt forbids crediting words not in the document', () => {
  assert(/ACTUALLY IN THE DOCUMENT/i.test(src), 'no anti-invented-praise instruction');
  assert(/never praise a correction she has not made/i.test(src), 'missing the specific rule about praising an unmade fix');
});

check('the prompt pins the signature to Amanda', () => {
  assert(/sign off as "Amanda"/i.test(src), 'signature not pinned');
  assert(/Never sign\s+with the recipient's name/i.test(src), "missing the don't-sign-as-the-recipient rule");
});

check('internal tone rules hold: no AI line, no title block', () => {
  assert(/no mention of AI/i.test(src), 'internal mail must not disclose AI to a colleague');
  assert(/No title, no company, no AI mention/i.test(src), 'sign-off must stay bare');
});

check('it explains why rather than only correcting', () => {
  assert(/EXPLAIN WHY for every point/i.test(src), 'teaching instruction missing');
});

check('findings are ordered by consequence, not document order', () => {
  assert(/Order the problems by consequence/i.test(src), 'ordering instruction missing');
});

check('it must not manufacture findings on a clean document', () => {
  assert(/Do not manufacture findings/i.test(src), 'missing clean-document guard');
});

check('house voice: no em-dashes', () => {
  assert(/No em-dashes/i.test(src), 'em-dash rule missing');
});

console.log('\nRouting\n');

check('a homeowner emailing amanda@ is NOT treated as a review request', async () => {
  // Synchronous assertion on the guard itself: the staff-domain test must exist.
  assert(/STAFF_DOMAIN\s*=\s*\/@bedrocktx\\.com\$\/i/.test(src), 'staff-domain guard missing');
  assert(/not_staff_sender/.test(src), 'no early return for non-staff senders');
});

check('ingest runs document review BEFORE the homeowner-escalation path', () => {
  const ing = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  const review = ing.indexOf('draftAmandaDocumentReview');
  const escalate = ing.indexOf('draftAmandaReply');
  assert(review > -1, 'document review not wired into ingest');
  assert(escalate > -1, 'amanda escalation path missing');
  assert(review < escalate, 'escalation path runs first — minutes would be answered as a homeowner issue');
});

console.log('\nDocument classification\n');

check('minutes are recognised from the filename', () => {
  assert(classifyDocument({ filename: 'LOPF Minutes August 2026.docx' }) === 'minutes', 'not classified as minutes');
});
check('a call for nominations is recognised', () => {
  assert(classifyDocument({ filename: 'Call for Nominations LOPF.2026.docx' }) === 'nominations', 'not classified');
});
check('an unknown document still gets a review rather than silence', () => {
  assert(classifyDocument({ filename: 'something.docx' }) === 'general', 'should fall back to general');
});

console.log('\nShared standards\n');

check('reviewer and drafter read the SAME minutes rules', () => {
  const st = fs.readFileSync(path.join(__dirname, '..', 'lib', 'minutes', 'standards.js'), 'utf8');
  assert(/no_gl_codes/.test(st), 'GL-code rule missing from standards');
  assert(src.includes("require('../minutes/standards')"), 'reviewer does not use shared standards');
  const min = fs.readFileSync(path.join(__dirname, '..', 'api', 'minutes.js'), 'utf8');
  assert(min.includes("require('../lib/minutes/standards')"), 'drafter does not use shared standards');
});

check('the GL-code rule carries the real example that produced it', () => {
  const st = fs.readFileSync(path.join(__dirname, '..', 'lib', 'minutes', 'standards.js'), 'utf8');
  assert(/1810/.test(st) && /2810/.test(st), 'the interfund-payable example was dropped');
});

if (fail) { console.error(`\n✗ ${fail} check(s) failed.\n`); process.exit(1); }
console.log(`\n✓ Amanda review: all ${pass} checks passed.\n`);
