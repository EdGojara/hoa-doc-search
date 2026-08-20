// ============================================================================
// lib/ea/tessa_meeting.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// Tessa books a Teams meeting on Ed's calendar and invites the room.
//
// Ed: "what is the best way for me to get tessa to send an email to the board
// on my behalf and set up a zoom or teams meeting with this vendor."
//
// She could already draft and send. She had no calendar at all — not missing
// permission, missing capability: nothing anywhere in the platform wrote an
// event. The Azure app was granted Calendars.ReadWrite and
// OnlineMeetings.ReadWrite.All on 2026-08-20, which is what makes the join link
// real rather than a calendar block that says "Teams" and links nowhere.
//
// ED APPROVES EVERY ONE. Booking a meeting mails an invitation to real board
// members and a real vendor, so nothing here is reachable from the mail
// pipeline. It is called from an owner-gated endpoint, which means Ed pressing
// the button IS the approval. Tessa never books off the back of an email
// telling her to.
//
// TIME ZONES: every timestamp crossing this boundary carries an explicit zone.
// CLAUDE.md has the scar — a date-only string sent to bedrock-vote was read as
// midnight UTC and displayed a Texas election closing a day early. Graph is the
// same shape of boundary: it takes a local wall time plus the zone it belongs
// to, never a bare date.
// ============================================================================
const { getToken } = require('../email/graph_send');

// Windows zone id rather than IANA. Graph accepts both, but the Windows names
// are what Outlook renders back, and DST is resolved by Graph from the date.
const DEFAULT_TZ = process.env.BEDROCK_TIMEZONE || 'Central Standard Time';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Graph wants 'YYYY-MM-DDTHH:mm:ss' with NO offset when timeZone is given. */
function localWallTime(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 16 ? s + ':00' : s;
  // An offset or Z means the caller already fixed an instant. Refuse rather
  // than silently reinterpret it as a wall time in another zone, which is the
  // exact move that shifted the election date.
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) {
    throw new Error('pass a local wall time like 2026-08-25T14:00:00 plus timeZone, not an absolute timestamp');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error('a meeting needs a time, not just a date: ' + s);
  }
  throw new Error('unrecognised start/end time: ' + s);
}

function graphError(status, text) {
  let code = '', msg = text;
  try { const j = JSON.parse(text); if (j.error) { code = j.error.code || ''; msg = j.error.message || text; } } catch (_) {}
  if (status === 403) {
    return new Error(
      'Graph refused the calendar write (403 ' + code + '). The app needs Calendars.ReadWrite '
      + 'AND OnlineMeetings.ReadWrite.All as APPLICATION permissions with admin consent granted. '
      + 'If both are green in Azure, the tenant may also need an application access policy '
      + 'allowing this app to act on that mailbox. Graph said: ' + String(msg).slice(0, 200));
  }
  return new Error('graph ' + status + ' ' + code + ': ' + String(msg).slice(0, 250));
}

/**
 * Create a Teams meeting and invite everyone.
 *
 * @param {string}   organizer  mailbox the meeting belongs to (Ed's, normally)
 * @param {string}   subject
 * @param {string}   start      local wall time, '2026-08-25T14:00:00'
 * @param {string}   end        local wall time
 * @param {string[]} attendees  email addresses
 * @param {string}   body       agenda text shown in the invitation
 * @param {boolean}  optionalAttendees  invite as optional rather than required
 */
async function createTeamsMeeting({
  organizer, subject, start, end, attendees = [], body = '',
  timeZone = DEFAULT_TZ, optionalAttendees = false, location = null,
}) {
  if (!organizer) throw new Error('organizer mailbox is required');
  if (!subject || !String(subject).trim()) throw new Error('the meeting needs a subject');

  const startLocal = localWallTime(start);
  const endLocal = localWallTime(end);
  if (endLocal <= startLocal) throw new Error('the meeting ends before it starts');

  const bad = attendees.filter((a) => !EMAIL_RE.test(String(a || '').trim()));
  if (bad.length) throw new Error('not a valid address: ' + bad.join(', '));

  const payload = {
    subject: String(subject).trim(),
    body: {
      contentType: 'HTML',
      content: String(body || '').split(/\n{2,}/)
        .map((p) => '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>')
        .join(''),
    },
    start: { dateTime: startLocal, timeZone },
    end: { dateTime: endLocal, timeZone },
    // Both flags: isOnlineMeeting alone gets an event that merely claims to be
    // online, and the provider is what produces a joinable Teams link.
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    allowNewTimeProposals: true,
    attendees: attendees.map((a) => ({
      emailAddress: { address: String(a).trim() },
      type: optionalAttendees ? 'optional' : 'required',
    })),
  };
  if (location) payload.location = { displayName: String(location) };

  const token = await getToken();
  const r = await fetch(
    'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(organizer) + '/events',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        // Ask Graph to echo times back in the zone we sent, so the caller can
        // show the operator what was actually booked rather than a UTC string.
        Prefer: 'outlook.timezone="' + timeZone + '"',
      },
      body: JSON.stringify(payload),
    });

  const text = await r.text();
  if (!r.ok) throw graphError(r.status, text);
  const ev = JSON.parse(text);

  return {
    id: ev.id,
    subject: ev.subject,
    join_url: (ev.onlineMeeting && ev.onlineMeeting.joinUrl) || null,
    web_link: ev.webLink || null,
    start: ev.start, end: ev.end,
    organizer,
    attendees: attendees.slice(),
    // A meeting with no join link is a calendar block, and the invitation will
    // go out saying Teams with nothing to click. Surface it rather than let the
    // caller report success.
    warning: (ev.onlineMeeting && ev.onlineMeeting.joinUrl)
      ? null
      : 'The event was created but Teams did not return a join link. Check OnlineMeetings.ReadWrite.All.',
  };
}

/** Cancel a meeting Tessa booked. Graph notifies the attendees. */
async function cancelMeeting({ organizer, eventId, comment = '' }) {
  if (!organizer || !eventId) throw new Error('organizer and eventId are required');
  const token = await getToken();
  const r = await fetch(
    'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(organizer)
      + '/events/' + encodeURIComponent(eventId) + '/cancel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Comment: String(comment || '') }),
    });
  if (!r.ok && r.status !== 204) throw graphError(r.status, await r.text());
  return { cancelled: true, eventId };
}

/** Remove an event outright. Used to clean up a test booking. */
async function deleteEvent({ organizer, eventId }) {
  const token = await getToken();
  const r = await fetch(
    'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(organizer)
      + '/events/' + encodeURIComponent(eventId),
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok && r.status !== 204) throw graphError(r.status, await r.text());
  return { deleted: true, eventId };
}

module.exports = { createTeamsMeeting, cancelMeeting, deleteEvent, localWallTime, DEFAULT_TZ };
