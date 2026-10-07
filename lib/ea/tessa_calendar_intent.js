// ============================================================================
// lib/ea/tessa_calendar_intent.js  (Ed 2026-10-06)
// ----------------------------------------------------------------------------
// What KIND of calendar entry Ed asked for, decided from his own words by rules,
// not by the model.
//
// Scar: "Add my call with Sipra Boyd tomorrow at 4:00 PM for 15 minutes. Phone
// call regarding Lakes of Pine Forest. Sipra's email is sboyd@rmwbh.com and her
// direct number is 713-830-2246." Tessa staged a TEAMS INVITE to Sipra and Ed.
// Ed wanted a line on his own calendar: the call was already agreed, so a second
// invitation to Sipra is noise and a Teams link on a phone call is wrong.
//
// Three modes:
//   calendar_only  an entry on Ed's own calendar. No attendees, so Outlook sends
//                  no invitation. "add my call", "put this on my calendar",
//                  "schedule a call" when the time is already agreed.
//   invite         a calendar event WITH attendees, no Teams link. Ed asked to
//                  invite them ("send her an invite", "add him to the invite").
//   online         a Teams meeting with attendees (the legacy default for "set
//                  up a meeting with X").
//
// Rules, in order:
//   1. Ed asked to invite / send an invite / add someone to the invite
//      -> invite (online when he said Teams/video/virtual).
//   2. "add/put ... (on|to|in) my calendar", "add my call/meeting",
//      "schedule a call", "block off/out" -> calendar_only, whatever the method.
//   3. Teams / video / virtual / online meeting -> online.
//   4. A phone call -> invite (plain event, never a Teams link).
//   5. Otherwise the legacy behavior: online.
// Zoom is never "online": Graph can only mint a Teams link, so a Zoom meeting is
// a plain event whose location says Zoom (the other side owns the link).
// ============================================================================

const RX = {
  invite: /\binvit(?:e|es|ed|ation)\b|\badd\s+(?:him|her|them|[a-z]+)\s+to\s+the\s+(?:invite|meeting|calendar\s+invite)\b|\bsend\s+(?:him|her|them|[a-z]+)\s+(?:a|an|the)\s+(?:calendar\s+)?(?:invite|meeting\s+request)\b/i,
  calendarOnly: /\b(?:add|put)\b[^.?!]{0,120}?\b(?:on|to|in)\s+my\s+calendar\b|\bon\s+my\s+calendar\b|\badd\s+my\s+(?:phone\s+)?(?:call|meeting|appointment|lunch|interview)\b|\bschedule\s+(?:a|my)\s+(?:phone\s+)?call\b|\bblock\s+(?:off|out)\b/i,
  teams: /\b(?:teams|video(?:\s+(?:call|meeting))?|virtual|online\s+meeting|webex|google\s+meet)\b/i,
  zoom: /\bzoom\b/i,
  phone: /\bphone\b|\bcall\b/i,
  inPerson: /\bin[\s-]person\b|\bat\s+(?:the|our|my)\s+office\b|\blunch\b|\bcoffee\b/i,
};

// "calendar only" said outright wins over everything else.
const EXPLICIT_CALENDAR_ONLY = /\b(?:my\s+)?calendar\s+only\b|\bonly\s+(?:on|to|in)\s+my\s+calendar\b|\bjust\s+(?:on|to|in)\s+my\s+calendar\b/i;
// A negated clause ("do not send Sipra a calendar invite and do not create a
// Teams meeting") names what Ed does NOT want. Scar 2026-10-06: the words
// "invite" and "Teams" inside that sentence routed it to a Teams invite and an
// email draft. Remove each negated clause, to the end of its sentence, before
// matching. "Don't forget to ..." is not a negation.
const NEGATED = /\b(?:do\s+not|don['’]?t|dont|never|no\s+need\s+to|without)\b(?!\s+forget)[^.;!?]*/gi;
const stripNegated = (s) => String(s || '').replace(NEGATED, ' ');

/**
 * Did Ed separately ask for an EMAIL (not an address he gave, not a negated
 * "don't email her")? Pure. "Sipra's email is x" is an address, not a request.
 */
function asksForEmail(text) {
  const s = stripNegated(text);
  return /\b(?:send|write|draft|shoot)\s+(?:\w+\s+){0,3}?(?:an?\s+)?(?:e-?mail|note|message)\b|\be-?mail\s+(?:him|her|them)\b/i.test(s)
    || /\be-?mail\s+[A-Z][a-z]+\b(?!['’]s)/.test(s.replace(/\be-?mail\s+(?:is|address)\b/gi, ''));
}

/**
 * Classify Ed's instruction. Pure.
 * @returns {{ mode: 'calendar_only'|'invite'|'online', method: 'phone'|'teams'|'zoom'|'in_person'|null, reasons: string[] }}
 */
function classifyCalendarIntent(text) {
  const raw = String(text || '');
  const s = stripNegated(raw);
  const zoom = RX.zoom.test(s);
  const teams = !zoom && RX.teams.test(s);
  const method = zoom ? 'zoom' : teams ? 'teams' : RX.inPerson.test(s) ? 'in_person' : RX.phone.test(s) ? 'phone' : null;
  if (EXPLICIT_CALENDAR_ONLY.test(s)) {
    return { mode: 'calendar_only', method, reasons: ['Ed said calendar only; no invitation'] };
  }
  if (RX.invite.test(s)) {
    return { mode: teams ? 'online' : 'invite', method, reasons: ['Ed asked to invite them' + (teams ? ' to a Teams meeting' : '')] };
  }
  if (RX.calendarOnly.test(s)) {
    return { mode: 'calendar_only', method, reasons: ['Ed asked for an entry on his own calendar; no invitation'] };
  }
  if (teams) return { mode: 'online', method, reasons: ['Ed asked for a Teams/video meeting'] };
  if (zoom) return { mode: 'invite', method, reasons: ['a Zoom meeting: a plain event, the other side owns the link'] };
  if (method === 'phone') return { mode: 'invite', method, reasons: ['a phone call: a plain event, no Teams link'] };
  return { mode: 'online', method, reasons: ['a meeting with named people (default: Teams invite)'] };
}

/** "for 15 minutes" / "half an hour" / "an hour" / "90 min" -> minutes, else null. Pure. */
function durationMinutes(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/\b(\d{1,3})\s*(?:-\s*)?(?:min|mins|minute|minutes)\b/); if (m) return +m[1];
  m = s.match(/\b(\d(?:\.\d)?)\s*(?:hr|hrs|hour|hours)\b/); if (m) return Math.round(+m[1] * 60);
  if (/\bhalf\s+(?:an\s+)?hour\b/.test(s)) return 30;
  if (/\b(?:an|one)\s+hour\b/.test(s)) return 60;
  return null;
}

/** Phone numbers written in Ed's text, as he wrote them. Pure. */
function phonesIn(text) {
  return [...String(text || '').matchAll(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g)].map((m) => m[0].trim());
}

const TEAMS_LINK = /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/|teams\.live\.com\/meet\/)[^\s<>"')\]]+/i;
/**
 * An existing Teams join link for "add my Teams call with X to my calendar":
 * only from a thread that involves the person (they sent it, or it names them),
 * never from an unrelated thread. Tessa never MAKES a link for a calendar-only
 * entry; the other side's invitation owns it. Pure.
 */
function teamsLinkFor(threads = [], people = [], names = []) {
  const emails = new Set(people.map((p) => String(p.email || '').toLowerCase()).filter(Boolean));
  const words = [...people.map((p) => p.name), ...names].filter(Boolean).map((n) => String(n).toLowerCase());
  for (const t of threads) {
    const text = `${t.subject || ''} ${t.preview || ''}`;
    const related = emails.has(String(t.from_email || '').toLowerCase()) || words.some((w) => text.toLowerCase().includes(w));
    if (!related) continue;
    const m = text.match(TEAMS_LINK);
    if (m) return { url: m[0], subject: t.subject || null, received: t.received || null };
  }
  return null;
}

// "wednesday, october 7" / "oct 7" / "october 7, 2026" / "10/7" -> a UTC-anchored date
// (this year; next year if it has already passed). A weekday that disagrees with
// the date makes it unusable rather than guessed. Pure.
function parseMonthDay(raw, baseUTC) {
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const s = String(raw || '').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let mo = null; let d = null; let y = null;
  let m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/);
  if (m) { mo = MONTHS.indexOf(m[1]); d = +m[2]; y = m[3] ? +m[3] : null; }
  else if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) { mo = +m[1] - 1; d = +m[2]; y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null; }
  if (mo === null || mo < 0 || mo > 11 || !(d >= 1 && d <= 31)) return null;
  const base = new Date(baseUTC);
  let t = new Date(Date.UTC(y || base.getUTCFullYear(), mo, d));
  if (t.getUTCMonth() !== mo) return null;
  if (!y && t.getTime() < baseUTC) t = new Date(Date.UTC(base.getUTCFullYear() + 1, mo, d));
  const wd = WD.find((w) => s.includes(w));
  if (wd && WD.indexOf(wd) !== t.getUTCDay()) return null;
  return t;
}

/** Today's date in Central, as a UTC-anchored midnight (day math only). */
function centralTodayUTC(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  return Date.UTC(+g('year'), +g('month') - 1, +g('day'));
}

/**
 * The day Ed named, read from HIS words by rule, so the model never picks the
 * year. Scar 2026-10-06: "Wednesday, October 7" came back from the model as
 * 2025-10-07 on one run and 2026 on the next. Returns 'YYYY-MM-DD', 'today',
 * 'tomorrow', a weekday, null (he named no day), or 'unreadable' (he named one
 * that does not hold together, e.g. "Thursday, October 7" in 2026). Pure.
 */
function dateFromText(text, baseUTC = centralTodayUTC()) {
  const s = stripNegated(text).toLowerCase();
  const md = s.match(/\b(?:(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?,?\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
  if (md) {
    const t = parseMonthDay(md[0], baseUTC);
    return t ? t.toISOString().slice(0, 10) : 'unreadable';
  }
  if (/\btomorrow\b/.test(s)) return 'tomorrow';
  if (/\btoday\b|\bthis\s+(?:afternoon|morning|evening)\b/.test(s)) return 'today';
  const wd = s.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  return wd ? wd[1] : null;
}

const METHOD_LABEL = { phone: 'Phone call', teams: 'Microsoft Teams', zoom: 'Zoom', in_person: 'In person' };

/**
 * The tessa_outbox row for a meeting Tessa stages. Pure (no I/O).
 * @param mode       classifyCalendarIntent().mode
 * @param method     classifyCalendarIntent().method
 * @param meeting    parsed meeting ({ title, topic, location, message })
 * @param people     resolved people [{ name, email }] (may be empty for calendar_only)
 * @param names      names Ed used, when nobody resolved (calendar_only only)
 * @param phones     { lowercased name or hint: phone } plus the text's phones
 * @param wt         { start, end, tz } wall times
 * @param inviteBody the invitation text (invite/online only)
 */
function buildStagedMeetingRow({ mode, method, meeting = {}, people = [], names = [], phones = [], wt, edMailbox, tessaMailbox, inviteBody = '' }) {
  const who = people.map((p) => p.name).filter(Boolean);
  const label = (who.length ? who : names).join(', ');
  const topic = String(meeting.topic || meeting.title || '').trim();
  const where = METHOD_LABEL[method] || (meeting.location && !/teams/i.test(meeting.location) ? meeting.location : null);
  if (mode === 'calendar_only') {
    const kind = method === 'phone' ? 'call' : 'meeting';
    const subject = [label, topic ? `${topic} ${kind}` : (label ? kind : `${kind}`)].filter(Boolean).join(' - ');
    const lines = [];
    for (const p of (people.length ? people : names.map((n) => ({ name: n })))) {
      lines.push(p.name || '');
      if (p.email) lines.push(`Email: ${p.email}`);
    }
    for (const ph of phones) lines.push(`Direct: ${ph}`);
    if (topic) lines.push(`Regarding: ${topic}`);
    if (where) lines.push(where + '.');
    if (method === 'teams') {
      lines.push(meeting.teams_link
        ? `Teams link: ${meeting.teams_link.url}${meeting.teams_link.subject ? ` (from "${meeting.teams_link.subject}")` : ''}`
        : 'No Teams link on file; join from the organizer’s invitation.');
    }
    lines.push('Added to your calendar by Tessa McCall at your request. No invitation was sent.');
    return {
      kind: 'meeting', status: 'queued', meeting_mode: 'calendar_only', title: subject, subject,
      organizer: edMailbox, meeting_start: wt.start, meeting_end: wt.end, meeting_time_zone: wt.tz,
      meeting_location: where || null, meeting_attendees: '', body_text: lines.filter(Boolean).join('\n'),
      note: 'Calendar entry on Ed’s calendar only (no invitation)',
    };
  }
  // invite / online: Tessa organizes, Ed attends, the named people are invited.
  const seen = new Set();
  const attendees = [...people.map((p) => p.email), edMailbox]
    .map((e) => String(e || '').trim())
    .filter((e) => e && e.toLowerCase() !== String(tessaMailbox || '').toLowerCase())
    .filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const subject = meeting.title || `Meeting with ${label || 'you'}`;
  return {
    kind: 'meeting', status: 'queued', meeting_mode: mode, title: subject, subject,
    organizer: tessaMailbox || edMailbox, meeting_start: wt.start, meeting_end: wt.end, meeting_time_zone: wt.tz,
    meeting_location: mode === 'online' ? 'Microsoft Teams' : (where || meeting.location || null),
    meeting_attendees: attendees.join(', '), body_text: inviteBody, note: 'Set up on Ed’s behalf',
  };
}

module.exports = { parseMonthDay, centralTodayUTC, dateFromText, asksForEmail, stripNegated, teamsLinkFor, classifyCalendarIntent, durationMinutes, phonesIn, buildStagedMeetingRow, METHOD_LABEL };
