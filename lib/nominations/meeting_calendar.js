// ============================================================================
// lib/nominations/meeting_calendar.js  (Ed 2026-08-19)
// ----------------------------------------------------------------------------
// One meeting date in, the whole annual-meeting calendar out.
//
// Ed's ask: staff email the AI team a meeting date and get the documents and
// the dates back. This is the dates half. It exists so nobody counts backwards
// on a legal deadline by hand, and so the arithmetic is the same for every
// community and every year.
//
// THE SPACING IS DERIVED FROM WHAT BEDROCK ACTUALLY DOES, not invented:
// Lakes of Pine Forest (meeting 2026-10-13, nominations close 2026-09-18) and
// Waterview Estates (2026-06-23 / 2026-05-29) are BOTH exactly T-25. The notice
// mails at T-17, per the annual-meeting timing note.
//
//   T-55ish   call for nominations goes out   (whenever staff sends it)
//   T-25      nominations close
//   T-17      annual meeting notice + ballot mailed
//   T         annual meeting
//
// TEXAS PROPERTY CODE 209.0056 is the hard constraint on the third line: notice
// of the annual meeting must be mailed NOT LESS THAN 10 and NOT MORE THAN 60
// days before it. A calendar that violates that produces a challengeable
// election, and the failure is invisible until someone contests the result. So
// the statutory window is CHECKED here, not assumed — if a caller overrides the
// spacing into illegality this refuses rather than returning dates that look
// fine.
//
// Everything returns plain YYYY-MM-DD strings. No timezone maths: these are
// calendar dates on a mailing schedule, not instants.
// ============================================================================

// Texas Property Code 209.0056(a) — the outer bounds on annual meeting notice.
const TX_209_NOTICE_MIN_DAYS = 10;
const TX_209_NOTICE_MAX_DAYS = 60;

// Bedrock's house spacing, matching every cycle actually run.
const DEFAULT_NOMINATIONS_CLOSE_DAYS_BEFORE = 25;
const DEFAULT_NOTICE_MAIL_DAYS_BEFORE = 17;

function toDate(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const dt = new Date(s + 'T12:00:00Z');       // midday UTC: no DST edge can shift the day
  return isNaN(dt.getTime()) ? null : dt;
}
function iso(dt) { return dt.toISOString().slice(0, 10); }
function minusDays(dt, n) { return new Date(dt.getTime() - n * 86400000); }
function dayName(dt) {
  return dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
function pretty(dt) {
  return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Build the calendar for one annual meeting.
 *
 * @param {string} annualMeetingDate  YYYY-MM-DD
 * @param {object} [opts]
 *   nominationsCloseDaysBefore  default 25
 *   noticeMailDaysBefore        default 17
 *   nominationsOpenAt           YYYY-MM-DD, defaults to today
 * @returns {{ok:true, ...}|{ok:false, error:string}}
 */
function buildMeetingCalendar(annualMeetingDate, opts = {}) {
  const meeting = toDate(annualMeetingDate);
  if (!meeting) return { ok: false, error: 'annual_meeting_date must be YYYY-MM-DD' };

  const closeBefore = Number.isFinite(opts.nominationsCloseDaysBefore)
    ? Number(opts.nominationsCloseDaysBefore) : DEFAULT_NOMINATIONS_CLOSE_DAYS_BEFORE;
  const noticeBefore = Number.isFinite(opts.noticeMailDaysBefore)
    ? Number(opts.noticeMailDaysBefore) : DEFAULT_NOTICE_MAIL_DAYS_BEFORE;

  // The statutory check. Refuse rather than return a plausible illegal date.
  if (noticeBefore < TX_209_NOTICE_MIN_DAYS || noticeBefore > TX_209_NOTICE_MAX_DAYS) {
    return {
      ok: false,
      error: `notice would mail ${noticeBefore} days before the meeting, outside the Texas Property Code 209.0056 window of ${TX_209_NOTICE_MIN_DAYS}-${TX_209_NOTICE_MAX_DAYS} days. An election noticed outside that window is challengeable.`,
    };
  }
  // Nominations must close before the notice mails — the notice carries the
  // ballot, so a nomination arriving after it has nowhere to go.
  if (closeBefore <= noticeBefore) {
    return {
      ok: false,
      error: `nominations would close ${closeBefore} days before the meeting but the notice mails at ${noticeBefore} days. Nominations must close FIRST or late candidates miss the ballot.`,
    };
  }

  const close = minusDays(meeting, closeBefore);
  const notice = minusDays(meeting, noticeBefore);
  const open = toDate(opts.nominationsOpenAt) || toDate(iso(new Date()));

  const warnings = [];
  if (open >= close) warnings.push('Nominations open on or after they close — check the open date.');
  const leadDays = Math.round((close.getTime() - open.getTime()) / 86400000);
  if (leadDays >= 0 && leadDays < 14) {
    warnings.push(`Only ${leadDays} days for homeowners to nominate. Bedrock cycles normally allow 30 or more.`);
  }
  if (meeting.getTime() < Date.now()) warnings.push('The meeting date is in the past.');
  // Mail does not move on Sunday, and a Saturday drop is effectively Monday.
  // That silently eats two days of a statutory notice window.
  const noticeDow = notice.getUTCDay();
  if (noticeDow === 0 || noticeDow === 6) {
    warnings.push(`The notice would mail on a ${dayName(notice)}. Mail it the preceding Friday so the statutory window is not shortened.`);
  }

  return {
    ok: true,
    milestones: [
      { key: 'nominations_open',  date: iso(open),    label: 'Call for nominations goes out', pretty: pretty(open) },
      { key: 'nominations_close', date: iso(close),   label: 'Nominations close',             pretty: pretty(close), days_before: closeBefore },
      { key: 'notice_mailed',     date: iso(notice),  label: 'Annual meeting notice + ballot mailed', pretty: pretty(notice), days_before: noticeBefore, statutory: 'Texas Property Code 209.0056' },
      { key: 'annual_meeting',    date: iso(meeting), label: 'Annual meeting',                pretty: pretty(meeting), day: dayName(meeting) },
    ],
    nominations_open_at: iso(open),
    nominations_close_at: iso(close),
    notice_mail_at: iso(notice),
    annual_meeting_date: iso(meeting),
    statutory_ok: true,
    notice_days_before: noticeBefore,
    warnings,
  };
}

module.exports = {
  buildMeetingCalendar,
  TX_209_NOTICE_MIN_DAYS,
  TX_209_NOTICE_MAX_DAYS,
  DEFAULT_NOMINATIONS_CLOSE_DAYS_BEFORE,
  DEFAULT_NOTICE_MAIL_DAYS_BEFORE,
};
