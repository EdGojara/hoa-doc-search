// ============================================================================
// lib/time_attendance/periods.js  (Ed 2026-10-26, migration 547)
// ----------------------------------------------------------------------------
// Payroll periods from ta_settings (configurable; NULL until the QuickBooks
// payroll schedule is entered). Pure. The overtime WORKWEEK is separate and
// never follows the pay period (hours.js).
//   weekly       7 days from pay_period_anchor
//   biweekly     14 days from pay_period_anchor
//   semimonthly  1st-15th and 16th-end of month
//   monthly      calendar month
// ============================================================================
const { addDays } = require('./hours');
const parseKeySafe = (k) => String(k).split('-').map(Number);

const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function lastOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
function daysDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

// The pay period containing date k, or null when no schedule is set.
function periodFor(k, settings = {}) {
  const f = settings && settings.pay_frequency;
  if (!f || !DATE.test(String(k))) return null;
  const [y, m, d] = parseKeySafe(k);
  if (f === 'monthly') return { start: `${k.slice(0, 7)}-01`, end: lastOfMonth(y, m), frequency: f };
  if (f === 'semimonthly') return d <= 15
    ? { start: `${k.slice(0, 7)}-01`, end: `${k.slice(0, 7)}-15`, frequency: f }
    : { start: `${k.slice(0, 7)}-16`, end: lastOfMonth(y, m), frequency: f };
  const len = f === 'weekly' ? 7 : f === 'biweekly' ? 14 : 0;
  const anchor = settings.pay_period_anchor;
  if (!len || !anchor || !DATE.test(String(anchor))) return null;
  const n = Math.floor(daysDiff(anchor, k) / len);
  const start = addDays(anchor, n * len);
  return { start, end: addDays(start, len - 1), frequency: f };
}

// The current period and the `count - 1` before it, newest first.
function recentPeriods(today, settings = {}, count = 6) {
  const out = [];
  let p = periodFor(today, settings);
  while (p && out.length < count) { out.push(p); p = periodFor(addDays(p.start, -1), settings); }
  return out;
}

module.exports = { periodFor, recentPeriods, FREQUENCIES };
