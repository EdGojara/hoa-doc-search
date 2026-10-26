// ============================================================================
// api/time_attendance.js  (Ed 2026-10-26, migration 547) — Staff Time & Attendance
// ----------------------------------------------------------------------------
// Employee routes (any signed-in staffer; identity from their own Supabase JWT):
//   GET  /api/time/me?from=&to=            my status, timesheet, requests, summary
//   POST /api/time/punch                   { direction, reason, note?, worked_during_break? }
//   POST /api/time/corrections             { kind, punch_id?, direction?, date, time, punch_reason?, worked_during_break?, reason }
//   POST /api/time/corrections/:id/withdraw
//   POST /api/time/overtime                { week_start, hours, reason }
//   POST /api/time/activity                { work_date, categories[], accomplishments, outstanding, notes?, community_ids[] }
// Employee routes read and write through a Supabase client carrying the
// employee's OWN token, so the database's row-level security (own rows only)
// applies in addition to this code; no route accepts an employee id.
//
// Owner routes (requireOwner; service client; every change is a 547 function
// that records the approving administrator, time and reason in audit_events):
//   GET  /api/time/admin/overview?from=&to=
//   GET  /api/time/admin/timesheet/:userId?from=&to=
//   GET  /api/time/admin/activity?from=&to=
//   POST /api/time/admin/corrections/:id/decide   { decision, reason }
//   POST /api/time/admin/overtime/:id/decide      { decision, reason }
//   POST /api/time/admin/employees                { user_id, flsa_status, tracks_time, active, reason }
//   POST /api/time/admin/settings                 { workweek_start_dow, weekly_threshold_hours, pay_frequency, pay_period_anchor, reason }
//   GET  /api/time/admin/payroll?from=&to=&format=json|csv|xlsx&override_reason=
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { getAuthedUser, requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { recordAuditEvent, routeOf } = require('../lib/audit/record_event');
const H = require('../lib/time_attendance/hours');
const RM = require('../lib/time_attendance/read_model');
const { periodFor, recentPeriods, FREQUENCIES } = require('../lib/time_attendance/periods');
const { buildPayroll, toCsv, toXlsx } = require('../lib/time_attendance/payroll');
const { isOperational } = require('../lib/community/lifecycle');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));

let _sb = null;
const service = () => (_sb || (_sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)));
// A client that acts AS the employee: anon key + their access token, so RLS applies.
function asEmployee(req) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  const auth = String((req.headers && req.headers.authorization) || '');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const IN_REASONS = { start_shift: 'Start of day', back_from_break: 'Back from break', back_from_meal: 'Back from lunch', back_from_personal: 'Back from personal time', other: 'Other' };
const OUT_REASONS = { rest_break: 'Break', meal_break: 'Lunch', personal: 'Personal', end_of_shift: 'Done for the day', other: 'Other' };
const MAX_RANGE_DAYS = 93;

// Plain words for the database's refusals.
const FRIENDLY = [
  [/ta_sequence: already clocked in/, 409, 'already_clocked_in', 'You are already clocked in.'],
  [/ta_sequence: not clocked in/, 409, 'not_clocked_in', 'You are not clocked in.'],
  [/ta_not_enrolled/, 403, 'not_enrolled', 'Your account is not set up for time & attendance yet. Ask Ed to enroll you.'],
  [/ta_auth: sign in/, 401, 'sign_in_required', 'Sign in again.'],
  [/ta_auth: only an active administrator/, 403, 'owner_only', 'Only an administrator can do this.'],
  [/other_needs_note/, 400, 'note_required', 'Add a short note when the reason is Other.'],
  [/uq_ta_corrections_one_pending_per_punch/, 409, 'already_pending', 'There is already a pending correction for that punch.'],
  [/not this employee/, 403, 'not_yours', 'That punch is not yours.'],
  [/cannot be in the future/, 400, 'future_time', 'A corrected time cannot be in the future.'],
  [/same as the original/, 400, 'same_time', 'The corrected time is the same as the original.'],
  [/reason_not_blank|reason is required/, 400, 'reason_required', 'A reason is required.'],
  [/decision_coherent/, 400, 'reason_required', 'A reason is required for the decision.'],
  [/no_self_approval/, 403, 'self_approval', 'No one can approve their own time.'],
  [/decided request is final/, 409, 'already_decided', 'This request was already decided.'],
  [/cannot enroll themself/, 400, 'self_enroll', 'An administrator cannot enroll themself; no one could approve their corrections.'],
  [/categories_check/, 400, 'bad_category', 'Choose at least one category from the list.'],
  [/activity_summaries_text_check/, 400, 'summary_incomplete', 'Fill in what you accomplished and what is outstanding.'],
  [/future day/, 400, 'future_day', 'A summary cannot be for a future day.'],
  [/minutes_check/, 400, 'bad_hours', 'Overtime requests are between 15 minutes and 40 hours.'],
  [/anchor_needed/, 400, 'anchor_required', 'Weekly and biweekly schedules need the first day of a pay period.'],
  [/no pending request/, 404, 'not_found', 'No pending request of yours with that id.'],
  [/violates foreign key constraint .*community/, 400, 'bad_community', 'One of the tagged communities was not found.'],
];
function sendDbError(res, where, err) {
  const msg = String((err && err.message) || err || '');
  for (const [re, status, code, detail] of FRIENDLY) if (re.test(msg)) return res.status(status).json({ error: code, detail });
  console.error(`[time] ${where} failed:`, msg);
  return res.status(500).json({ error: safeErrorMessage(err) });
}

function rangeFrom(q, now = Date.now(), defDays = 14) {
  const today = H.dateKey(now);
  let to = DATE.test(String(q.to || '')) ? String(q.to) : today;
  let from = DATE.test(String(q.from || '')) ? String(q.from) : H.addDays(to, -(defDays - 1));
  if (from > to) [from, to] = [to, from];
  if (H.daysBetween(from, to).length > MAX_RANGE_DAYS) from = H.addDays(to, -(MAX_RANGE_DAYS - 1));
  return { from, to, today };
}
// Central wall-clock date + time -> UTC ISO (the offset in force at that moment).
function centralToIso(date, time) {
  const [y, m, d] = date.split('-').map(Number); const [, hh, mm] = TIME.exec(time);
  const wall = Date.UTC(y, m - 1, d, Number(hh), Number(mm));
  const t0 = wall - H.offsetMinutes(wall) * 60000;
  return new Date(wall - H.offsetMinutes(t0) * 60000).toISOString();
}
const clientIp = (req) => String(req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 100) || null;

async function employeeContext(req, res) {
  const u = await getAuthedUser(req);
  if (!u) { res.status(401).json({ error: 'sign_in_required', detail: 'Sign in to use time & attendance.' }); return null; }
  const db = asEmployee(req);
  if (!db) { res.status(503).json({ error: 'not_configured', detail: 'Time & attendance is not configured on this server.' }); return null; }
  return { u, db };
}

// ---- employee -----------------------------------------------------------------------
router.get('/me', async (req, res) => {
  const ctx = await employeeContext(req, res); if (!ctx) return;
  const { u, db } = ctx;
  const now = Date.now();
  try {
    const { from, to, today } = rangeFrom(req.query, now);
    const emp = (await RM.loadEmployees(db, { userId: u.user.id }))[0] || null;
    const settings = await RM.loadSettings(db);
    const base = { user: { id: u.user.id, name: u.full_name || u.email }, enrolled: !!emp, employee: emp, settings, today,
      categories: RM.CATEGORIES.map(([value, label]) => ({ value, label })), in_reasons: IN_REASONS, out_reasons: OUT_REASONS };
    if (!emp) return res.json(base);
    const wkFrom = H.weekStart(today, settings.workweek_start_dow);
    const lo = from < wkFrom ? from : wkFrom;
    const [{ sheets, punches, summaries }, corrections, overtime, comms] = await Promise.all([
      RM.timesheets(db, { employees: [emp], from: lo, to: today > to ? today : to, now, settings }),
      RM.loadCorrections(db, { limit: 50 }),
      RM.loadOvertime(db, { limit: 20 }),
      service().from('communities').select('id, name, management_status, management_end_date').order('name').limit(500),
    ]);
    const sheet = sheets[emp.user_id];
    const mine = punches[emp.user_id] || [];
    const last = mine[mine.length - 1] || null;
    const clockedIn = !!(sheet.open_shift && !sheet.open_shift.stale);
    const lastOut = last && last.direction === 'out' && H.dateKey(Date.parse(last.effective_at)) === today ? last : null;
    const suggestedIn = !lastOut ? 'start_shift' : ({ rest_break: 'back_from_break', meal_break: 'back_from_meal', personal: 'back_from_personal' }[lastOut.reason] || 'start_shift');
    const week = sheet.weeks.find((w) => w.week_start === wkFrom) || { paid_minutes: 0, live_minutes: 0, so_far_minutes: 0, threshold_minutes: settings.weekly_threshold_minutes, approved_overtime_minutes: 0 };
    const todayRow = sheet.days.find((d) => d.date === today) || { paid_minutes: 0, live_minutes: 0 };
    const todaySummary = summaries.filter((s) => s.work_date === today).sort((a, b) => b.version - a.version)[0] || null;
    res.json({ ...base,
      status: { clocked_in: clockedIn, since: clockedIn ? sheet.open_shift.since : null, stale_open: sheet.open_shift && sheet.open_shift.stale ? sheet.open_shift : null,
        last_punch: last, suggested_in_reason: suggestedIn, last_out_reason: lastOut ? lastOut.reason : null },
      today_row: todayRow, week,
      timesheet: { from, to, days: sheet.days.filter((d) => d.date >= from && d.date <= to), weeks: sheet.weeks, flags: sheet.flags.filter((f) => !f.date || (f.date >= from && f.date <= today)) },
      punches: mine.filter((p) => { const d = H.dateKey(Date.parse(p.effective_at)); return d >= from && d <= to; }),
      corrections, overtime, today_summary: todaySummary,
      communities: (comms.data || []).filter((c) => isOperational(c)).map((c) => ({ id: c.id, name: c.name })),
    });
  } catch (e) { sendDbError(res, 'me', e); }
});

router.post('/punch', async (req, res) => {
  const ctx = await employeeContext(req, res); if (!ctx) return;
  const b = req.body || {};
  const direction = b.direction === 'in' || b.direction === 'out' ? b.direction : null;
  if (!direction) return res.status(400).json({ error: 'direction_required', detail: 'Clock in or clock out?' });
  const reasons = direction === 'in' ? IN_REASONS : OUT_REASONS;
  if (!reasons[b.reason]) return res.status(400).json({ error: 'reason_required', detail: 'Choose a reason.' });
  try {
    // The time is NOT taken from the request: the database sets it.
    const { data, error } = await ctx.db.rpc('ta_punch', { p_direction: direction, p_reason: b.reason, p_note: b.note ? String(b.note).slice(0, 500) : null,
      p_worked_during_break: direction === 'in' && b.worked_during_break === true, p_client_ip: clientIp(req), p_user_agent: String(req.get('user-agent') || '').slice(0, 300) });
    if (error) return sendDbError(res, 'punch', error);
    res.json({ ok: true, punch: data });
  } catch (e) { sendDbError(res, 'punch', e); }
});

router.post('/corrections', async (req, res) => {
  const ctx = await employeeContext(req, res); if (!ctx) return;
  const b = req.body || {};
  const kind = ['add_punch', 'change_time', 'void_punch'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'kind_required', detail: 'Add a missing punch, change a time, or remove a punch?' });
  if (kind !== 'add_punch' && !UUID.test(String(b.punch_id || ''))) return res.status(400).json({ error: 'punch_required', detail: 'Choose the punch to correct.' });
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'reason_required', detail: 'Say why the correction is needed.' });
  let at = null;
  if (kind !== 'void_punch') {
    if (!DATE.test(String(b.date || '')) || !TIME.test(String(b.time || ''))) return res.status(400).json({ error: 'time_required', detail: 'Enter the correct date and time.' });
    at = centralToIso(b.date, b.time);
  }
  let direction = null; let punchReason = null;
  if (kind === 'add_punch') {
    direction = b.direction === 'in' || b.direction === 'out' ? b.direction : null;
    if (!direction) return res.status(400).json({ error: 'direction_required', detail: 'Is the missing punch a clock-in or a clock-out?' });
    punchReason = (direction === 'in' ? IN_REASONS : OUT_REASONS)[b.punch_reason] ? b.punch_reason : (direction === 'in' ? 'start_shift' : 'end_of_shift');
  }
  try {
    const { data, error } = await ctx.db.rpc('ta_request_correction', { p_kind: kind, p_punch_id: kind === 'add_punch' ? null : b.punch_id, p_proposed_direction: direction,
      p_proposed_at: at, p_proposed_reason: punchReason, p_worked_during_break: direction === 'in' && b.worked_during_break === true, p_reason: String(b.reason).slice(0, 1000) });
    if (error) return sendDbError(res, 'correction', error);
    res.json({ ok: true, correction: data });
  } catch (e) { sendDbError(res, 'correction', e); }
});

router.post('/corrections/:id/withdraw', async (req, res) => {
  const ctx = await employeeContext(req, res); if (!ctx) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const { data, error } = await ctx.db.rpc('ta_withdraw_correction', { p_id: req.params.id });
    if (error) return sendDbError(res, 'withdraw', error);
    res.json({ ok: true, correction: data });
  } catch (e) { sendDbError(res, 'withdraw', e); }
});

router.post('/overtime', async (req, res) => {
  const ctx = await employeeContext(req, res); if (!ctx) return;
  const b = req.body || {};
  const minutes = Math.round(Number(b.hours) * 60);
  if (!DATE.test(String(b.week_start || ''))) return res.status(400).json({ error: 'week_required', detail: 'Which week?' });
  if (!Number.isFinite(minutes) || minutes < 15) return res.status(400).json({ error: 'bad_hours', detail: 'How many extra hours?' });
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'reason_required', detail: 'Say why the extra hours are needed.' });
  try {
    const settings = await RM.loadSettings(ctx.db);
    const ws = H.weekStart(b.week_start, settings.workweek_start_dow);
    const { data, error } = await ctx.db.rpc('ta_request_overtime', { p_week_start: ws, p_extra_minutes: minutes, p_reason: String(b.reason).slice(0, 1000) });
    if (error) return sendDbError(res, 'overtime', error);
    res.json({ ok: true, request: data });
  } catch (e) { sendDbError(res, 'overtime', e); }
});

router.post('/activity', async (req, res) => {
  const ctx = await employeeContext(req, res); if (!ctx) return;
  const b = req.body || {};
  const cats = Array.isArray(b.categories) ? b.categories.map(String).filter((c) => RM.CATEGORY_LABEL[c]) : [];
  const cids = Array.isArray(b.community_ids) ? [...new Set(b.community_ids.map(String).filter((c) => UUID.test(c)))].slice(0, 20) : [];
  const date = DATE.test(String(b.work_date || '')) ? b.work_date : H.dateKey(Date.now());
  if (!cats.length) return res.status(400).json({ error: 'bad_category', detail: 'Choose at least one category.' });
  if (!String(b.accomplishments || '').trim() || !String(b.outstanding || '').trim()) return res.status(400).json({ error: 'summary_incomplete', detail: 'Fill in what you accomplished and what is outstanding (write "Nothing" if so).' });
  try {
    const { data, error } = await ctx.db.rpc('ta_submit_activity', { p_work_date: date, p_categories: cats, p_accomplishments: String(b.accomplishments).slice(0, 4000),
      p_outstanding: String(b.outstanding).slice(0, 4000), p_notes: b.notes ? String(b.notes).slice(0, 4000) : null, p_community_ids: cids });
    if (error) return sendDbError(res, 'activity', error);
    res.json({ ok: true, summary: data });
  } catch (e) { sendDbError(res, 'activity', e); }
});

// ---- owner -------------------------------------------------------------------------
async function ownerData(sb, { from, to, now }) {
  const settings = await RM.loadSettings(sb);
  const employees = await RM.loadEmployees(sb, { includeInactive: true });
  const active = employees.filter((e) => e.active);
  const tracked = active.filter((e) => e.tracks_time);
  const [ts, profiles] = await Promise.all([
    RM.timesheets(sb, { employees: tracked, from, to, now, settings }),
    RM.profilesFor(sb, employees.map((e) => e.user_id)),
  ]);
  return { settings, employees, active, tracked, profiles, ...ts };
}

router.get('/admin/overview', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  const sb = service(); const now = Date.now();
  try {
    const { from, to, today } = rangeFrom(req.query, now);
    const wkFrom = H.weekStart(today, (await RM.loadSettings(sb)).workweek_start_dow);
    const lo = from < wkFrom ? from : wkFrom;
    const d = await ownerData(sb, { from: lo, to: today > to ? today : to, now });
    const [pendingC, pendingO, staff] = await Promise.all([
      RM.loadCorrections(sb, { status: 'pending', limit: 200 }),
      RM.loadOvertime(sb, { status: 'pending', limit: 200 }),
      sb.from('user_profiles').select('id, full_name, email, role, is_active').eq('is_active', true).order('full_name').limit(200),
    ]);
    if (staff.error) throw staff.error;
    const name = (id) => (d.profiles[id] && (d.profiles[id].full_name || d.profiles[id].email)) || 'Employee';
    const people = d.employees.map((e) => {
      const s = d.sheets[e.user_id];
      const p = d.punches[e.user_id] || [];
      const week = s ? (s.weeks.find((w) => w.week_start === wkFrom) || null) : null;
      return { user_id: e.user_id, name: name(e.user_id), email: (d.profiles[e.user_id] || {}).email || '', flsa_status: e.flsa_status, tracks_time: e.tracks_time, active: e.active,
        clocked_in: !!(s && s.open_shift && !s.open_shift.stale), since: s && s.open_shift && !s.open_shift.stale ? s.open_shift.since : null,
        last_punch: p[p.length - 1] || null,
        today_minutes: s ? ((s.days.find((x) => x.date === today) || {}).paid_minutes || 0) + ((s.days.find((x) => x.date === today) || {}).live_minutes || 0) : 0,
        week_minutes: week ? week.so_far_minutes : 0, week_threshold: d.settings.weekly_threshold_minutes,
        range_minutes: s ? s.days.filter((x) => x.date >= from && x.date <= to).reduce((t, x) => t + x.paid_minutes, 0) : 0,
        flags: s ? s.flags.filter((f) => !f.date || (f.date >= from && f.date <= today)) : [] };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const enrolledIds = new Set(d.employees.map((e) => e.user_id));
    res.json({ from, to, today, week_start: wkFrom, settings: d.settings, people,
      not_enrolled: (staff.data || []).filter((u) => !enrolledIds.has(u.id) && u.id !== owner.user.id).map((u) => ({ user_id: u.id, name: u.full_name || u.email, email: u.email, role: u.role })),
      pending_corrections: pendingC.map((c) => ({ ...c, employee: name(c.user_id) })),
      pending_overtime: pendingO.map((r) => ({ ...r, employee: name(r.user_id) })),
      periods: recentPeriods(today, d.settings, 6), frequencies: FREQUENCIES, current_period: periodFor(today, d.settings) });
  } catch (e) { sendDbError(res, 'admin overview', e); }
});

router.get('/admin/timesheet/:userId', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  if (!UUID.test(req.params.userId)) return res.status(400).json({ error: 'bad_id' });
  const sb = service(); const now = Date.now();
  try {
    const { from, to } = rangeFrom(req.query, now);
    const emp = (await RM.loadEmployees(sb, { userId: req.params.userId, includeInactive: true }))[0];
    if (!emp) return res.status(404).json({ error: 'not_found' });
    const settings = await RM.loadSettings(sb);
    const [{ sheets, punches, summaries }, corrections, overtime, prof] = await Promise.all([
      RM.timesheets(sb, { employees: [emp], from, to, now, settings }),
      RM.loadCorrections(sb, { userIds: [emp.user_id], limit: 200 }),
      RM.loadOvertime(sb, { userIds: [emp.user_id], limit: 100 }),
      RM.profilesFor(sb, [emp.user_id]),
    ]);
    const deciders = await RM.profilesFor(sb, [...new Set([...corrections, ...overtime].map((c) => c.decided_by).filter(Boolean))]);
    const nm = (id) => (deciders[id] && (deciders[id].full_name || deciders[id].email)) || null;
    res.json({ from, to, settings, employee: { ...emp, name: (prof[emp.user_id] || {}).full_name || (prof[emp.user_id] || {}).email },
      timesheet: sheets[emp.user_id],
      punches: (punches[emp.user_id] || []).filter((p) => { const k = H.dateKey(Date.parse(p.effective_at)); return k >= from && k <= to; }),
      corrections: corrections.map((c) => ({ ...c, decided_by_name: nm(c.decided_by) })), overtime: overtime.map((r) => ({ ...r, decided_by_name: nm(r.decided_by) })),
      summaries: summaries.filter((s) => s.work_date >= from && s.work_date <= to).map((s) => ({ ...s, categories: s.categories.map((c) => RM.CATEGORY_LABEL[c] || c) })) });
  } catch (e) { sendDbError(res, 'admin timesheet', e); }
});

router.get('/admin/activity', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  try {
    const { from, to } = rangeFrom(req.query, Date.now(), 7);
    res.json({ from, to, rows: await RM.teamActivity(service(), { from, to }) });
  } catch (e) { sendDbError(res, 'admin activity', e); }
});

async function decide(req, res, fn, label) {
  const owner = await requireOwner(req, res); if (!owner) return;
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'bad_id' });
  const b = req.body || {};
  if (!['approved', 'rejected'].includes(b.decision)) return res.status(400).json({ error: 'decision_required', detail: 'Approve or reject?' });
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'reason_required', detail: 'A reason is required for the decision.' });
  try {
    const { data, error } = await service().rpc(fn, { p_id: req.params.id, p_decision: b.decision, p_reason: String(b.reason).slice(0, 1000), p_actor: owner.user.id, p_route: routeOf(req) });
    if (error) return sendDbError(res, label, error);
    res.json({ ok: true, result: data });
  } catch (e) { sendDbError(res, label, e); }
}
router.post('/admin/corrections/:id/decide', (req, res) => decide(req, res, 'ta_decide_correction', 'decide correction'));
router.post('/admin/overtime/:id/decide', (req, res) => decide(req, res, 'ta_decide_overtime', 'decide overtime'));

router.post('/admin/employees', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  const b = req.body || {};
  if (!UUID.test(String(b.user_id || ''))) return res.status(400).json({ error: 'bad_id' });
  const flsa = b.flsa_status === 'exempt' ? 'exempt' : 'nonexempt';
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'reason_required', detail: 'A reason is required.' });
  try {
    const { data, error } = await service().rpc('ta_set_employee', { p_user_id: b.user_id, p_flsa_status: flsa, p_tracks_time: flsa === 'nonexempt' ? true : b.tracks_time === true,
      p_active: b.active !== false, p_reason: String(b.reason).slice(0, 1000), p_actor: owner.user.id, p_route: routeOf(req) });
    if (error) return sendDbError(res, 'set employee', error);
    res.json({ ok: true, employee: data });
  } catch (e) { sendDbError(res, 'set employee', e); }
});

router.post('/admin/settings', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  const b = req.body || {};
  const dowN = Number(b.workweek_start_dow);
  const thr = Math.round(Number(b.weekly_threshold_hours) * 60);
  const freq = b.pay_frequency ? String(b.pay_frequency) : null;
  if (!Number.isInteger(dowN) || dowN < 0 || dowN > 6) return res.status(400).json({ error: 'bad_workweek' });
  if (!Number.isFinite(thr) || thr < 60 || thr > 6000) return res.status(400).json({ error: 'bad_threshold' });
  if (freq && !FREQUENCIES.includes(freq)) return res.status(400).json({ error: 'bad_frequency' });
  const anchor = b.pay_period_anchor && DATE.test(String(b.pay_period_anchor)) ? String(b.pay_period_anchor) : null;
  if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'reason_required', detail: 'A reason is required.' });
  try {
    const { data, error } = await service().rpc('ta_update_settings', { p_workweek_start_dow: dowN, p_weekly_threshold_minutes: thr, p_pay_frequency: freq,
      p_pay_period_anchor: anchor, p_reason: String(b.reason).slice(0, 1000), p_actor: owner.user.id, p_route: routeOf(req) });
    if (error) return sendDbError(res, 'settings', error);
    res.json({ ok: true, settings: data });
  } catch (e) { sendDbError(res, 'settings', e); }
});

router.get('/admin/payroll', async (req, res) => {
  const owner = await requireOwner(req, res); if (!owner) return;
  const sb = service(); const now = Date.now();
  if (!DATE.test(String(req.query.from || '')) || !DATE.test(String(req.query.to || ''))) return res.status(400).json({ error: 'range_required', detail: 'Choose the pay period.' });
  const { from, to } = rangeFrom(req.query, now);
  const format = ['csv', 'xlsx'].includes(req.query.format) ? req.query.format : 'json';
  const override = String(req.query.override_reason || '').trim().slice(0, 500);
  try {
    const d = await ownerData(sb, { from, to, now });
    const pending = await RM.loadCorrections(sb, { status: 'pending', limit: 500 });
    const emps = d.tracked.map((e) => ({ ...e, full_name: (d.profiles[e.user_id] || {}).full_name, email: (d.profiles[e.user_id] || {}).email }));
    const p = buildPayroll({ from, to, employees: emps, sheets: d.sheets, punches: d.punches, pending });
    if (format === 'json') return res.json(p);
    // A file with open exceptions is refused unless the owner overrides on purpose.
    if (p.exceptions.length && !override) return res.status(409).json({ error: 'exceptions_open', detail: `${p.exceptions.length} open exception(s) make these hours incomplete. Resolve them or export with a reason.`, exceptions: p.exceptions });
    await recordAuditEvent(sb, { actor_user_id: owner.user.id, actor_name: owner.full_name, entity_type: 'payroll_export', entity_id: `${from}..${to}`, action: 'payroll.exported',
      new_value: { format, employees: p.employee_count, totals: p.totals, exceptions: p.exceptions.length }, reason: override || 'Payroll export with no open exceptions', route: routeOf(req), record_ownership: 'workpaper' });
    const fname = `bedrock-payroll-hours_${from}_to_${to}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    if (format === 'csv') { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); return res.send(toCsv(p)); }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(toXlsx(p));
  } catch (e) { sendDbError(res, 'payroll', e); }
});

module.exports = router;
module.exports._internal = { centralToIso, rangeFrom, sendDbError, FRIENDLY, IN_REASONS, OUT_REASONS };
