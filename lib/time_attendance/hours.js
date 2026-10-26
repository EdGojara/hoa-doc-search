// ============================================================================
// lib/time_attendance/hours.js  (Ed 2026-10-26, migration 547)
// ----------------------------------------------------------------------------
// The ONE calculation of paid hours. Pure: no database, no clock except the
// `now` passed in, no model calls. Reads effective punches only (originals with
// approved corrections applied, v_ta_effective_punches). It never reads activity
// summaries; tests/test_time_attendance_hours.js fails the build if it does.
//
// Rules
//   - Paid time is each clock-in to the next clock-out, to the second. No rounding
//     of punches; minutes are rounded once per day for display and payroll.
//   - Time clocked out is not worked time, with two exceptions that ADD time:
//       * a gap under 30 minutes between a clock-out and the next clock-in is paid.
//         Under 20 minutes is a short rest break (federal rule: paid). 20-29 minutes
//         is not a bona fide meal period (those are 30+ minutes, free of duties), so
//         it stays paid and is flagged for review.
//       * a gap of 30+ minutes is paid when the employee says they worked during it.
//     Nothing is ever deducted automatically: no auto-lunch, no closing an open
//     shift, no deduction for a missing activity summary.
//   - Days and workweeks are Central time (America/Chicago). Timestamps are UTC
//     instants, so the repeated hour when DST ends is counted correctly.
//   - A shift still open from an earlier day (or for 16+ hours) is a missing
//     punch: it is flagged and NOT counted until a correction is approved.
//     A shift open today counts as "live" (shown, never exported).
//   - Overtime is per fixed workweek (default Sunday-Saturday): minutes past the
//     threshold, assigned to the days on which they were worked.
// ============================================================================

const TZ = 'America/Chicago';
const MIN = 60000;
const HOUR = 60 * MIN;
const SHORT_BREAK_MS = 20 * MIN;      // under this: rest break, paid
const BONA_FIDE_MEAL_MS = 30 * MIN;   // under this: not a bona fide meal period, paid
const STALE_OPEN_MS = 16 * HOUR;      // an open shift older than this is a missing punch
const LONG_SHIFT_MS = 12 * HOUR;
const APPROACHING_MINUTES = 240;      // flag at threshold - 4 h (36 h of 40)
const MANY_PUNCHES = 8;
const DEFAULT_SETTINGS = { workweek_start_dow: 0, weekly_threshold_minutes: 2400 };

// ---- Central calendar helpers ------------------------------------------------
const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const _hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
const _offFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });

function dateKey(ms) { return _dateFmt.format(new Date(ms)); }
function centralHour(ms) { return Number(_hourFmt.format(new Date(ms))) % 24; }
function offsetMinutes(ms) {
  const part = _offFmt.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part ? part.value : '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}
function parseKey(k) { const [y, m, d] = String(k).split('-').map(Number); return { y, m, d }; }
// UTC instant of 00:00 Central on a date. DST switches at 2 AM, so the offset at
// 06:00 UTC (midnight or 1 AM Central) is the offset in force at midnight.
function midnightUtc(k) {
  const { y, m, d } = parseKey(k);
  const base = Date.UTC(y, m - 1, d);
  return base - offsetMinutes(base + 6 * HOUR) * MIN;
}
function addDays(k, n) {
  const { y, m, d } = parseKey(k);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dow(k) { const { y, m, d } = parseKey(k); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function weekStart(k, startDow = 0) { return addDays(k, -((dow(k) - startDow + 7) % 7)); }
function daysBetween(a, b) { const out = []; for (let k = a; k <= b; k = addDays(k, 1)) out.push(k); return out; }

// ---- core ----------------------------------------------------------------------
// punches: [{ direction:'in'|'out', effective_at, reason, worked_during_break, punch_id, correction_id }]
// approvedOvertime: { 'YYYY-MM-DD' (week start): minutes }
// summaryDates: Set/array of dates with an activity summary (used ONLY to flag a
//   missing summary; never to change hours).
function computeTimesheet({ punches = [], settings = {}, now = Date.now(), approvedOvertime = {}, flsaStatus = 'nonexempt', summaryDates = null, from = null, to = null } = {}) {
  const S = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const threshold = Number(S.weekly_threshold_minutes) || 2400;
  const wsDow = Number(S.workweek_start_dow) || 0;
  const today = dateKey(now);
  const flags = [];
  const flag = (code, date, severity, message, extra = {}) => flags.push({ code, date, severity, message, ...extra });

  const P = (punches || [])
    .map((p) => ({ ...p, t: Date.parse(p.effective_at) }))
    .filter((p) => Number.isFinite(p.t) && (p.direction === 'in' || p.direction === 'out'))
    .sort((a, b) => a.t - b.t);

  // 1) segments: work (in -> out), credited (paid break gaps), live (open today)
  const segs = [];
  let open = null;
  let lastOut = null;
  for (const p of P) {
    if (p.direction === 'in') {
      if (open) {
        flag('missing_out', dateKey(open.t), 'bad', 'Clocked in without a clock-out before the next clock-in. Request a correction for the missing clock-out.', { punch_id: open.punch_id || null });
        lastOut = null;
      }
      if (lastOut) {
        const gap = p.t - lastOut.t;
        const k = dateKey(lastOut.t);
        if (gap > 0 && gap < SHORT_BREAK_MS) {
          segs.push({ kind: 'credited', start: lastOut.t, end: p.t, why: 'short_break' });
        } else if (gap >= SHORT_BREAK_MS && gap < BONA_FIDE_MEAL_MS) {
          segs.push({ kind: 'credited', start: lastOut.t, end: p.t, why: 'under_30' });
          flag('break_20_29', k, 'warn', `A ${Math.round(gap / MIN)}-minute ${lastOut.reason === 'meal_break' ? 'meal break' : 'break'} is under 30 minutes, so it is paid. Review if this was meant as an unpaid meal period.`, { punch_id: p.punch_id || null });
        } else if (gap >= BONA_FIDE_MEAL_MS && p.worked_during_break) {
          segs.push({ kind: 'credited', start: lastOut.t, end: p.t, why: 'worked_during_break' });
          flag('worked_during_break', k, 'warn', `Reported working during a ${Math.round(gap / MIN)}-minute break; the break is paid.`, { punch_id: p.punch_id || null });
        }
      }
      open = p; lastOut = null;
    } else {
      if (!open) {
        flag('missing_in', dateKey(p.t), 'bad', 'Clocked out without a matching clock-in. Request a correction for the missing clock-in.', { punch_id: p.punch_id || null });
        lastOut = null;
        continue;
      }
      segs.push({ kind: 'work', start: open.t, end: p.t });
      if (p.t - open.t > LONG_SHIFT_MS) flag('long_shift', dateKey(open.t), 'warn', `A single shift of ${(Math.round((p.t - open.t) / MIN) / 60).toFixed(1)} hours.`, { punch_id: open.punch_id || null });
      open = null; lastOut = p;
    }
  }
  let openShift = null;
  if (open) {
    const stale = now - open.t >= STALE_OPEN_MS || dateKey(open.t) !== today;
    if (stale) flag('missing_out', dateKey(open.t), 'bad', 'Still clocked in from an earlier day. Request a correction for the missing clock-out; these hours are not counted until it is approved.', { punch_id: open.punch_id || null });
    else segs.push({ kind: 'live', start: open.t, end: Math.max(open.t, now) });
    openShift = { since: new Date(open.t).toISOString(), stale, punch_id: open.punch_id || null };
  }

  // 2) split at Central midnight into day buckets
  const days = {};
  const day = (k) => (days[k] || (days[k] = { date: k, worked_ms: 0, credited_ms: 0, live_ms: 0, punch_count: 0 }));
  for (const s of segs) {
    let a = s.start;
    while (a < s.end) {
      const k = dateKey(a);
      const b = Math.min(s.end, midnightUtc(addDays(k, 1)));
      const d = day(k);
      if (s.kind === 'work') d.worked_ms += b - a; else if (s.kind === 'credited') d.credited_ms += b - a; else d.live_ms += b - a;
      a = b;
    }
  }
  for (const p of P) {
    day(dateKey(p.t)).punch_count += 1;
    const h = centralHour(p.t);
    if (h >= 22 || h < 5) flag('odd_hours', dateKey(p.t), 'info', `A punch at ${new Date(p.t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })}.`, { punch_id: p.punch_id || null });
  }
  for (const d of Object.values(days)) if (d.punch_count > MANY_PUNCHES) flag('many_punches', d.date, 'info', `${d.punch_count} punches in one day.`);

  // 3) per-day minutes, then workweeks with overtime assigned chronologically
  const dayRows = Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const worked = Math.round(d.worked_ms / MIN);
    const credited = Math.round(d.credited_ms / MIN);
    return { date: d.date, week_start: weekStart(d.date, wsDow), worked_minutes: worked, credited_break_minutes: credited,
      paid_minutes: worked + credited, live_minutes: Math.round(d.live_ms / MIN), punch_count: d.punch_count, regular_minutes: 0, overtime_minutes: 0 };
  });
  const weeks = {};
  for (const d of dayRows) {
    const w = weeks[d.week_start] || (weeks[d.week_start] = { week_start: d.week_start, week_end: addDays(d.week_start, 6), paid_minutes: 0, live_minutes: 0, regular_minutes: 0, overtime_minutes: 0 });
    const before = w.paid_minutes;
    d.regular_minutes = Math.max(0, Math.min(d.paid_minutes, threshold - before));
    d.overtime_minutes = d.paid_minutes - d.regular_minutes;
    w.paid_minutes += d.paid_minutes; w.live_minutes += d.live_minutes;
    w.regular_minutes += d.regular_minutes; w.overtime_minutes += d.overtime_minutes;
  }
  const weekRows = Object.values(weeks).sort((a, b) => a.week_start.localeCompare(b.week_start)).map((w) => {
    const approved = Number(approvedOvertime[w.week_start]) || 0;
    const withLive = w.paid_minutes + w.live_minutes;
    const unapproved = Math.max(0, w.paid_minutes - threshold - approved);
    if (unapproved > 0) flag('over_threshold_unapproved', w.week_end <= today ? w.week_end : today, 'bad', `${fmtH(w.paid_minutes)} worked in the week of ${fmtDay(w.week_start)}; ${fmtH(unapproved)} past ${fmtH(threshold)} without approval. All hours are recorded and paid.`, { week_start: w.week_start });
    else if (w.paid_minutes > threshold) flag('over_threshold_approved', w.week_end <= today ? w.week_end : today, 'info', `${fmtH(w.paid_minutes - threshold)} of approved overtime in the week of ${fmtDay(w.week_start)}.`, { week_start: w.week_start });
    else if (withLive >= threshold - APPROACHING_MINUTES) flag('approaching_threshold', today < w.week_end ? today : w.week_end, 'warn', `${fmtH(withLive)} so far in the week of ${fmtDay(w.week_start)}; ${fmtH(Math.max(0, threshold - withLive))} left before ${fmtH(threshold)}.`, { week_start: w.week_start });
    return { ...w, threshold_minutes: threshold, approved_overtime_minutes: approved, unapproved_overtime_minutes: unapproved, so_far_minutes: withLive };
  });

  // 4) missing activity summary (a flag only; never affects hours)
  if (summaryDates && flsaStatus === 'nonexempt') {
    const have = new Set(summaryDates);
    for (const d of dayRows) if (d.paid_minutes > 0 && d.date < today && !have.has(d.date)) flag('missing_summary', d.date, 'info', 'No activity summary for this day.');
  }

  const inRange = (k) => (!from || k >= from) && (!to || k <= to);
  return {
    days: dayRows.filter((d) => inRange(d.date)),
    weeks: weekRows.filter((w) => (!from || w.week_end >= from) && (!to || w.week_start <= to)),
    flags: flags.filter((f) => !f.date || inRange(f.date)),
    open_shift: openShift,
    totals: dayRows.filter((d) => inRange(d.date)).reduce((t, d) => ({ paid_minutes: t.paid_minutes + d.paid_minutes, regular_minutes: t.regular_minutes + d.regular_minutes, overtime_minutes: t.overtime_minutes + d.overtime_minutes, live_minutes: t.live_minutes + d.live_minutes }), { paid_minutes: 0, regular_minutes: 0, overtime_minutes: 0, live_minutes: 0 }),
  };
}

// 'Oct 25' for a date key (messages are read by people, not parsed).
function fmtDay(k) { const { y, m, d } = parseKey(k); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }); }

function fmtH(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const hoursDecimal = (minutes) => Math.round(((Number(minutes) || 0) / 60) * 100) / 100;

// The punch-fetch window needed to compute [from, to] correctly: whole workweeks,
// plus a day either side so a shift crossing a boundary is complete.
function fetchWindow(from, to, settings = {}) {
  const wsDow = Number((settings || {}).workweek_start_dow) || 0;
  const a = addDays(weekStart(from, wsDow), -1);
  const b = addDays(addDays(weekStart(to, wsDow), 6), 1);
  return { from: a, to: b, fromIso: new Date(midnightUtc(a)).toISOString(), toIso: new Date(midnightUtc(addDays(b, 1))).toISOString() };
}

module.exports = {
  computeTimesheet, fetchWindow, fmtH, hoursDecimal,
  dateKey, midnightUtc, addDays, dow, weekStart, daysBetween, offsetMinutes,
  RULES: { SHORT_BREAK_MS, BONA_FIDE_MEAL_MS, STALE_OPEN_MS, LONG_SHIFT_MS, APPROACHING_MINUTES, MANY_PUNCHES },
};
