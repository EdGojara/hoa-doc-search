// ============================================================================
// lib/time_attendance/payroll.js  (Ed 2026-10-26, migration 547)
// ----------------------------------------------------------------------------
// Payroll-ready hours for a date range, from hours.js timesheets. Pure. Hours
// only, no pay rates (QuickBooks Payroll computes pay).
//
// Overtime is decided per workweek in hours.js and lands on the day it was
// worked, so a range that cuts a workweek (semimonthly) carries exactly the
// overtime worked inside it.
//
// Exceptions that make the numbers incomplete: a missing clock-in or clock-out,
// a shift still open, a correction still pending. The API refuses the export
// (409) while any exist unless the owner overrides with a reason.
// ============================================================================
const { hoursDecimal } = require('./hours');

const SUMMARY_COLS = [
  ['employee', 'Employee'], ['email', 'Email'], ['flsa_status', 'Status'], ['period_start', 'Period start'], ['period_end', 'Period end'],
  ['regular_hours', 'Regular hours'], ['overtime_hours', 'Overtime hours'], ['total_hours', 'Total hours'],
  ['paid_break_hours', 'Paid break hours (included)'], ['unapproved_overtime_hours', 'Overtime without approval (included)'],
  ['corrections_applied', 'Corrections applied'], ['exceptions', 'Open exceptions'],
];
const DETAIL_COLS = [
  ['employee', 'Employee'], ['date', 'Date'], ['direction', 'In/Out'], ['effective_time', 'Time (Central)'], ['original_time', 'Original time (Central)'],
  ['reason', 'Reason'], ['corrected', 'Corrected'], ['origin', 'Origin'],
];
const BLOCKING = new Set(['missing_out', 'missing_in']);
const fmtCentral = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const dateOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

// employees: [{ user_id, full_name, email, flsa_status }]
// sheets: { user_id: computeTimesheet(...) for [from, to] }
// punches: { user_id: effective punches } ; pending: [{ user_id, id, kind, proposed_at, original_at }]
function buildPayroll({ from, to, employees = [], sheets = {}, punches = {}, pending = [] }) {
  const rows = [];
  const exceptions = [];
  const detail = [];
  const byName = [...employees].sort((a, b) => String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
  for (const e of byName) {
    const s = sheets[e.user_id] || { days: [], weeks: [], flags: [], open_shift: null };
    const name = e.full_name || e.email || e.user_id;
    const exc = [];
    for (const f of s.flags || []) if (BLOCKING.has(f.code)) exc.push({ user_id: e.user_id, employee: name, code: f.code, date: f.date, message: f.message });
    if (s.open_shift && !s.open_shift.stale && dateOf(s.open_shift.since) <= to) exc.push({ user_id: e.user_id, employee: name, code: 'open_shift', date: dateOf(s.open_shift.since), message: 'Still clocked in; today\'s hours are not final.' });
    for (const c of pending.filter((p) => p.user_id === e.user_id)) {
      const d = dateOf(c.proposed_at || c.original_at);
      if (d >= from && d <= to) exc.push({ user_id: e.user_id, employee: name, code: 'pending_correction', date: d, message: 'A correction is waiting for approval.', correction_id: c.id });
    }
    exceptions.push(...exc);
    const days = s.days || [];
    const sum = (k) => days.reduce((t, d) => t + (d[k] || 0), 0);
    const inRangeWeeks = (s.weeks || []).filter((w) => w.week_end >= from && w.week_start <= to);
    const effective = (punches[e.user_id] || []).filter((p) => { const d = dateOf(p.effective_at); return d >= from && d <= to; });
    rows.push({
      user_id: e.user_id, employee: name, email: e.email || '', flsa_status: e.flsa_status === 'exempt' ? 'Exempt' : 'Hourly',
      period_start: from, period_end: to,
      regular_hours: hoursDecimal(sum('regular_minutes')), overtime_hours: hoursDecimal(sum('overtime_minutes')), total_hours: hoursDecimal(sum('paid_minutes')),
      paid_break_hours: hoursDecimal(sum('credited_break_minutes')),
      unapproved_overtime_hours: hoursDecimal(inRangeWeeks.reduce((t, w) => t + (w.unapproved_overtime_minutes || 0), 0)),
      corrections_applied: effective.filter((p) => p.is_corrected).length,
      exceptions: exc.length,
    });
    for (const p of [...effective].sort((a, b) => Date.parse(a.effective_at) - Date.parse(b.effective_at))) {
      detail.push({ employee: name, date: dateOf(p.effective_at), direction: p.direction === 'in' ? 'In' : 'Out', effective_time: fmtCentral(p.effective_at),
        original_time: p.origin === 'correction' ? '(added by correction)' : (p.is_corrected ? fmtCentral(p.original_at) : ''),
        reason: String(p.reason || '').replace(/_/g, ' '), corrected: p.is_corrected ? 'Yes' : 'No', origin: p.origin === 'correction' ? 'Correction' : 'Punch' });
    }
  }
  const totals = rows.reduce((t, r) => ({ regular_hours: t.regular_hours + r.regular_hours, overtime_hours: t.overtime_hours + r.overtime_hours, total_hours: t.total_hours + r.total_hours }), { regular_hours: 0, overtime_hours: 0, total_hours: 0 });
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
  return { from, to, rows, exceptions, detail, totals, employee_count: rows.length };
}

// Spreadsheet-safe text: quote, and neutralize a leading formula character.
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(p) {
  return [SUMMARY_COLS.map((c) => c[1]).join(',')].concat(p.rows.map((r) => SUMMARY_COLS.map((c) => cell(r[c[0]])).join(','))).join('\r\n') + '\r\n';
}
function toXlsx(p) {
  const XLSX = require('xlsx');
  const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);
  const wb = XLSX.utils.book_new();
  const sum = XLSX.utils.aoa_to_sheet([SUMMARY_COLS.map((c) => c[1]), ...p.rows.map((r) => SUMMARY_COLS.map((c) => safe(r[c[0]])))]);
  sum['!cols'] = SUMMARY_COLS.map((c) => ({ wch: Math.max(12, c[1].length + 2) }));
  XLSX.utils.book_append_sheet(wb, sum, 'Hours');
  const det = XLSX.utils.aoa_to_sheet([DETAIL_COLS.map((c) => c[1]), ...p.detail.map((r) => DETAIL_COLS.map((c) => safe(r[c[0]])))]);
  det['!cols'] = DETAIL_COLS.map((c) => ({ wch: Math.max(12, c[1].length + 4) }));
  XLSX.utils.book_append_sheet(wb, det, 'Punches');
  if (p.exceptions.length) {
    const ex = XLSX.utils.aoa_to_sheet([['Employee', 'Date', 'Issue'], ...p.exceptions.map((x) => [safe(x.employee), x.date, x.message])]);
    XLSX.utils.book_append_sheet(wb, ex, 'Exceptions');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildPayroll, toCsv, toXlsx, SUMMARY_COLS, DETAIL_COLS };
