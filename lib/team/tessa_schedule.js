// ============================================================================
// lib/team/tessa_schedule.js  (Ed 2026-08-31)
// ----------------------------------------------------------------------------
// Tessa (Ed's EA, owner-gated) scheduling a Teams meeting FOR Ed from a thread.
// This is the single entry point Tessa's pipeline calls once the time + invitees
// are settled. The meeting is created on ED's calendar (he's the organizer),
// and Graph sends the invitations.
//
// GATED: owner-only, same as the rest of Tessa (she works just for Ed). And it
// cannot actually create anything until the platform Graph app has
// Calendars.ReadWrite (application) + the Application Access Policy covers Ed's
// calendar — see docs and lib/email/graph_calendar.js. Until then it surfaces a
// clean "calendar isn't connected yet" rather than a raw 403.
// ============================================================================
const { createTeamsMeeting } = require('../email/graph_calendar');
const { ED_MAILBOX } = require('../email/graph_send');

// requestedByEmail must be Ed — Tessa is owner-only.
async function scheduleTeamsMeetingForEd({
  requestedByEmail, subject, start, end, timeZone, attendees, optionalAttendees, bodyText, bodyHtml, location,
}, opts = {}) {
  const owner = (process.env.ED_MAILBOX || ED_MAILBOX).toLowerCase();
  if (!requestedByEmail || String(requestedByEmail).toLowerCase() !== owner) {
    throw Object.assign(new Error('tessa_owner_only'), { code: 'forbidden' });
  }
  if (!subject || !start || !end) throw Object.assign(new Error('subject_start_end_required'), { code: 'invalid_input' });
  if (!attendees || (Array.isArray(attendees) && attendees.length === 0)) {
    throw Object.assign(new Error('at_least_one_attendee_required'), { code: 'invalid_input' });
  }
  try {
    return await createTeamsMeeting({
      organizer: ED_MAILBOX, subject, start, end, timeZone, attendees, optionalAttendees, bodyText, bodyHtml, location,
    }, opts);
  } catch (e) {
    if (/graph_not_configured|create event failed \(403/.test(e.message)) {
      throw Object.assign(new Error('calendar_not_connected_yet'), { code: 'not_connected', detail: e.message });
    }
    throw e;
  }
}

module.exports = { scheduleTeamsMeetingForEd };
