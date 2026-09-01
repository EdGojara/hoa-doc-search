// ============================================================================
// lib/email/graph_calendar.js  (Ed 2026-08-31) — create Teams meetings via
// Microsoft Graph (application permissions, same client-credentials app as
// graph_send.js).
// ----------------------------------------------------------------------------
// This is what lets Tessa schedule a Teams meeting for Ed from a thread. It
// creates the event on the ORGANIZER's calendar (Ed by default) and, with
// attendees, Graph sends the invitations automatically — same as a person
// clicking "New Teams Meeting" in Outlook.
//
// REQUIRES (in addition to graph_send's Mail.Send):
//   * APPLICATION permission Calendars.ReadWrite on the platform's Graph app
//     (GRAPH_CLIENT_ID), admin-consented.
//   * The Application Access Policy extended to include the organizer mailbox's
//     CALENDAR (today the policy scopes claire@/info@ for mail only). Until both
//     exist, createTeamsMeeting throws the raw Graph 403 — isConfigured() only
//     covers env, not the calendar grant, so the first real call is the test.
//
// buildEventPayload is a pure function (unit-tested) so the Graph event shape is
// verified without touching the network.
// ============================================================================
const { getToken, isConfigured, ED_MAILBOX } = require('./graph_send');

const DEFAULT_TZ = process.env.BEDROCK_TIMEZONE || 'Central Standard Time';

function toAttendees(v, type = 'required') {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return arr
    .map((a) => (typeof a === 'string' ? { email: a } : a))
    .map((a) => ({ address: String(a.email || '').trim(), name: a.name }))
    .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.address))
    .map((a) => ({ emailAddress: { address: a.address, name: a.name || undefined }, type }));
}

// Pure: build the Graph /events body for a Teams meeting. start/end are ISO
// local datetimes ("2026-09-01T17:30:00", no offset); timeZone is a Windows or
// IANA name Graph accepts.
function buildEventPayload({ subject, start, end, timeZone = DEFAULT_TZ, attendees, optionalAttendees, bodyText, bodyHtml, location }) {
  if (!subject) throw new Error('subject_required');
  if (!start || !end) throw new Error('start_and_end_required');
  const event = {
    subject,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    attendees: [...toAttendees(attendees, 'required'), ...toAttendees(optionalAttendees, 'optional')],
    body: bodyHtml ? { contentType: 'HTML', content: bodyHtml } : { contentType: 'Text', content: bodyText || '' },
  };
  if (location) event.location = { displayName: location };
  return event;
}

// Create the event on the organizer's calendar. Returns the join URL + weblink.
// opts.fetchImpl is injectable for tests.
async function createTeamsMeeting({ organizer = ED_MAILBOX, subject, start, end, timeZone, attendees, optionalAttendees, bodyText, bodyHtml, location }, opts = {}) {
  if (!isConfigured()) throw new Error('graph_not_configured');
  const doFetch = opts.fetchImpl || fetch;
  const token = await (opts.getToken || getToken)();
  const event = buildEventPayload({ subject, start, end, timeZone, attendees, optionalAttendees, bodyText, bodyHtml, location });
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizer)}/events`;
  const r = await doFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!(r.status === 201 || r.ok)) {
    const t = await r.text().catch(() => '');
    throw new Error(`Graph create event failed (${r.status}): ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  return {
    created: true,
    id: j.id,
    subject: j.subject,
    webLink: j.webLink || null,
    joinUrl: (j.onlineMeeting && j.onlineMeeting.joinUrl) || null,
    organizer,
  };
}

module.exports = { buildEventPayload, createTeamsMeeting, toAttendees, DEFAULT_TZ };
