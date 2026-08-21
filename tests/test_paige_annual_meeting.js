// ============================================================================
// tests/test_paige_annual_meeting.js — an annual meeting is not a monthly one.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "ok but martha asked for help with annual meeting and online
// voting but paige did monthly board package."
//
// The real miss, and bigger than the attachments that preceded it.
//
// Martha wrote: "Annual meeting is coming up for Lakes of Pine Forest. One
// position is open. Please create a board packet for and help me create the
// timeline. I also need to set up online voting."
//
// Three asks. Paige ran the readiness engine, which has exactly ONE section
// list — draft agenda, prior OPEN-SESSION minutes, action items, AR aging, AP
// approval, management report. That is a monthly board meeting. The word
// "annual" does not appear anywhere in board_package/engine.js.
//
// So Martha was told "no finalized prior minutes on record" (she had attached
// the prior ANNUAL minutes), and heard nothing about the timeline or online
// voting at all.
//
// Two failures worth separating, because they need different fixes:
//
//   WRONG QUESTION — an annual meeting has a statutory spine (call for
//   nominations, close, notice under 209.0056, meeting) and its package is
//   notice, candidates, ballot, sign-in, prior ANNUAL minutes. Financials are
//   supporting material, not the substance.
//
//   DROPPED ASKS — she answered one of three and said nothing about the other
//   two. Ed's rule is that the AI team asks for what it needs; the corollary is
//   that it must not silently drop what it was asked for.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isAnnualMeeting, asksIn, ANNUAL_SECTIONS } = require('../lib/board_package/paige_annual_meeting');

let pass = 0; let fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// Verbatim.
const MARTHA = 'Lakes of Pine Forest\nAnnual meeting is coming up for Lakes of Pine Forest. '
  + 'One position is open. Please create a board packet for and help me create the timeline. '
  + 'I also need to set up online voting.';

console.log('\nMartha\'s request is recognised for what it is');
check('it is an annual meeting, not a monthly board meeting', () => {
  assert.strictEqual(isAnnualMeeting(MARTHA), true,
    'she says "annual meeting" in the first sentence');
});
check('all three asks are seen', () => {
  const a = asksIn(MARTHA);
  assert.strictEqual(a.package, true, '"board packet"');
  assert.strictEqual(a.timeline, true, '"help me create the timeline"');
  assert.strictEqual(a.voting, true, '"set up online voting"');
});

console.log('\nA monthly meeting still goes to the monthly path');
check('routine board mail is not treated as the annual meeting', () => {
  for (const s of [
    'build the board package for the September meeting',
    'can you put together the packet for next week',
    'the board wants the financials early this month',
  ]) assert.strictEqual(isAnnualMeeting(s), false, `"${s}" is a monthly board meeting`);
});
check('an election word alone is not enough', () => {
  // "ballot" turns up in unrelated mail. It only means the annual meeting when
  // it sits next to a meeting/seat/election word.
  assert.strictEqual(isAnnualMeeting('can you reprint the ballot measure flyer'), false);
});
check('but a nominations request IS the annual meeting', () => {
  assert.strictEqual(isAnnualMeeting('send the call for nominations, one director seat is up'), true);
});

console.log('\nThe annual package is the annual package');
check('it carries the statutory items, not the monthly ones', () => {
  const keys = ANNUAL_SECTIONS.map((s) => s.key);
  for (const k of ['call_for_nominations', 'candidates', 'notice', 'ballot', 'signin', 'prior_annual_minutes']) {
    assert.ok(keys.includes(k), `an annual meeting package needs ${k}`);
  }
});
check('it does NOT carry the monthly board-meeting items', () => {
  const keys = ANNUAL_SECTIONS.map((s) => s.key);
  // These are the ones Martha was actually told about. They belong to a
  // monthly board meeting and have no place on an annual meeting checklist.
  for (const k of ['action_items', 'ap_approval', 'ar_aging', 'management_report', 'board_decisions']) {
    assert.ok(!keys.includes(k), `${k} is a monthly board-meeting item`);
  }
});
check('prior ANNUAL minutes, not last month\'s minutes', () => {
  const s = ANNUAL_SECTIONS.find((x) => x.key === 'prior_annual_minutes');
  assert.ok(/annual/i.test(s.label), 'the label must say annual — that distinction is the bug');
});
check('every section names who owns it', () => {
  // Handing a manager a flat list of everything is how work stalls. Ed's rule:
  // route it to whoever owns it.
  for (const s of ANNUAL_SECTIONS) {
    assert.ok(s.owner, `${s.key} needs an owner`);
    assert.ok(['paige', 'manager', 'accounting', 'compliance'].includes(s.owner), `${s.key} owner "${s.owner}" is not a real one`);
  }
});

console.log('\nNothing asked for is dropped');
check('the reply answers online voting explicitly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_reply.js'), 'utf8');
  assert.ok(/if \(st\.asks\.voting\)/.test(src), 'the voting ask must be answered when it is made');
  assert.ok(/bedrock-vote/.test(src), 'and name where the election actually runs');
});
check('and is honest about when it can happen', () => {
  // The ballot is built from the candidate list, so a push before nominations
  // close is not a policy choice, it is impossible. Say so rather than
  // promising and slipping.
  // The source writes it as can\'t inside a single-quoted string, so match the
  // escaped form too rather than only the rendered one.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_reply.js'), 'utf8');
  assert.ok(/can\\?'t go before then/.test(src), 'the constraint must be stated, not implied');
});
check('the timeline comes from the statutory calendar', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_annual_meeting.js'), 'utf8');
  assert.ok(/buildMeetingCalendar/.test(src), 'dates must come from the calendar, never be written out by hand');
});

console.log('\nRouting');
check('the annual path runs before the monthly engine', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_reply.js'), 'utf8').replace(/\r\n/g, '\n');
  const annual = src.indexOf('isAnnualMeeting(text)');
  // The CALL, not the import at the top of the file — comparing against the
  // import always "fails" because every import precedes every call.
  const readiness = src.indexOf('buildReadiness(profile');
  assert.ok(annual > -1, 'the annual check must exist');
  assert.ok(readiness > -1, 'the monthly readiness engine must still be called');
  assert.ok(annual < readiness,
    'running an annual request through the monthly engine is the bug this fixes');
});
check('nothing is created on this pass', () => {
  // Same rule the nominations path follows: creating a cycle publishes a public
  // nomination page, and a wrong seat count must never exist at that URL.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_annual_meeting.js'), 'utf8');
  assert.ok(!/\.insert\(|\.update\(|\.upsert\(/.test(src), 'the status path must be read-only');
});
check('a community with no cycle gets a question, not a guess', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board_package', 'paige_reply.js'), 'utf8');
  assert.ok(/if \(!st\.cycle\)/.test(src), 'no cycle must be handled explicitly');
  assert.ok(/tell me the meeting date and how many seats/.test(src), 'and must ask rather than assume');
});

console.log(`\npaige_annual_meeting: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
