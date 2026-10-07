// ============================================================================
// lib/ea/calendar_conflicts.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// Immediately before Tessa writes a calendar event, re-read the calendars it
// lands on. If the slot now overlaps something, nothing is written and the
// conflicting event goes back to Ed. No overwrite, no move, no silent
// double-booking. Ed: "a real calendar conflict still blocks booking."
//
// Reads calendarView with OFFSET times: an offset-less startDateTime is read as
// UTC by Graph (the 2026-10-06 Neha dedupe scar), which would check the wrong
// hours and report "free".
//
// A failed read is NOT "free": the caller refuses to write (fail closed).
// ============================================================================
const { withOffset } = require('./tessa_interview');

class CalendarConflictError extends Error {
  constructor(conflicts) {
    super('the slot conflicts with ' + conflicts.map((c) => `"${c.subject}" (${c.mailbox}, ${c.start.slice(11, 16)} to ${c.end.slice(11, 16)})`).join('; '));
    this.code = 'calendar_conflict';
    this.conflicts = conflicts;
  }
}

/**
 * Events on these calendars that overlap [start, end). Free and cancelled
 * events are not conflicts. One entry per meeting (deduped across calendars by
 * iCalUId), naming every calendar it sits on.
 */
async function findConflicts({ mailboxes, start, end, timeZone = 'Central Standard Time', ignoreTransactionId = null }, { token, fetchImpl = fetch }) {
  const lo = withOffset(start, timeZone); const hi = withOffset(end, timeZone);
  const byId = new Map();
  for (const mb of [...new Set((mailboxes || []).filter(Boolean).map((m) => String(m).toLowerCase()))]) {
    const u = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mb)}/calendarView?startDateTime=${encodeURIComponent(lo)}&endDateTime=${encodeURIComponent(hi)}`
      + '&$select=id,iCalUId,subject,start,end,showAs,isCancelled,transactionId,organizer&$top=50';
    const r = await fetchImpl(u, { headers: { Authorization: 'Bearer ' + token, Prefer: `outlook.timezone="${timeZone}"` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(`could not read ${mb}'s calendar (${(j.error && j.error.code) || r.status}); nothing was written`); err.code = 'calendar_read_failed'; throw err; }
    for (const e of j.value || []) {
      if (e.isCancelled || e.showAs === 'free') continue;
      if (ignoreTransactionId && e.transactionId === ignoreTransactionId) continue;
      const key = e.iCalUId || e.id;
      const hit = byId.get(key);
      if (hit) { if (!hit.calendars.includes(mb)) hit.calendars.push(mb); continue; }
      byId.set(key, {
        subject: e.subject || '(no subject)', start: (e.start && e.start.dateTime) || '', end: (e.end && e.end.dateTime) || '',
        showAs: e.showAs || null, organizer: (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.address) || null,
        mailbox: mb, calendars: [mb],
      });
    }
  }
  return [...byId.values()];
}

module.exports = { findConflicts, CalendarConflictError };
