// tests/test_time_attendance_hours.js  (Ed 2026-10-26, migration 547) — the one
// paid-hours calculation, pay periods and the payroll export.
//
// Proves: exact in->out time; breaks under 20 min paid; 20-29 min paid and
// flagged (not a bona fide meal period); 30+ min unpaid unless the employee
// worked through it; nothing deducted automatically; open shifts never closed
// by the system; shifts split at Central midnight; the DST fall-back hour
// (Nov 1 2026) counted; Sunday-Saturday overtime assigned to the day worked;
// unapproved overtime still paid and flagged; configurable pay periods.
// A STATIC check fails the build if the hours module ever reads activity
// summaries (work summaries stay separate from payable hours).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../lib/time_attendance/hours');
const { periodFor, recentPeriods } = require('../lib/time_attendance/periods');
const { buildPayroll, toCsv, toXlsx } = require('../lib/time_attendance/payroll');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok ', name); };
// Central wall-clock -> ISO. CDT (-05:00) before Nov 1 2026 02:00, CST (-06:00) after.
const C = (s, off = '-05:00') => new Date(`${s}${off}`).toISOString();
const P = (dir, at, reason, extra = {}) => ({ direction: dir, effective_at: at, reason, ...extra });
const LATER = Date.parse('2026-11-30T12:00:00Z');
const day = (r, k) => r.days.find((d) => d.date === k) || {};
const codes = (r) => r.flags.map((f) => f.code);

console.log('hours.js');
t('a plain 8:00-12:00, 13:00-17:00 day is 8h paid; a 60-minute lunch is unpaid', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift'), P('out', C('2026-10-20T12:00:00'), 'meal_break'), P('in', C('2026-10-20T13:00:00'), 'back_from_meal'), P('out', C('2026-10-20T17:00:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-10-20').paid_minutes, 480);
  assert.strictEqual(day(r, '2026-10-20').credited_break_minutes, 0);
  assert.deepStrictEqual(codes(r), []);
});
t('time is exact to the second, rounded once per day', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:31'), 'start_shift'), P('out', C('2026-10-20T08:07:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-10-20').worked_minutes, 6); // 6m29s
});
t('a 15-minute break is paid (short rest break), with no flag', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift'), P('out', C('2026-10-20T10:00:00'), 'rest_break'), P('in', C('2026-10-20T10:15:00'), 'back_from_break'), P('out', C('2026-10-20T12:00:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-10-20').paid_minutes, 240);
  assert.strictEqual(day(r, '2026-10-20').credited_break_minutes, 15);
  assert.ok(!codes(r).includes('break_20_29'));
});
t('a 25-minute "meal" break is NOT unpaid: paid and flagged for review', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift'), P('out', C('2026-10-20T12:00:00'), 'meal_break'), P('in', C('2026-10-20T12:25:00'), 'back_from_meal'), P('out', C('2026-10-20T16:35:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-10-20').paid_minutes, 8 * 60 + 35);
  assert.ok(codes(r).includes('break_20_29'));
});
t('a 30-minute meal period is unpaid; working through it makes it paid and flagged', () => {
  const base = [P('in', C('2026-10-20T08:00:00'), 'start_shift'), P('out', C('2026-10-20T12:00:00'), 'meal_break')];
  const a = H.computeTimesheet({ now: LATER, punches: [...base, P('in', C('2026-10-20T12:30:00'), 'back_from_meal'), P('out', C('2026-10-20T16:30:00'), 'end_of_shift')] });
  assert.strictEqual(day(a, '2026-10-20').paid_minutes, 480);
  const b = H.computeTimesheet({ now: LATER, punches: [...base, P('in', C('2026-10-20T12:30:00'), 'back_from_meal', { worked_during_break: true }), P('out', C('2026-10-20T16:30:00'), 'end_of_shift')] });
  assert.strictEqual(day(b, '2026-10-20').paid_minutes, 510);
  assert.ok(codes(b).includes('worked_during_break'));
});
t('no automatic lunch deduction: a 10-hour shift with no break is 10 hours', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T07:00:00'), 'start_shift'), P('out', C('2026-10-20T17:00:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-10-20').paid_minutes, 600);
});
t('an open shift from an earlier day is flagged and NOT counted (never auto-closed)', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift', { punch_id: 'p1' })] });
  assert.strictEqual(r.days.length ? day(r, '2026-10-20').paid_minutes : 0, 0);
  assert.ok(codes(r).includes('missing_out'));
  assert.strictEqual(r.open_shift.stale, true);
});
t('a forgotten clock-out followed by the next day\'s clock-in: day 1 flagged, day 2 counted', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift'), P('in', C('2026-10-21T08:00:00'), 'start_shift'), P('out', C('2026-10-21T16:00:00'), 'end_of_shift')] });
  assert.ok(r.flags.some((f) => f.code === 'missing_out' && f.date === '2026-10-20'));
  assert.strictEqual(day(r, '2026-10-21').paid_minutes, 480);
});
t('an orphan clock-out is flagged missing_in and adds nothing', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('out', C('2026-10-20T17:00:00'), 'end_of_shift')] });
  assert.ok(codes(r).includes('missing_in'));
  assert.strictEqual(r.totals.paid_minutes, 0);
});
t('a shift open today counts as live (shown, not final)', () => {
  const now = Date.parse(C('2026-10-20T11:00:00'));
  const r = H.computeTimesheet({ now, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift')] });
  assert.strictEqual(day(r, '2026-10-20').live_minutes, 180);
  assert.strictEqual(day(r, '2026-10-20').paid_minutes, 0);
  assert.strictEqual(r.open_shift.stale, false);
});
t('an overnight shift splits at Central midnight', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T22:00:00'), 'start_shift'), P('out', C('2026-10-21T02:00:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-10-20').paid_minutes, 120);
  assert.strictEqual(day(r, '2026-10-21').paid_minutes, 120);
  assert.ok(codes(r).includes('odd_hours'));
});
t('DST fall-back (Nov 1 2026): 00:00 CDT to 03:00 CST is 4 real hours', () => {
  const r = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-11-01T00:00:00', '-05:00'), 'start_shift'), P('out', C('2026-11-01T03:00:00', '-06:00'), 'end_of_shift')] });
  assert.strictEqual(day(r, '2026-11-01').paid_minutes, 240);
});
t('Central midnight is correct on both sides of DST', () => {
  assert.strictEqual(new Date(H.midnightUtc('2026-10-31')).toISOString(), '2026-10-31T05:00:00.000Z');
  assert.strictEqual(new Date(H.midnightUtc('2026-11-02')).toISOString(), '2026-11-02T06:00:00.000Z');
  assert.strictEqual(new Date(H.midnightUtc('2026-03-08')).toISOString(), '2026-03-08T06:00:00.000Z');
});
// Five 9-hour days Sun 10/18 - Thu 10/22 = 45h; Sunday-Saturday week.
const fiveNines = [18, 19, 20, 21, 22].flatMap((d) => [P('in', C(`2026-10-${d}T08:00:00`), 'start_shift'), P('out', C(`2026-10-${d}T17:00:00`), 'end_of_shift')]);
t('overtime is per Sunday-Saturday week and lands on the day it was worked', () => {
  const r = H.computeTimesheet({ now: LATER, punches: fiveNines });
  const w = r.weeks[0];
  assert.strictEqual(w.week_start, '2026-10-18');
  assert.strictEqual(w.paid_minutes, 2700);
  assert.strictEqual(w.overtime_minutes, 300);
  assert.strictEqual(day(r, '2026-10-21').overtime_minutes, 0);
  assert.strictEqual(day(r, '2026-10-22').regular_minutes, 240);
  assert.strictEqual(day(r, '2026-10-22').overtime_minutes, 300);
});
t('unapproved overtime is recorded in full, paid, and flagged', () => {
  const r = H.computeTimesheet({ now: LATER, punches: fiveNines });
  assert.strictEqual(r.weeks[0].unapproved_overtime_minutes, 300);
  assert.ok(codes(r).includes('over_threshold_unapproved'));
  assert.strictEqual(r.totals.paid_minutes, 2700);
});
t('approved overtime clears the red flag but not the hours', () => {
  const r = H.computeTimesheet({ now: LATER, punches: fiveNines, approvedOvertime: { '2026-10-18': 300 } });
  assert.strictEqual(r.weeks[0].unapproved_overtime_minutes, 0);
  assert.ok(!codes(r).includes('over_threshold_unapproved') && codes(r).includes('over_threshold_approved'));
  assert.strictEqual(r.weeks[0].overtime_minutes, 300);
});
t('approaching 40 (36h+) is flagged', () => {
  const r = H.computeTimesheet({ now: LATER, punches: fiveNines.slice(0, 8) }); // 36h
  assert.ok(codes(r).includes('approaching_threshold'));
});
t('a different workweek start is honoured when configured', () => {
  const r = H.computeTimesheet({ now: LATER, punches: fiveNines, settings: { workweek_start_dow: 1 } });
  assert.deepStrictEqual(r.weeks.map((w) => w.week_start), ['2026-10-12', '2026-10-19']);
});
t('a missing activity summary is a flag only; hours are identical with or without it', () => {
  const a = H.computeTimesheet({ now: LATER, punches: fiveNines, summaryDates: [] });
  const b = H.computeTimesheet({ now: LATER, punches: fiveNines, summaryDates: ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'] });
  assert.ok(codes(a).includes('missing_summary') && !codes(b).includes('missing_summary'));
  assert.deepStrictEqual(a.days, b.days);
});
t('fetchWindow covers whole workweeks plus a day either side', () => {
  const w = H.fetchWindow('2026-10-16', '2026-10-31', {});
  assert.strictEqual(w.from, '2026-10-10');
  assert.strictEqual(w.to, '2026-11-01');
});
t('STATIC: the hours module never reads activity summaries', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'time_attendance', 'hours.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/ta_activity|activity_summar|accomplishments|outstanding/i.test(src), 'hours.js must not read activity summaries');
  assert.ok(!/require\(['"][^'"]*(supabase|activity|read_model)/.test(src), 'hours.js must stay pure');
});

console.log('periods.js');
t('no schedule set -> no period (export takes a date range)', () => assert.strictEqual(periodFor('2026-10-26', {}), null));
t('semimonthly: 1-15 and 16-end', () => {
  assert.deepStrictEqual(periodFor('2026-10-26', { pay_frequency: 'semimonthly' }), { start: '2026-10-16', end: '2026-10-31', frequency: 'semimonthly' });
  assert.deepStrictEqual(periodFor('2026-02-03', { pay_frequency: 'semimonthly' }), { start: '2026-02-01', end: '2026-02-15', frequency: 'semimonthly' });
});
t('biweekly from an anchor, both directions', () => {
  const s = { pay_frequency: 'biweekly', pay_period_anchor: '2026-10-04' };
  assert.deepStrictEqual(periodFor('2026-10-26', s), { start: '2026-10-18', end: '2026-10-31', frequency: 'biweekly' });
  assert.deepStrictEqual(periodFor('2026-09-25', s), { start: '2026-09-20', end: '2026-10-03', frequency: 'biweekly' });
});
t('monthly and weekly', () => {
  assert.deepStrictEqual(periodFor('2026-02-10', { pay_frequency: 'monthly' }), { start: '2026-02-01', end: '2026-02-28', frequency: 'monthly' });
  assert.strictEqual(periodFor('2026-10-26', { pay_frequency: 'weekly', pay_period_anchor: '2026-10-25' }).end, '2026-10-31');
});
t('recentPeriods lists newest first', () => {
  const r = recentPeriods('2026-10-26', { pay_frequency: 'semimonthly' }, 3);
  assert.deepStrictEqual(r.map((p) => p.start), ['2026-10-16', '2026-10-01', '2026-09-16']);
});

console.log('payroll.js');
t('a semimonthly range that cuts a workweek carries only the overtime worked inside it', () => {
  const emp = { user_id: 'u1', full_name: 'Ana Staff', email: 'ana@example.test', flsa_status: 'nonexempt' };
  const sheet = H.computeTimesheet({ now: LATER, punches: fiveNines, from: '2026-10-16', to: '2026-10-21' });
  const p = buildPayroll({ from: '2026-10-16', to: '2026-10-21', employees: [emp], sheets: { u1: sheet } });
  assert.strictEqual(p.rows[0].total_hours, 36);
  assert.strictEqual(p.rows[0].overtime_hours, 0);
  const q = buildPayroll({ from: '2026-10-22', to: '2026-10-31', employees: [emp], sheets: { u1: H.computeTimesheet({ now: LATER, punches: fiveNines, from: '2026-10-22', to: '2026-10-31' }) } });
  assert.strictEqual(q.rows[0].overtime_hours, 5);
  assert.strictEqual(q.rows[0].regular_hours, 4);
});
t('missing punches and pending corrections are exceptions', () => {
  const emp = { user_id: 'u1', full_name: 'Ana Staff' };
  const sheet = H.computeTimesheet({ now: LATER, punches: [P('in', C('2026-10-20T08:00:00'), 'start_shift')], from: '2026-10-16', to: '2026-10-31' });
  const p = buildPayroll({ from: '2026-10-16', to: '2026-10-31', employees: [emp], sheets: { u1: sheet }, pending: [{ id: 'c1', user_id: 'u1', proposed_at: C('2026-10-20T17:00:00') }] });
  assert.deepStrictEqual(p.exceptions.map((x) => x.code).sort(), ['missing_out', 'pending_correction']);
});
t('CSV neutralizes a formula-looking name and has the summary columns', () => {
  const p = buildPayroll({ from: '2026-10-16', to: '2026-10-31', employees: [{ user_id: 'u1', full_name: '=HYPERLINK("x")' }], sheets: {} });
  const csv = toCsv(p);
  assert.ok(csv.startsWith('Employee,Email,Status,Period start,Period end,Regular hours,Overtime hours,Total hours'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});
t('XLSX builds with Hours and Punches sheets', () => {
  const XLSX = require('xlsx');
  const emp = { user_id: 'u1', full_name: 'Ana Staff' };
  const punches = fiveNines.map((p, i) => ({ ...p, punch_id: `p${i}`, origin: 'punch', is_corrected: false }));
  const p = buildPayroll({ from: '2026-10-16', to: '2026-10-31', employees: [emp], sheets: { u1: H.computeTimesheet({ now: LATER, punches, from: '2026-10-16', to: '2026-10-31' }) }, punches: { u1: punches } });
  const wb = XLSX.read(toXlsx(p));
  assert.deepStrictEqual(wb.SheetNames, ['Hours', 'Punches']);
  assert.strictEqual(XLSX.utils.sheet_to_json(wb.Sheets.Punches).length, 10);
});

console.log(`\n${n} passed`);
