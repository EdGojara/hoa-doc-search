// ============================================================================
// tests/test_tessa_schedule.js  (Ed 2026-08-31)
// ----------------------------------------------------------------------------
// Tessa's Teams-meeting scheduling: the Graph event payload must be a real
// Teams meeting (isOnlineMeeting + teamsForBusiness), attendees mapped with the
// right required/optional types and bad addresses dropped, and it must be
// owner-only. Deterministic — buildEventPayload is pure; createTeamsMeeting is
// exercised with an injected fetch + token, so no network.
// ============================================================================
const { buildEventPayload, toAttendees, createTeamsMeeting } = require('../lib/email/graph_calendar');
const { scheduleTeamsMeetingForEd } = require('../lib/team/tessa_schedule');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }

(async () => {
  console.log('\nTessa Teams-meeting scheduling\n');

  // ---- payload shape ----
  const ev = buildEventPayload({
    subject: 'MUD Issues – Lakes of Pine Forest',
    start: '2026-09-01T17:30:00', end: '2026-09-01T18:00:00', timeZone: 'Central Standard Time',
    attendees: ['jl_photo@me.com', 'verytallron@yahoo.com', 'mimimbrian@aol.com', 'harold.vance@islandpeak.com'],
    bodyText: 'Teams call to discuss the MUD issues.',
  });
  ok(ev.isOnlineMeeting === true, 'isOnlineMeeting true');
  ok(ev.onlineMeetingProvider === 'teamsForBusiness', 'provider = teamsForBusiness');
  ok(ev.start.dateTime === '2026-09-01T17:30:00' && ev.start.timeZone === 'Central Standard Time', 'start datetime + tz');
  ok(ev.end.dateTime === '2026-09-01T18:00:00', 'end datetime');
  ok(ev.attendees.length === 4 && ev.attendees.every((a) => a.type === 'required'), 'four required attendees');
  ok(ev.attendees[0].emailAddress.address === 'jl_photo@me.com', 'attendee address mapped');
  ok(ev.body.contentType === 'Text' && /MUD issues/.test(ev.body.content), 'text body');

  // required vs optional + bad-address filtering
  const mixed = toAttendees(['good@x.com', 'not-an-email', ' spaced@y.com ']);
  ok(mixed.length === 2 && mixed[0].emailAddress.address === 'good@x.com' && mixed[1].emailAddress.address === 'spaced@y.com', 'invalid addresses filtered, trimmed');
  const opt = buildEventPayload({ subject: 's', start: 'a', end: 'b', attendees: ['a@x.com'], optionalAttendees: ['o@x.com'] });
  ok(opt.attendees.find((a) => a.type === 'optional' && a.emailAddress.address === 'o@x.com'), 'optional attendees tagged optional');

  ok((() => { try { buildEventPayload({ start: 'a', end: 'b' }); return false; } catch (e) { return /subject_required/.test(e.message); } })(), 'subject required');

  // ---- createTeamsMeeting posts to the organizer, returns join url ----
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, status: 201, json: async () => ({ id: 'evt-1', subject: 'MUD Issues – Lakes of Pine Forest', webLink: 'https://outlook/evt-1', onlineMeeting: { joinUrl: 'https://teams/join/abc' } }) };
  };
  process.env.GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || 'test';
  process.env.GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'test';
  process.env.GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 'test';
  const res = await createTeamsMeeting(
    { organizer: 'egojara@bedrocktx.com', subject: 'MUD Issues – Lakes of Pine Forest', start: '2026-09-01T17:30:00', end: '2026-09-01T18:00:00', attendees: ['mimimbrian@aol.com'] },
    { fetchImpl, getToken: async () => 'tok-123' },
  );
  ok(captured && /\/users\/egojara%40bedrocktx\.com\/events$/.test(captured.url), 'posts to organizer calendar');
  ok(captured.auth === 'Bearer tok-123', 'sends bearer token');
  ok(captured.body.isOnlineMeeting === true, 'request body is a Teams meeting');
  ok(res.created && res.joinUrl === 'https://teams/join/abc' && res.webLink === 'https://outlook/evt-1', 'returns join url + weblink');

  // ---- owner-only gate ----
  let gated = null;
  try {
    await scheduleTeamsMeetingForEd(
      { requestedByEmail: 'someone.else@bedrocktx.com', subject: 's', start: 'a', end: 'b', attendees: ['x@y.com'] },
      { fetchImpl, getToken: async () => 't' },
    );
  } catch (e) { gated = e; }
  ok(gated && gated.code === 'forbidden', 'Tessa scheduling is owner-only (non-Ed rejected)');

  const okRun = await scheduleTeamsMeetingForEd(
    { requestedByEmail: 'egojara@bedrocktx.com', subject: 's', start: '2026-09-01T17:30:00', end: '2026-09-01T18:00:00', attendees: ['mimimbrian@aol.com'] },
    { fetchImpl, getToken: async () => 't' },
  );
  ok(okRun.created === true, 'Ed can schedule');

  console.log(`\n${fail ? 'FAILED' : 'All'} Tessa-schedule cases ${fail ? '' : 'passed'} (${pass} passed, ${fail} failed).`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
