// tests/test_meeting_intel.js  (Ed 2026-09-23)
// Offline tests for Paige's meeting review: the code checks
// (lib/meetings/intel_validate.js), the draft-minutes builder
// (lib/meetings/minutes_from_analysis.js) and what Paige is shown
// (lib/meetings/paige_meeting.js). Fixtures: a synthetic Drama Creek board
// meeting with known ground truth and a real Paige output for it. No network.
const assert = require('assert');
const { validateAnalysis, quoteSupported } = require('../lib/meetings/intel_validate');
const { buildDraftMinutes } = require('../lib/meetings/minutes_from_analysis');
const { renderTranscript, fromTool, shapeProblems, TOOL } = require('../lib/meetings/paige_meeting');
const T = require('./fixtures/meeting-intel/transcript_segments.json');
const RAW = require('./fixtures/meeting-intel/paige_output.json');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
const clone = (x) => JSON.parse(JSON.stringify(x));
const ROSTER = [
  { id: 'b1', name: 'Sunny Meadows', position: 'President' }, { id: 'b2', name: 'Byron T. Bylaw', position: 'Vice President / ACC Chair' },
  { id: 'b3', name: 'Cassandra Complaine', position: 'Secretary' }, { id: 'b4', name: 'Tally Hawthorne', position: 'Treasurer' }, { id: 'b5', name: 'Felix Goodneighbor', position: 'Member-at-Large' },
];
const MAPPED = [0, 1, 2, 3, 4].map((sp) => ({ speaker: sp, role: 'board_member', board_member_id: 'b' + (sp + 1) })).concat([{ speaker: 5, role: 'manager', display_name: 'Jordan Ellis' }]);
const check = (raw, o = {}) => validateAnalysis({ analysis: fromTool(raw), segments: T.segments, mappings: o.mappings || [], roster: ROSTER, gaps: o.gaps || [], execRanges: T.exec_ranges });
const motion = (c, re) => c.motions.find((m) => re.test(m.motion_text));
const codes = (x) => x.review_reasons.map((r) => r.code);
const ctx = { communityName: 'Drama Creek Estates', meeting: {}, sessionStartedAt: '2026-10-01T00:02:00Z', roster: ROSTER };

console.log('paige_meeting.js (what Paige sees)');
t('executive-session lines are NOT in the transcript Paige reads; one withheld marker instead', () => {
  const txt = renderTranscript({ lines: T.segments, labelOf: (s) => `Speaker ${s + 1}`, exec: T.exec_ranges });
  assert.ok(!/heron|six thousand two hundred|attorney/i.test(txt));
  assert.strictEqual((txt.match(/EXECUTIVE SESSION/g) || []).length, 1);
  assert.ok(/\[u0 \| 0:0\d \| Speaker 1\] Good evening/.test(txt));
});
t('tool schema is flat; shape check accepts the recorded output and rejects text-for-structure', () => {
  assert.deepStrictEqual(shapeProblems(RAW), []);
  const bad = clone(RAW); bad.motions = '[{"motion_text": ...';
  assert.ok(shapeProblems(bad).some((p) => /motions must be an array/.test(p)));
  assert.ok(TOOL.input_schema.required.includes('speaker_suggestions'));
});

console.log('intel_validate.js (code checks)');
const base = check(RAW);
t('the recorded analysis: 3 motions with time references; landscaping 5-0 passed, pool 2-3 failed', () => {
  assert.strictEqual(base.motions.length, 3);
  assert.ok(base.motions.every((m) => m.time_ref && m.support.length));
  const l = motion(base, /landscap|lone star/i), p = motion(base, /pool/i);
  assert.deepStrictEqual([l.vote.yes, l.vote.no, l.result, l.mover_resolved.name, l.seconder_resolved.name], [5, 0, 'passed', 'Tally Hawthorne', 'Felix Goodneighbor']);
  assert.deepStrictEqual([p.vote.yes, p.vote.no, p.result, l.status, p.status], [2, 3, 'failed', 'OK', 'OK']);
});
t('attendance: 5 directors confirmed against the roster', () => { assert.strictEqual(base.attendance.directors_present_count, 5); });
t('adjournment "motion" with no vote heard -> NEEDS_REVIEW vote_not_heard (result was inferred)', () => {
  assert.ok(codes(motion(base, /adjourn/i)).includes('vote_not_heard'));
});
t('vote counts cannot exceed directors present', () => {
  const r = clone(RAW); r.motions.find((m) => /pool/i.test(m.motion_text)).yes = 4;
  assert.ok(codes(motion(check(r), /pool/i)).includes('vote_exceeds_directors'));
});
t('result must agree with the count (passed with 2 for / 3 against)', () => {
  const r = clone(RAW); r.motions.find((m) => /pool/i.test(m.motion_text)).result = 'passed';
  assert.ok(codes(motion(check(r), /pool/i)).includes('result_inconsistent_with_vote'));
});
t('named voters must match the count', () => {
  const r = clone(RAW); const m = r.motions.find((x) => /pool/i.test(x.motion_text)); m.yes_names = ['Byron T. Bylaw'];
  assert.ok(codes(motion(check(r), /pool/i)).includes('vote_names_count_mismatch'));
});
t('a mover who is not on the board roster -> NEEDS_REVIEW mover_not_on_roster', () => {
  const r = clone(RAW); r.motions[0].mover = 'Jordan Ellis';
  assert.ok(codes(check(r).motions[0]).includes('mover_not_on_roster'));
});
t('mover contradicted by the staff speaker mapping of the "I move" line -> mover_differs_from_speaker', () => {
  const r = clone(RAW); r.motions.find((m) => /landscap|lone star/i.test(m.motion_text)).mover = 'Sunny Meadows';
  assert.ok(codes(motion(check(r, { mappings: MAPPED }), /landscap|lone star/i)).includes('mover_differs_from_speaker'));
});
t('an invented quote is caught (quote_not_in_transcript)', () => {
  const r = clone(RAW); r.motions[0].quote = 'I move we approve twenty thousand dollars for the fountain';
  assert.ok(codes(check(r).motions[0]).includes('quote_not_in_transcript'));
  assert.ok(quoteSupported('eighteen thousand four hundred dollars', ['for eighteen thousand four hundred dollars, paid']));
});
t('a due date that was never said is caught (due_not_in_transcript)', () => {
  const r = clone(RAW); const a = r.action_items.find((x) => /pool rules|newsletter/i.test(x.task)); a.due = 'by November 15';
  const c = check(r).action_items.find((x) => /pool rules|newsletter/i.test(x.task));
  assert.ok(codes(c).includes('due_not_in_transcript'));
});
t('a responsible person who neither spoke nor was named in the cited lines is caught', () => {
  const r = clone(RAW); const a = r.action_items.find((x) => /pool rules|newsletter/i.test(x.task)); a.responsible = 'Byron T. Bylaw';
  assert.ok(codes(check(r, { mappings: MAPPED }).action_items.find((x) => /pool rules|newsletter/i.test(x.task))).includes('responsible_not_stated'));
});
t('with speakers mapped, owners are confirmed (no unconfirmed-speaker flags)', () => {
  const c = check(RAW, { mappings: MAPPED });
  assert.ok(c.action_items.every((a) => !codes(a).includes('responsible_from_unconfirmed_speaker')), JSON.stringify(c.action_items.map(codes)));
});
t('an item citing an executive-session line is WITHHELD', () => {
  const r = clone(RAW); const execIdx = T.segments.find((s) => s.scope === 'executive').idx;
  r.decisions.push({ text: 'Refer an account to the attorney', refs: ['u' + execIdx], quote: 'refer' });
  const d = check(r).decisions.find((x) => /attorney/.test(x.text));
  assert.ok(d.withheld && codes(d).includes('executive_session_content'));
});
t('public text repeating executive-session wording is withheld', () => {
  const r = clone(RAW); r.follow_ups.push({ text: 'the owner at fourteen Heron Court owes about six thousand', refs: ['u10'], quote: 'Rick from Lone Star' });
  assert.ok(check(r).follow_ups.find((x) => /Heron/.test(x.text)).withheld);
});
t('recording gap: items within 20 s are NEEDS_REVIEW near_recording_gap', () => {
  const l = T.segments.find((s) => /I move that we approve/.test(s.text));
  const c = check(RAW, { gaps: [{ at_audio_ms: l.start_ms + 5000, ms: 12000, reason: 'interruption' }] });
  assert.ok(codes(motion(c, /landscap|lone star/i)).includes('near_recording_gap'));
  assert.ok(c.summary.review_reasons.some((r) => r.code === 'recording_gaps'));
});
t('unknown line reference is caught', () => {
  const r = clone(RAW); r.follow_ups[0].refs = ['u999'];
  assert.ok(codes(check(r).follow_ups[0]).includes('unknown_reference'));
});

console.log('minutes_from_analysis.js (draft minutes)');
const md = buildDraftMinutes(check(RAW, { mappings: MAPPED }), ctx).body_markdown;
t('motions record maker, seconder, vote and result', () => {
  assert.ok(/Moved by Tally Hawthorne; seconded by Felix Goodneighbor\. Vote: 5 in favor, 0 opposed\. \*\*The motion passed\.\*\*/.test(md));
  assert.ok(/Vote: 2 in favor, 3 opposed\. \*\*The motion failed\.\*\*/.test(md));
});
t('executive session is minimal (convened/reconvened) and none of its content appears', () => {
  assert.ok(/convened in executive session/.test(md));
  assert.ok(!/heron|six thousand two hundred|6,200|attorney|demand letter/i.test(md));
});
t('NEEDS_REVIEW items are flagged inline; officer called to order', () => {
  assert.ok(/\[NEEDS REVIEW: marked passed, but no vote is heard/.test(md));
  assert.ok(/called to order at 7:02 PM by Sunny Meadows, President/.test(md));
});
t('action item without a stated due date gets none', () => {
  const line = md.split('\n').find((l) => /pool rules/i.test(l));
  assert.ok(line && !/due/i.test(line), line);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
