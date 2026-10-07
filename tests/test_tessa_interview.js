// ============================================================================
// tests/test_tessa_interview.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Tessa books an interview from HER calendar (she is the Outlook organizer),
// inviting Ed and the candidate. Authority: EXECUTE an open slot in working hours;
// REVIEW a conflict / outside hours / ambiguity (only an explicit approval lets an
// out-of-hours slot proceed, never a conflict); BLOCK overwriting a commitment.
// Idempotent: the same interview can never create a second event. No network:
// Graph is a fake fetch. Ed's working hours are a default for slots Tessa picks;
// an exact time Ed gives overrides them.
//
//   node tests/test_tessa_interview.js
// ============================================================================
const assert = require('assert');
const I = require('../lib/ea/tessa_interview');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}
const TESSA = 'tessa@bedrocktx.com'; const ED = 'egojara@bedrocktx.com';
const NEHA = { name: 'Neha Joseph', email: 'candidate@example.com', phone: '832-555-0100' };
const INPUT = { organizer: TESSA, interviewerEmail: ED, candidate: NEHA, role: 'Part-Time Community Operations Assistant', start: '2026-10-08T17:00', durationMinutes: 30, method: 'phone', caller: 'Ed', applicationRef: 'Indeed application (Oct 4)' };
const WH = { daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '08:00:00.0000000', endTime: '17:00:00.0000000' };

console.log('\nThe event');
check('organized by Tessa; Ed and the candidate invited; body has name, role, phone, email, method, application', () => {
  const e = I.buildInterviewEvent(INPUT);
  assert.deepStrictEqual(e.attendees.map((a) => a.emailAddress.address), [ED, NEHA.email]);
  assert.deepStrictEqual([e.start, e.end], [{ dateTime: '2026-10-08T17:00:00', timeZone: 'Central Standard Time' }, { dateTime: '2026-10-08T17:30:00', timeZone: 'Central Standard Time' }]);
  for (const s of ['Interview: Neha Joseph', 'Role: Part-Time Community Operations Assistant', 'Candidate phone: 832-555-0100', 'Candidate email: candidate@example.com', 'Phone interview: Ed calls Neha Joseph at 832-555-0100', 'Application: Indeed application (Oct 4)', 'Thursday, October 8, 2026, 5:00 PM to 5:30 PM Central']) {
    assert.ok(e.body.content.includes(s), s);
  }
  assert.strictEqual(e.isOnlineMeeting, false, 'a phone interview is not a Teams meeting');
  assert.match(e.transactionId, /^tessa-interview-[0-9a-f]{32}$/);
});
check('the candidate can be left off the invitation; bad input is refused (no bare dates, no offsets, no missing email)', () => {
  assert.strictEqual(I.buildInterviewEvent({ ...INPUT, inviteCandidate: false }).attendees.length, 1);
  assert.throws(() => I.buildInterviewEvent({ ...INPUT, start: '2026-10-08' }));
  assert.throws(() => I.buildInterviewEvent({ ...INPUT, start: '2026-10-08T22:00:00Z' }));
  assert.throws(() => I.buildInterviewEvent({ ...INPUT, candidate: { name: 'X' } }));
});
check('the idempotency key is stable for the same interview and differs for another time or candidate', () => {
  const a = I.transactionIdFor({ organizer: TESSA, candidateEmail: NEHA.email, start: '2026-10-08T17:00' });
  assert.strictEqual(a, I.transactionIdFor({ organizer: TESSA.toUpperCase(), candidateEmail: NEHA.email.toUpperCase(), start: '2026-10-08T17:00:00' }));
  assert.notStrictEqual(a, I.transactionIdFor({ organizer: TESSA, candidateEmail: NEHA.email, start: '2026-10-09T10:00' }));
  assert.notStrictEqual(a, I.transactionIdFor({ organizer: TESSA, candidateEmail: 'other@example.com', start: '2026-10-08T17:00' }));
});

console.log('\nAuthority');
const wh = { days: WH.daysOfWeek, start: '08:00', end: '17:00' };
check('EXECUTE: open slot inside working hours', () => {
  assert.strictEqual(I.decideAuthority({ start: '2026-10-08T10:00', end: '2026-10-08T10:30', freeBusy: { [TESSA]: 'free', [ED]: 'free' }, workingHours: wh }).class, 'EXECUTE');
});
check('EXPLICIT TIME FROM ED + free -> EXECUTE even past working hours (Neha Thursday 5:00 PM)', () => {
  const a = I.decideAuthority({ start: '2026-10-08T17:00', end: '2026-10-08T17:30', freeBusy: { [TESSA]: 'free', [ED]: 'free' }, workingHours: wh, explicitTime: true });
  assert.strictEqual(a.approved_by, 'Ed', 'Ed’s instruction is the named approval');
  assert.strictEqual(a.class, 'EXECUTE');
  assert.match(a.reasons[0], /Ed gave this exact time .* overrides the default window/);
});
check('a slot TESSA chose outside the default window -> REVIEW (she stays inside 8-5 unless told otherwise)', () => {
  const a = I.decideAuthority({ start: '2026-10-08T17:00', end: '2026-10-08T17:30', freeBusy: { [ED]: 'free' }, workingHours: wh });
  assert.strictEqual(a.class, 'REVIEW');
  assert.match(a.reasons[0], /outside the default window: 5:00 PM to 5:30 PM is outside Ed's working hours/);
  assert.match(I.decideAuthority({ start: '2026-10-10T10:00', end: '2026-10-10T10:30', freeBusy: {}, workingHours: wh }).reasons[0], /saturday is outside/);
});
check('a conflict -> REVIEW, even when Ed gave the time', () => {
  const a = I.decideAuthority({ start: '2026-10-08T17:00', end: '2026-10-08T17:30', freeBusy: { [ED]: 'busy' }, workingHours: wh, explicitTime: true });
  assert.strictEqual(a.class, 'REVIEW');
  assert.match(a.reasons[0], /^conflict: egojara@bedrocktx\.com is busy/);
});
check('BLOCK: overwriting or moving an existing commitment', () => {
  assert.strictEqual(I.decideAuthority({ start: '2026-10-08T10:00', end: '2026-10-08T10:30', overwrites: true }).class, 'BLOCK');
});

console.log('\nScheduling against a fake Graph');
function fakeGraph({ calendar = [], busy = {} } = {}) {
  const calls = []; const cal = [...calendar];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
    if (/getSchedule/.test(url)) return json({ value: JSON.parse(opts.body).schedules.map((m) => ({ scheduleId: m, availabilityView: busy[m] ? '22' : '00', workingHours: m === ED ? WH : undefined })) });
    if (/calendarView/.test(url)) return json({ value: cal });
    if (/\/events$/.test(url) && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      const ev = { id: 'evt-' + (cal.length + 1), iCalUId: 'ical-1', subject: b.subject, webLink: 'https://outlook/x', transactionId: b.transactionId, attendees: b.attendees, isCancelled: false };
      cal.push(ev); return json(ev, 201);
    }
    return json({ error: { code: 'unexpected' } }, 500);
  };
  return { fetchImpl, calls, cal };
}
const deps = (g) => ({ fetch: g.fetchImpl, token: 't', graphSend: { TESSA_MAILBOX: TESSA, ED_MAILBOX: ED } });
check('Ed\u2019s explicit 5:00 PM time, calendars free: creates ONE event on Tessa’s calendar with the transactionId', async () => {
  const g = fakeGraph();
  const r = await I.scheduleInterview({ ...INPUT, explicitTime: true }, deps(g));
  assert.strictEqual(r.status, 'created');
  const posts = g.calls.filter((c) => c.method === 'POST' && /\/events$/.test(c.url));
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0].url, /\/users\/tessa%40bedrocktx\.com\/events$/);
  assert.strictEqual(posts[0].body.transactionId, r.payload.transactionId);
});
check('rerun: finds the existing event and creates nothing (zero duplicates)', async () => {
  const g = fakeGraph();
  await I.scheduleInterview({ ...INPUT, explicitTime: true }, deps(g));
  const again = await I.scheduleInterview({ ...INPUT, explicitTime: true }, deps(g));
  assert.strictEqual(again.status, 'exists');
  assert.strictEqual(g.calls.filter((c) => c.method === 'POST' && /\/events$/.test(c.url)).length, 1);
  assert.strictEqual(g.cal.length, 1);
});
check('an existing event for the same candidate at that time (made another way) also prevents a duplicate', async () => {
  const g = fakeGraph({ calendar: [{ id: 'manual-1', subject: 'Neha Joseph interview', attendees: [], isCancelled: false }] });
  assert.strictEqual((await I.scheduleInterview({ ...INPUT, explicitTime: true }, deps(g))).status, 'exists');
});
check('Tessa-chosen out-of-hours slot -> needs review, nothing written; conflict -> needs review even with Ed\u2019s explicit time', async () => {
  const g1 = fakeGraph();
  assert.strictEqual((await I.scheduleInterview(INPUT, deps(g1))).status, 'needs_review');
  const g2 = fakeGraph({ busy: { [ED]: true } });
  assert.strictEqual((await I.scheduleInterview({ ...INPUT, explicitTime: true }, deps(g2))).status, 'needs_review');
  assert.strictEqual([...g1.calls, ...g2.calls].filter((c) => c.method === 'POST' && /\/events$/.test(c.url)).length, 0);
});
check('dry run returns the payload and writes nothing', async () => {
  const g = fakeGraph();
  const r = await I.scheduleInterview({ ...INPUT, explicitTime: true, dryRun: true }, deps(g));
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(g.calls.filter((c) => c.method === 'POST' && /\/events$/.test(c.url)).length, 0);
});
check('the booked event id is recorded once on Tessa’s outbox (rerun adds no row)', async () => {
  const rows = [];
  const sb = { from: () => ({ select() { return this; }, eq() { return this; }, limit: async () => ({ data: rows, error: null }),
    insert(r) { rows.push({ id: 'ob-' + rows.length, ...r }); return { select: () => ({ single: async () => ({ data: { id: rows[rows.length - 1].id }, error: null }) }) }; } }) };
  const g = fakeGraph();
  const r = await I.scheduleInterview({ ...INPUT, explicitTime: true }, deps(g));
  const a = await I.recordOnOutbox(sb, { result: r, input: INPUT, organizer: TESSA, inboxId: 'inbox-1' });
  const b = await I.recordOnOutbox(sb, { result: r, input: INPUT, organizer: TESSA, inboxId: 'inbox-1' });
  assert.deepStrictEqual([a.existing, b.existing, rows.length], [false, true, 1]);
  assert.deepStrictEqual([rows[0].kind, rows[0].status, rows[0].result.event_id, rows[0].result.transaction_id], ['meeting', 'sent', r.event.id, r.payload.transactionId]);
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
