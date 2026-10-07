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

console.log('\nRouting from Ed’s words');
const cases = [
  [SIPRA, 'calendar_only', 'phone'],
  ['Put my meeting with Dan Morton on my calendar for Friday at 2', 'calendar_only', null],
  ['Add the HOA walk to my calendar Thursday 9 to 10', 'calendar_only', null],
  ['Schedule a call with Grant tomorrow at 3 about the gate', 'calendar_only', 'phone'],
  ['Add my Teams call with Dan to my calendar tomorrow at 3', 'calendar_only', 'teams'],
  ['Send Dan an invite for a call tomorrow at 3', 'invite', 'phone'],
  ['Add my call with Sipra tomorrow at 4 and send her an invite', 'invite', 'phone'],
  ['Phone call with Martha Thursday at 10, add her to the invite', 'invite', 'phone'],
  ['Set up a Teams meeting with Dan Morton tomorrow 3 to 5', 'online', 'teams'],
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

console.log('\nThe calendar write (fake Graph)');
check('online:false + no attendees -> a plain event on the organizer’s calendar: no Teams, no invitation fields', async () => {
  const gsPath = require.resolve('../lib/email/graph_send');
  require.cache[gsPath] = { id: gsPath, filename: gsPath, loaded: true, exports: { getToken: async () => 't' } };
  delete require.cache[require.resolve('../lib/ea/tessa_meeting')];
  const M = require('../lib/ea/tessa_meeting');
  const calls = []; const realFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'e1', subject: 'x', start: {}, end: {} }) }; };
  try {
    const r = await M.createTeamsMeeting({ organizer: ED, subject: 'Sipra Boyd - Lakes of Pine Forest call', start: WT.start, end: WT.end, attendees: [], body: 'notes', location: 'Phone call', online: false });
    const b = calls[0].body;
    assert.match(calls[0].url, /\/users\/egojara%40bedrocktx\.com\/events$/);
    assert.strictEqual(b.isOnlineMeeting, false);
    assert.ok(!('onlineMeetingProvider' in b));
    assert.deepStrictEqual(b.attendees, []);
    assert.ok(!('responseRequested' in b));
    assert.strictEqual(r.warning, null, 'a plain event is not a failed Teams meeting');
    await M.createTeamsMeeting({ organizer: TESSA, subject: 'T', start: WT.start, end: WT.end, attendees: ['dan@x.com'] });
    assert.strictEqual(calls[1].body.onlineMeetingProvider, 'teamsForBusiness', 'the default is still a Teams meeting');
  } finally { global.fetch = realFetch; delete require.cache[gsPath]; }
});

console.log('\nWiring');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'tessa.js'), 'utf8');
const req = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ea', 'tessa_request.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'tessa.html'), 'utf8');
check('release books by the row’s mode (calendar_only: no attendees; Teams only when online; legacy NULL = online)', () => {
  assert.match(api, /const mmode = item\.meeting_mode \|\| 'online';/);
  assert.match(api, /const attendees = mmode === 'calendar_only' \? \[\] : parseAddrs/);
  assert.match(api, /online: mmode === 'online',/);
});
check('the request path classifies by rule and never drafts an email for a calendar-only entry', () => {
  assert.match(req, /const intent = classifyCalendarIntent\(text\);/);
  assert.match(req, /const pureInvite = calendarOnly \|\|/);
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
