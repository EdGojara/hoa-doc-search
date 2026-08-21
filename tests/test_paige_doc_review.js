// ============================================================================
// tests/test_paige_doc_review.js — Paige checking a staffer's document.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "yes lets build that and if paige can just do one better have
// paige send it to martha. in the future i want paige preparing it, i think
// right now we are just in the transition phase."
//
// Martha prepared "Call for Nominations LOPF.2026.docx" and sent it to paige@
// to be looked at. Paige replied about board-package readiness and never opened
// it — twice over, because fetchAllAttachmentBuffers dropped .docx before any
// reviewer saw the bytes.
//
// The tests that matter here are the ones where the document is WRONG. A
// reviewer that passes a good document proves nothing; Martha's real form is
// correct on every checkable point, so a live run is not evidence the checker
// works. Each case below breaks one thing and asserts it is caught, at the
// right severity.
//
// Severity is load-bearing. A wrong nomination close date is not a typo — under
// Texas Property Code 209.0056 the notice has to mail a set number of days
// before the meeting, and a close date that eats into that window is a
// challengeable election. It blocks. A missing eligibility paragraph is worth
// saying and blocks nothing. A control that shouts at everything gets ignored.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compareToTruth, classifyDoc } = require('../lib/board_package/paige_doc_review');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// The real Lakes of Pine Forest cycle, as the platform holds it.
const TRUTH = {
  values: {
    annual_meeting_date: '2026-10-13', annual_meeting_time: '6:00 PM',
    annual_meeting_location: 'Steve Radack Community Center, 18650 Clay Rd, Houston, TX 77084',
    term_years: 3, seats_open: 1,
  },
  calendar: {
    nominations_open_at: '2026-08-21', nominations_close_at: '2026-09-18',
    notice_mail_at: '2026-09-26', notice_days_before: 17, warnings: [],
    milestones: [],
  },
};

// What Martha actually wrote, read out of her .docx by the live extractor.
const MARTHA = {
  annual_meeting_date: '2026-10-13', annual_meeting_time: '6:00 PM',
  annual_meeting_location: 'Steve Radack Community Center 18650 Clay Rd, Houston, TX 77084',
  nominations_close_date: '2026-09-18', nominations_close_time: '5:00 pm',
  seats_open: 1, term_years: null,
  mentions_how_to_submit: true, mentions_eligibility: false, mentions_floor_nominations: false,
};

const sev = (f, s) => f.filter((x) => x.severity === s);

console.log('\nMartha\'s real document');
check('passes — nothing blocking, nothing to check', () => {
  const f = compareToTruth(MARTHA, TRUTH);
  assert.strictEqual(sev(f, 'blocking').length, 0, 'her form matches the cycle on every checkable point');
  assert.strictEqual(sev(f, 'check').length, 0);
});
check('but the missing eligibility paragraph is still mentioned', () => {
  const f = compareToTruth(MARTHA, TRUTH);
  assert.ok(sev(f, 'note').some((x) => /eligibilit/i.test(x.what)), 'worth saying, blocks nothing');
});

console.log('\nA wrong date is caught, and it blocks');
check('wrong annual meeting date', () => {
  const f = compareToTruth({ ...MARTHA, annual_meeting_date: '2026-10-20' }, TRUTH);
  const b = sev(f, 'blocking');
  assert.ok(b.some((x) => /annual meeting/i.test(x.what)), 'must catch the wrong meeting date');
  assert.ok(b.some((x) => /October 13/.test(x.what)), 'and name the date on file, so she can see which is which');
});
check('wrong nominations close date — the one that voids an election', () => {
  const f = compareToTruth({ ...MARTHA, nominations_close_date: '2026-10-01' }, TRUTH);
  const b = sev(f, 'blocking');
  assert.ok(b.some((x) => /nominations close/i.test(x.what)));
  assert.ok(b.some((x) => /209\.0056/.test(x.what)), 'must cite the statute, not just disagree');
});
check('a missing close date blocks too', () => {
  // Worse than a wrong one: an owner cannot act on the document at all.
  const f = compareToTruth({ ...MARTHA, nominations_close_date: null }, TRUTH);
  assert.ok(sev(f, 'blocking').some((x) => /does not say when nominations close/i.test(x.what)));
});
check('wrong seat count', () => {
  const f = compareToTruth({ ...MARTHA, seats_open: 2 }, TRUTH);
  assert.ok(sev(f, 'blocking').some((x) => /2 seats/.test(x.what) && /1 open/.test(x.what)));
});

console.log('\nSmaller differences do not block');
check('a term-year mismatch is a check, not a blocker', () => {
  const f = compareToTruth({ ...MARTHA, term_years: 2 }, TRUTH);
  assert.strictEqual(sev(f, 'blocking').length, 0);
  assert.ok(sev(f, 'check').some((x) => /term/i.test(x.what)));
});
check('a different meeting time is a check', () => {
  const f = compareToTruth({ ...MARTHA, annual_meeting_time: '7:00 PM' }, TRUTH);
  assert.strictEqual(sev(f, 'blocking').length, 0);
  assert.ok(sev(f, 'check').some((x) => /7:00 PM/.test(x.what)));
});
check('whitespace in the time is not a difference', () => {
  const f = compareToTruth({ ...MARTHA, annual_meeting_time: '6:00PM' }, TRUTH);
  assert.ok(!sev(f, 'check').some((x) => /time/i.test(x.what)), '"6:00PM" and "6:00 PM" are the same time');
});
check('a shortened location is not a difference', () => {
  // Staff write "Steve Radack Community Center"; the cycle carries the full
  // address. Flagging that would be noise on every single document.
  const f = compareToTruth({ ...MARTHA, annual_meeting_location: 'Steve Radack Community Center' }, TRUTH);
  assert.ok(!sev(f, 'check').some((x) => /Location/i.test(x.what)));
});

console.log('\nPlatform warnings travel with the review');
check('a Saturday notice date is passed on', () => {
  const t = { ...TRUTH, calendar: { ...TRUTH.calendar, warnings: ['The notice would mail on a Saturday. Mail it the preceding Friday so the statutory window is not shortened.'] } };
  const f = compareToTruth(MARTHA, t);
  assert.ok(sev(f, 'note').some((x) => /Saturday/.test(x.what)), 'the calendar knows things the document cannot');
});

console.log('\nClassification');
check('the filename alone identifies a call for nominations', () => {
  assert.strictEqual(classifyDoc('Call for Nominations LOPF.2026.docx', ''), 'call_for_nominations');
  assert.strictEqual(classifyDoc('Minutes of Annual Meeting LOPF.2025.pdf', ''), 'minutes');
});
check('an unknown document is not guessed at', () => {
  assert.strictEqual(classifyDoc('scan001.pdf', 'some unrelated text'), null,
    'better to say it cannot be checked than to review it as the wrong type');
});

console.log('\nWiring');
check('Word files reach the reviewer', () => {
  // fetchAllAttachmentBuffers dropped .docx, so amanda_review's mammoth branch
  // had never once run. Martha's form was a .docx.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_attachments.js'), 'utf8');
  assert.ok(/includeDocs/.test(src), 'there must be a way to fetch Word/Excel buffers');
  const ing = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.ok(/includeDocs:\s*true/.test(ing), 'and the Paige review path must ask for them');
});
check('the review runs before the readiness report', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8').replace(/\r\n/g, '\n');
  const review = src.indexOf('draftPaigeDocReview');
  const readiness = src.indexOf('draftPaigeReply');
  assert.ok(review > -1 && readiness > -1 && review < readiness,
    'a document to look at is not a request for a readiness report');
});
check('the readiness report cannot overwrite the review', () => {
  // Without the !draft guard the later branch silently replaces the review,
  // which is how Martha got a readiness report in the first place.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email', 'graph_ingest.js'), 'utf8');
  assert.ok(/if \(!draft && !light && !handoff\.wants && email\.direction === 'inbound'/.test(src),
    'the readiness branch must be guarded by !draft');
});

console.log('\nShe does not claim what she has not done');
check('no "attached" when nothing is attached', () => {
  // The draft goes to the review queue and the reply path carries no files.
  // Strip comments first: the note explaining WHY the claim was removed quotes
  // the old wording, and matching that is matching the explanation, not the code.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_doc_review.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/body \+=[^;]*attached/i.test(src),
    'a message that says "attached" with nothing attached reads as done and is not');
});

console.log(`\npaige_doc_review: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
