// ============================================================================
// tests/test_tessa_calendar_intent.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Tessa decides WHAT KIND of calendar entry from Ed's words, by rule:
//   "add my call / put this on my calendar / schedule a call" -> his calendar only
//   "send an invite / add them to the invite"                  -> event with attendees
//   "Teams / video / virtual"                                  -> Teams meeting
//   "phone call"                                               -> plain event, never Teams
//
// Scar: "Add my call with Sipra Boyd tomorrow at 4:00 PM for 15 minutes. Phone
// call regarding Lakes of Pine Forest..." was staged as a Teams invite to Sipra
// and Ed. Also: the page said "Teams invite staged" while the outbox said
// "Nothing queued" (the outbox was loaded once at page open, and a failed read
// was shown as empty).
//
//   node tests/test_tessa_calendar_intent.js
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/ea/tessa_calendar_intent');

let passed = 0; const pending = [];
function check(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); },
    (e) => { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }));
}
const ED = 'egojara@bedrocktx.com'; const TESSA = 'tessa@bedrocktx.com';
const SIPRA = "Add my call with Sipra Boyd tomorrow at 4:00 PM for 15 minutes. Phone call regarding Lakes of Pine Forest. Sipra's email is sboyd@rmwbh.com and her direct number is 713-830-2246.";

// Scar 2 (Ed 2026-10-06, live after #70): the words "invite" and "Teams" inside
// "Do not send Sipra a calendar invite and do not create a Teams meeting" routed
// this to a Teams invite and an email draft ("Send this first...").
const SIPRA2 = 'Add my call with Sipra Boyd to my calendar for Wednesday, October 7 at 4:00 PM for 15 minutes. This is a phone call regarding Lakes of Pine Forest. Sipra Boyd, sboyd@rmwbh.com, 713-830-2246. Add it to my calendar only. Do not send Sipra a calendar invite and do not create a Teams meeting.';

console.log('\nRouting from Ed’s words');
const cases = [
  [SIPRA, 'calendar_only', 'phone'],
  [SIPRA2, 'calendar_only', 'phone'],
  ['Put the call with Dan on my calendar only, Friday at 2', 'calendar_only', 'phone'],
  ['Set up a call with Dan Friday at 2. Do not create a Teams meeting.', 'invite', 'phone'],
  ['Add my call with Dan Friday at 2 to my calendar. Don’t send him an invite.', 'calendar_only', 'phone'],
  ['Don’t forget to send Dan an invite for tomorrow at 3', 'invite', null],
  ['Put my meeting with Dan Morton on my calendar for Friday at 2', 'calendar_only', null],
  ['Add the HOA walk to my calendar Thursday 9 to 10', 'calendar_only', null],
  ['Schedule a call with Grant tomorrow at 3 about the gate', 'calendar_only', 'phone'],
  ['Add my Teams call with Dan to my calendar tomorrow at 3', 'calendar_only', 'teams'],
  ['Send Dan an invite for a call tomorrow at 3', 'invite', 'phone'],
  ['Add my call with Sipra tomorrow at 4 and send her an invite', 'invite', 'phone'],
  ['Phone call with Martha Thursday at 10, add her to the invite', 'invite', 'phone'],
  ['Set up a Teams meeting with Dan Morton tomorrow 3 to 5', 'online', 'teams'],
  ['Create a Teams meeting with Dan tomorrow at 3', 'online', 'teams'],
  ['Send the Canyon Gate board an invite for a video meeting Monday at 6', 'online', 'teams'],
  ['Set up a Zoom with the auditor Friday at 11', 'invite', 'zoom'],
  ['Set up a phone call with Grant tomorrow at 3', 'invite', 'phone'],
  ['Set up a meeting with Dan tomorrow at 3', 'online', null],
];
for (const [text, mode, method] of cases) {
  check(`${mode.padEnd(13)} ${method || '-'}  <- "${text.slice(0, 70)}"`, () => {
    const r = C.classifyCalendarIntent(text);
    assert.deepStrictEqual([r.mode, r.method], [mode, method], JSON.stringify(r));
  });
}
check('duration and phone numbers come from Ed’s words', () => {
  assert.strictEqual(C.durationMinutes(SIPRA), 15);
  assert.strictEqual(C.durationMinutes('half an hour'), 30);
  assert.strictEqual(C.durationMinutes('for an hour'), 60);
  assert.strictEqual(C.durationMinutes('90 min'), 90);
  assert.strictEqual(C.durationMinutes('tomorrow at 4'), null);
  assert.deepStrictEqual(C.phonesIn(SIPRA), ['713-830-2246']);
});

console.log('\nThe staged row');
const WT = { start: '2026-10-07T16:00:00', end: '2026-10-07T16:15:00', tz: 'Central Standard Time' };
check('Sipra: Ed’s calendar only, exact title, phone, notes, NO attendees (so no invitation)', () => {
  const row = C.buildStagedMeetingRow({
    mode: 'calendar_only', method: 'phone', meeting: { title: 'Call re: Lakes of Pine Forest', topic: 'Lakes of Pine Forest' },
    people: [{ name: 'Sipra Boyd', email: 'sboyd@rmwbh.com' }], phones: ['713-830-2246'], wt: WT, edMailbox: ED, tessaMailbox: TESSA,
  });
  assert.strictEqual(row.meeting_mode, 'calendar_only');
  assert.strictEqual(row.subject, 'Sipra Boyd - Lakes of Pine Forest call');
  assert.strictEqual(row.organizer, ED, 'on Ed’s calendar, not Tessa’s');
  assert.strictEqual(row.meeting_attendees, '');
  assert.strictEqual(row.meeting_location, 'Phone call');
  assert.deepStrictEqual([row.meeting_start, row.meeting_end], ['2026-10-07T16:00:00', '2026-10-07T16:15:00']);
  for (const want of ['Sipra Boyd', 'Email: sboyd@rmwbh.com', 'Direct: 713-830-2246', 'Regarding: Lakes of Pine Forest', 'No invitation was sent']) assert.ok(row.body_text.includes(want), 'notes missing: ' + want);
  assert.ok(!/teams/i.test(JSON.stringify(row)), 'no Teams anywhere');
});
check('calendar-only with nobody resolved still uses the name Ed said', () => {
  const row = C.buildStagedMeetingRow({ mode: 'calendar_only', method: 'phone', meeting: { topic: 'gate repair' }, names: ['Grant'], wt: WT, edMailbox: ED, tessaMailbox: TESSA });
  assert.strictEqual(row.subject, 'Grant - gate repair call');
  assert.strictEqual(row.meeting_attendees, '');
});
check('invite (phone): Tessa organizes, Ed + the person invited, location is the phone, not Teams', () => {
  const row = C.buildStagedMeetingRow({ mode: 'invite', method: 'phone', meeting: { title: 'Gate call' }, people: [{ name: 'Dan', email: 'dan@x.com' }], wt: WT, edMailbox: ED, tessaMailbox: TESSA, inviteBody: 'Hi Dan' });
  assert.deepStrictEqual([row.organizer, row.meeting_attendees, row.meeting_location, row.meeting_mode], [TESSA, 'dan@x.com, egojara@bedrocktx.com', 'Phone call', 'invite']);
});
check('online: Teams location, Tessa organizes, never invites Tessa herself', () => {
  const row = C.buildStagedMeetingRow({ mode: 'online', method: 'teams', meeting: { title: 'Tech' }, people: [{ name: 'Dan', email: 'dan@x.com' }, { name: 'Tessa', email: TESSA }], wt: WT, edMailbox: ED, tessaMailbox: TESSA });
  assert.deepStrictEqual([row.meeting_location, row.meeting_attendees], ['Microsoft Teams', 'dan@x.com, egojara@bedrocktx.com']);
});

console.log('\n"Add my Teams call" reuses a link, never makes one');
const LINK = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x';
check('a link in a thread FROM the person (or naming them) is reused; a link in an unrelated thread is not', () => {
  const threads = [
    { subject: 'Budget review', from_email: 'other@x.com', preview: 'Join: ' + LINK + 'OTHER' },
    { subject: 'Re: gate', from_email: 'dan@x.com', preview: 'Here is the link ' + LINK + ' see you then' },
  ];
  assert.strictEqual(C.teamsLinkFor(threads, [{ name: 'Dan Morton', email: 'dan@x.com' }]).url, LINK);
  assert.strictEqual(C.teamsLinkFor([threads[0]], [{ name: 'Dan Morton', email: 'dan@x.com' }]), null);
});
check('calendar-only Teams entry: location Microsoft Teams, the link in the notes if found, no attendees, no new meeting', () => {
  const base = { mode: 'calendar_only', method: 'teams', people: [{ name: 'Dan Morton', email: 'dan@x.com' }], wt: WT, edMailbox: ED, tessaMailbox: TESSA };
  const withLink = C.buildStagedMeetingRow({ ...base, meeting: { topic: 'gate', teams_link: { url: LINK, subject: 'Re: gate' } } });
  assert.deepStrictEqual([withLink.meeting_mode, withLink.meeting_location, withLink.meeting_attendees, withLink.organizer], ['calendar_only', 'Microsoft Teams', '', ED]);
  assert.ok(withLink.body_text.includes('Teams link: ' + LINK));
  const noLink = C.buildStagedMeetingRow({ ...base, meeting: { topic: 'gate' } });
  assert.match(noLink.body_text, /No Teams link on file/);
});

console.log('\nThe calendar write: conflict re-check right before writing (fake Graph)');
function fakeGraph({ events = {}, failRead = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (/calendarView/.test(url)) {
      if (failRead) return { ok: false, status: 503, json: async () => ({ error: { code: 'ServiceUnavailable' } }) };
      const mb = decodeURIComponent(url.match(/users\/([^/]+)\//)[1]);
      const q = new URL(url).searchParams;
      assert.match(q.get('startDateTime'), /[+-]\d\d:\d\d$/, 'the window carries its offset (Graph reads a bare time as UTC)');
      const lo = Date.parse(q.get('startDateTime')); const hi = Date.parse(q.get('endDateTime'));
      return { ok: true, status: 200, json: async () => ({ value: (events[mb] || []).filter((e) => Date.parse(e.start.dateTime + '-05:00') < hi && Date.parse(e.end.dateTime + '-05:00') > lo) }) };
    }
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'e1', subject: 'x', start: {}, end: {} }) };
  };
  return { fetchImpl, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}
function loadMeeting() {
  const gsPath = require.resolve('../lib/email/graph_send');
  require.cache[gsPath] = { id: gsPath, filename: gsPath, loaded: true, exports: { getToken: async () => 't' } };
  delete require.cache[require.resolve('../lib/ea/tessa_meeting')];
  return require('../lib/ea/tessa_meeting');
}
// Serialize the fetch-swapping tests: they share global.fetch.
let fetchLock = Promise.resolve();
function withFetch(g, fn) {
  const run = fetchLock.then(async () => { const real = global.fetch; global.fetch = g.fetchImpl; try { return await fn(); } finally { global.fetch = real; } });
  fetchLock = run.catch(() => {});
  return run;
}
const SIPRA_ARGS = { organizer: ED, subject: 'Sipra Boyd - Lakes of Pine Forest call', start: WT.start, end: WT.end, attendees: [], body: 'notes', location: 'Phone call', online: false, conflictMailboxes: [ED] };
const ev = (subject, s, e, extra = {}) => ({ id: subject, iCalUId: subject, subject, start: { dateTime: s }, end: { dateTime: e }, showAs: 'busy', isCancelled: false, organizer: { emailAddress: { address: 'x@y.com' } }, ...extra });

check('free slot: a plain event on the organizer\u2019s calendar, no Teams, no invitation fields', async () => {
  const M = loadMeeting(); const g = fakeGraph({ events: { [ED]: [ev('Earlier', '2026-10-07T15:00:00', '2026-10-07T16:00:00')] } });
  const r = await withFetch(g, () => M.createTeamsMeeting(SIPRA_ARGS));
  const b = g.posts()[0].body;
  assert.match(g.posts()[0].url, /\/users\/egojara%40bedrocktx\.com\/events$/);
  assert.strictEqual(b.isOnlineMeeting, false);
  assert.ok(!('onlineMeetingProvider' in b));
  assert.deepStrictEqual(b.attendees, []);
  assert.ok(!('responseRequested' in b));
  assert.strictEqual(r.warning, null, 'a plain event is not a failed Teams meeting');
});
check('the default is still a Teams meeting', async () => {
  const M = loadMeeting(); const g = fakeGraph();
  await withFetch(g, () => M.createTeamsMeeting({ organizer: TESSA, subject: 'T', start: WT.start, end: WT.end, attendees: ['dan@x.com'] }));
  assert.strictEqual(g.posts()[0].body.onlineMeetingProvider, 'teamsForBusiness');
});
check('CONFLICT: an overlapping busy event -> nothing written, the conflicting event comes back', async () => {
  const M = loadMeeting(); const g = fakeGraph({ events: { [ED]: [ev('Board call', '2026-10-07T16:00:00', '2026-10-07T16:30:00')] } });
  await assert.rejects(withFetch(g, () => M.createTeamsMeeting(SIPRA_ARGS)), (e) => e.code === 'calendar_conflict' && e.conflicts[0].subject === 'Board call' && e.conflicts[0].start === '2026-10-07T16:00:00');
  assert.strictEqual(g.posts().length, 0, 'no write');
});
check('free and cancelled events are not conflicts; a conflict on Tessa\u2019s calendar counts when checked', async () => {
  const M = loadMeeting();
  const g1 = fakeGraph({ events: { [ED]: [ev('FYI hold', '2026-10-07T16:00:00', '2026-10-07T17:00:00', { showAs: 'free' }), ev('Cancelled', '2026-10-07T16:00:00', '2026-10-07T17:00:00', { isCancelled: true })] } });
  await withFetch(g1, () => M.createTeamsMeeting(SIPRA_ARGS));
  assert.strictEqual(g1.posts().length, 1);
  const g2 = fakeGraph({ events: { [TESSA]: [ev('Interview', '2026-10-07T16:10:00', '2026-10-07T16:40:00')] } });
  await assert.rejects(withFetch(g2, () => M.createTeamsMeeting({ ...SIPRA_ARGS, organizer: TESSA, attendees: ['dan@x.com'], conflictMailboxes: [ED, TESSA] })), (e) => e.code === 'calendar_conflict');
  assert.strictEqual(g2.posts().length, 0);
});
check('the calendar could not be read -> refuse (fail closed), nothing written', async () => {
  const M = loadMeeting(); const g = fakeGraph({ failRead: true });
  await assert.rejects(withFetch(g, () => M.createTeamsMeeting(SIPRA_ARGS)), (e) => e.code === 'calendar_read_failed');
  assert.strictEqual(g.posts().length, 0);
});
check('Ed, shown the conflict, can book anyway (explicit allowConflict) and only then is it written', async () => {
  const M = loadMeeting(); const g = fakeGraph({ events: { [ED]: [ev('Board call', '2026-10-07T16:00:00', '2026-10-07T16:30:00')] } });
  await withFetch(g, () => M.createTeamsMeeting({ ...SIPRA_ARGS, allowConflict: true }));
  assert.strictEqual(g.posts().length, 1);
});

console.log('\nCalendar-only never drafts an email unless Ed separately asks for one');
check('an address Ed gave, or a negated "don’t email", is NOT a request for an email', () => {
  assert.strictEqual(C.asksForEmail(SIPRA), false, '"Sipra’s email is ..." is an address');
  assert.strictEqual(C.asksForEmail(SIPRA2), false);
  assert.strictEqual(C.asksForEmail('Add my call tomorrow at 4. Don’t email her.'), false);
  assert.strictEqual(C.asksForEmail('Add my call with Sipra tomorrow at 4. Sipra Boyd, sboyd@rmwbh.com, 713-830-2246.'), false);
});
check('a separate ask for an email IS one', () => {
  assert.strictEqual(C.asksForEmail('Add my call with Sipra tomorrow at 4 and send her an email confirming'), true);
  assert.strictEqual(C.asksForEmail('Add my call with Sipra tomorrow at 4 and email Sipra the agenda'), true);
  assert.strictEqual(C.asksForEmail('Put it on my calendar and draft a note to Dan'), true);
});

console.log('\nDates as Ed says them (an unreadable one is never "today")');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
check('"Wednesday, October 7", "Oct 7, 2026", "10/7" -> Oct 7; a weekday that disagrees, or no date at all, -> nothing staged', () => {
  const { parseMonthDay } = require('../api/tessa');
  const base = Date.UTC(2026, 9, 6);
  const iso = (t) => t && t.toISOString().slice(0, 10);
  assert.strictEqual(iso(parseMonthDay('wednesday, october 7', base)), '2026-10-07');
  assert.strictEqual(iso(parseMonthDay('oct 7, 2026', base)), '2026-10-07');
  assert.strictEqual(iso(parseMonthDay('10/7', base)), '2026-10-07');
  assert.strictEqual(iso(parseMonthDay('october 3', base)), '2027-10-03', 'a passed date with no year is next year');
  assert.strictEqual(parseMonthDay('thursday, october 7', base), null, 'Oct 7 2026 is a Wednesday');
  assert.strictEqual(parseMonthDay('sometime next week', base), null);
});

check('the day comes from Ed’s words, never the model’s year; a past date is never booked', () => {
  const b = Date.UTC(2026, 9, 6);
  assert.strictEqual(C.dateFromText(SIPRA2, b), '2026-10-07', 'scar: the model returned 2025-10-07 for this sentence');
  assert.strictEqual(C.dateFromText(SIPRA, b), 'tomorrow');
  assert.strictEqual(C.dateFromText('Put lunch on my calendar Friday at noon', b), 'friday');
  assert.strictEqual(C.dateFromText('Call with Dan on Thursday, October 7 at 3', b), 'unreadable');
  assert.strictEqual(C.dateFromText('Call at 3 about the gate', b), null);
  const { resolveMeetingWallTimes } = require('../api/tessa');
  assert.strictEqual(resolveMeetingWallTimes({ date: '2025-10-07', start_time: '4:00 PM' }), null, 'a past date stages nothing');
  assert.strictEqual(resolveMeetingWallTimes({ date: 'unreadable', start_time: '4:00 PM' }), null);
  assert.match(req, /const day = dateFromText\(text\);\n\s+if \(day\) parsed\.meeting\.date = day;/);
});

console.log('\nWiring');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'tessa.js'), 'utf8').replace(/\r\n/g, '\n');
const req = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_request.js'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'tessa.html'), 'utf8');
check('release + direct booking: conflict re-check against Ed’s calendar; a conflict is a 409 that leaves the item queued', () => {
  assert.match(api, /conflictMailboxes: \[graphSend\.ED_MAILBOX, item\.organizer \|\| graphSend\.TESSA_MAILBOX\]/);
  assert.match(api, /conflictMailboxes: \[graphSend\.ED_MAILBOX, b\.organizer \|\| graphSend\.ED_MAILBOX\]/);
  const i = api.indexOf("if (e.code === 'calendar_conflict') return res.status(409)");
  const mark = api.indexOf("await supabase.from('tessa_outbox').update({ status: 'error', send_error: e.message }).eq('id', item.id);\n      return res.status(502).json({ error: `booking failed");
  assert.ok(i > 0 && mark > i, 'the conflict returns before the item is marked error');
  assert.match(api, /if \(e\.code === 'calendar_read_failed'\) return res\.status\(502\)/);
  assert.match(page, /r\.status===409 && j\.error==='conflict'/);
});
check('HARD RULE wiring: calendar-only suppresses the email draft (unless asked) and the staged intro email; staging reuses an identical queued row', () => {
  assert.match(req, /const pureInvite = \(calendarOnly && !emailAsked\) \|\|/);
  assert.match(api, /if \(mode !== 'calendar_only' && out\.meeting && out\.meeting\.direct_invite && out\.meeting\.wants_intro/);
  assert.match(api, /\.eq\('kind', 'meeting'\)\.eq\('status', 'queued'\)\.eq\('meeting_mode', row\.meeting_mode\)/);
  assert.match(api, /else return null;   \/\/ an unreadable date never silently becomes today/);
  assert.match(api, /Tessa could not read the date\/time/);
});
check('release books by the row’s mode (calendar_only: no attendees; Teams only when online; legacy NULL = online)', () => {
  assert.match(api, /const mmode = item\.meeting_mode \|\| 'online';/);
  assert.match(api, /const attendees = mmode === 'calendar_only' \? \[\] : parseAddrs/);
  assert.match(api, /online: mmode === 'online',/);
});
check('the request path classifies by rule and never drafts an email for a calendar-only entry', () => {
  assert.match(req, /const intent = classifyCalendarIntent\(text\);/);
  assert.match(req, /const pureInvite = \(calendarOnly && !emailAsked\) \|\|/);
});
check('the page refreshes the outbox after staging, and a failed outbox read is an error, not "Nothing queued"', () => {
  assert.match(page, /if\(j\.staged_meeting \|\| j\.staged_email\) loadOutbox\(\);/);
  assert.ok(!/outbox\?status=queued'\)\.then\(r=>r\.json\(\)\)\.catch\(\(\)=>\(\{items:\[\]\}\)\)/.test(page), 'the error-swallowing read is gone');
});
check('migration 492 adds meeting_mode with the three values', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'migrations', '492_tessa_outbox_meeting_mode.sql'), 'utf8');
  assert.match(m, /meeting_mode IN \('calendar_only', 'invite', 'online'\)/);
});

Promise.all(pending).then(() => console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : '')));
