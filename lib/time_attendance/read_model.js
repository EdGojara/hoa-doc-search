// ============================================================================
// lib/time_attendance/read_model.js  (Ed 2026-10-26, migration 547)
// ----------------------------------------------------------------------------
// READ-ONLY loaders and summaries over the ta_ tables. No inserts, updates,
// deletes, upserts or RPCs: tests/test_time_attendance_api.js fails the build if
// one appears. Every writer lives in api/time_attendance.js and goes through the
// database functions of migration 547.
//
// The same loaders serve two clients:
//   - the employee's own client (their JWT; RLS returns only their rows)
//   - the service client behind requireOwner (everyone), the Today feed and
//     Amanda (owner-only surfaces).
// Amanda reads activity and flags from here; she has no path to change a time
// record.
// ============================================================================
const { fetchAllQuery } = require('../db/fetch_all');
const H = require('./hours');

const CATEGORIES = [
  ['accounting_ap', 'Accounting / AP'], ['acc_arc', 'ACC / ARC'], ['admin', 'Admin'], ['amenities', 'Amenities'],
  ['board_support', 'Board support'], ['collections', 'Collections'], ['compliance_drv', 'Compliance / DRV'],
  ['homeowner_communication', 'Homeowner communication'], ['training', 'Training'], ['vendors_maintenance', 'Vendors / maintenance'], ['other', 'Other'],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);
const DEFAULT_SETTINGS = { workweek_start_dow: 0, weekly_threshold_minutes: 2400, pay_frequency: null, pay_period_anchor: null };
const missingTable = (e) => e && /does not exist|schema cache|not find/i.test(e.message || '');

function must({ data, error }, what) {
  if (error) { const e = new Error(`${what}: ${error.message}`); e.code = error.code; throw e; }
  return data;
}

async function loadSettings(sb) {
  const { data, error } = await sb.from('ta_settings').select('workweek_start_dow, weekly_threshold_minutes, pay_frequency, pay_period_anchor, updated_at').eq('id', 1).maybeSingle();
  if (error) throw new Error(`settings: ${error.message}`);
  return { ...DEFAULT_SETTINGS, ...(data || {}) };
}

async function loadEmployees(sb, { userId = null, includeInactive = false } = {}) {
  let q = sb.from('ta_employees').select('user_id, flsa_status, tracks_time, active, enrolled_at').order('user_id').limit(500);
  if (userId) q = q.eq('user_id', userId);
  if (!includeInactive) q = q.eq('active', true);
  return must(await q, 'employees') || [];
}

async function loadEffectivePunches(sb, { userIds = null, fromIso, toIso }) {
  return fetchAllQuery(() => {
    let q = sb.from('v_ta_effective_punches').select('punch_id, correction_id, user_id, direction, effective_at, original_at, reason, note, worked_during_break, is_corrected, origin')
      .gte('effective_at', fromIso).lt('effective_at', toIso);
    if (userIds) q = q.in('user_id', userIds);
    return q;
  }, { orderBy: 'effective_at' });
}

async function loadCorrections(sb, { userIds = null, status = null, sinceIso = null, limit = 200 } = {}) {
  let q = sb.from('ta_corrections').select('id, user_id, kind, punch_id, original_at, original_direction, proposed_direction, proposed_at, proposed_reason, proposed_worked_during_break, employee_reason, requested_at, status, decided_by, decided_at, decision_reason')
    .order('requested_at', { ascending: false }).limit(limit);
  if (userIds) q = q.in('user_id', userIds);
  if (status) q = q.eq('status', status);
  if (sinceIso) q = q.gte('requested_at', sinceIso);
  return must(await q, 'corrections') || [];
}

async function loadOvertime(sb, { userIds = null, status = null, weekFrom = null, weekTo = null, limit = 200 } = {}) {
  let q = sb.from('ta_overtime_requests').select('id, user_id, week_start, extra_minutes, employee_reason, requested_at, status, decided_by, decided_at, decision_reason')
    .order('requested_at', { ascending: false }).limit(limit);
  if (userIds) q = q.in('user_id', userIds);
  if (status) q = q.eq('status', status);
  if (weekFrom) q = q.gte('week_start', weekFrom);
  if (weekTo) q = q.lte('week_start', weekTo);
  return must(await q, 'overtime') || [];
}

// Latest version of each (employee, day) summary in a range, with community tags.
async function loadSummaries(sb, { userIds = null, from, to }) {
  const rows = await fetchAllQuery(() => {
    let q = sb.from('ta_activity_summaries').select('id, user_id, work_date, version, categories, accomplishments, outstanding, notes, submitted_at, ta_activity_communities(community_id)')
      .gte('work_date', from).lte('work_date', to);
    if (userIds) q = q.in('user_id', userIds);
    return q;
  }, { orderBy: 'id' });
  const latest = {};
  for (const r of rows) {
    const k = `${r.user_id}|${r.work_date}`;
    if (!latest[k] || r.version > latest[k].version) latest[k] = r;
  }
  return Object.values(latest).map((r) => ({ ...r, community_ids: (r.ta_activity_communities || []).map((c) => c.community_id), ta_activity_communities: undefined }))
    .sort((a, b) => a.work_date.localeCompare(b.work_date) || String(a.user_id).localeCompare(String(b.user_id)));
}

const approvedByWeek = (rows) => {
  const out = {};
  for (const r of rows) if (r.status === 'approved') out[r.week_start] = (out[r.week_start] || 0) + Number(r.extra_minutes || 0);
  return out;
};

// Timesheets for a set of employees over [from, to]. One query per table, not per person.
async function timesheets(sb, { employees, from, to, now = Date.now(), settings = null }) {
  const S = settings || await loadSettings(sb);
  const ids = employees.map((e) => e.user_id);
  if (!ids.length) return { settings: S, sheets: {}, punches: {}, summaries: [] };
  const win = H.fetchWindow(from, to, S);
  const [punches, ot, summaries] = await Promise.all([
    loadEffectivePunches(sb, { userIds: ids, fromIso: win.fromIso, toIso: win.toIso }),
    loadOvertime(sb, { userIds: ids, weekFrom: win.from, weekTo: win.to, limit: 1000 }),
    loadSummaries(sb, { userIds: ids, from: win.from, to: win.to }),
  ]);
  const sheets = {}; const byUser = {};
  for (const e of employees) {
    const mine = punches.filter((p) => p.user_id === e.user_id);
    byUser[e.user_id] = mine;
    sheets[e.user_id] = H.computeTimesheet({
      punches: mine, settings: S, now, from, to, flsaStatus: e.flsa_status,
      approvedOvertime: approvedByWeek(ot.filter((r) => r.user_id === e.user_id)),
      summaryDates: summaries.filter((s) => s.user_id === e.user_id).map((s) => s.work_date),
    });
  }
  return { settings: S, sheets, punches: byUser, summaries };
}

async function profilesFor(sb, ids) {
  if (!ids.length) return {};
  const rows = must(await sb.from('user_profiles').select('id, full_name, email, role, is_active').in('id', ids).limit(500), 'profiles') || [];
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

// ---- owner surfaces (service client only) ----------------------------------------

// What the owner should hear about, for the Today feed. Never throws for a
// missing table (before migration 547 is applied there is simply nothing).
async function ownerAlerts(sb, { now = Date.now() } = {}) {
  const out = { pending_corrections: [], pending_overtime: [], missing_punches: [], unapproved_overtime: [], approaching: [], error: null };
  try {
    // No one enrolled = no punches, requests or corrections can exist (FKs): nothing to read.
    const enrolled = await loadEmployees(sb);
    if (!enrolled.length) return out;
    const employees = enrolled.filter((e) => e.tracks_time);
    const today = H.dateKey(now);
    const S = await loadSettings(sb);
    const from = H.addDays(today, -13);
    const [{ sheets }, pc, po, prof] = await Promise.all([
      timesheets(sb, { employees, from, to: today, now, settings: S }),
      loadCorrections(sb, { status: 'pending', limit: 100 }),
      loadOvertime(sb, { status: 'pending', limit: 100 }),
      profilesFor(sb, employees.map((e) => e.user_id)),
    ]);
    const name = (id) => (prof[id] && (prof[id].full_name || prof[id].email)) || 'An employee';
    out.pending_corrections = pc.map((c) => ({ ...c, employee: name(c.user_id) }));
    out.pending_overtime = po.map((r) => ({ ...r, employee: name(r.user_id) }));
    const thisWeek = H.weekStart(today, S.workweek_start_dow);
    for (const e of employees) {
      const s = sheets[e.user_id];
      for (const f of s.flags) {
        if (f.code === 'missing_out' || f.code === 'missing_in') out.missing_punches.push({ user_id: e.user_id, employee: name(e.user_id), date: f.date, code: f.code });
        if (f.code === 'over_threshold_unapproved') out.unapproved_overtime.push({ user_id: e.user_id, employee: name(e.user_id), week_start: f.week_start, message: f.message });
        if (f.code === 'approaching_threshold' && f.week_start === thisWeek) out.approaching.push({ user_id: e.user_id, employee: name(e.user_id), week_start: f.week_start, message: f.message });
      }
    }
  } catch (e) {
    if (!missingTable(e)) out.error = e.message;
  }
  return out;
}

// Activity and outstanding work for Amanda / the owner. Hours are deliberately
// not included: this is what people worked on, not what they are paid for.
async function teamActivity(sb, { from, to }) {
  const employees = await loadEmployees(sb);
  const ids = employees.map((e) => e.user_id);
  const [summaries, prof] = await Promise.all([loadSummaries(sb, { userIds: ids, from, to }), profilesFor(sb, ids)]);
  const cids = [...new Set(summaries.flatMap((s) => s.community_ids))];
  const comms = cids.length ? Object.fromEntries((must(await sb.from('communities').select('id, name').in('id', cids).limit(500), 'communities') || []).map((c) => [c.id, c.name])) : {};
  return summaries.map((s) => ({
    employee: (prof[s.user_id] && (prof[s.user_id].full_name || prof[s.user_id].email)) || 'Employee',
    user_id: s.user_id, date: s.work_date, version: s.version,
    categories: s.categories.map((c) => CATEGORY_LABEL[c] || c), communities: s.community_ids.map((c) => comms[c] || 'Unknown community'),
    accomplishments: s.accomplishments, outstanding: s.outstanding, notes: s.notes || null,
  }));
}

// Plain-text brief for Amanda's prompt (owner, in-app only).
async function teamActivityBrief(sb, { now = Date.now(), days = 7 } = {}) {
  const to = H.dateKey(now);
  const from = H.addDays(to, -(days - 1));
  const rows = await teamActivity(sb, { from, to });
  if (!rows.length) return `No activity summaries were submitted from ${from} to ${to}.`;
  return `Activity summaries ${from} to ${to} (latest version of each day):\n` + rows.map((r) =>
    `- ${r.employee}, ${r.date}: [${r.categories.join(', ')}]${r.communities.length ? ` {${r.communities.join(', ')}}` : ''} Done: ${r.accomplishments.slice(0, 500)} | Outstanding: ${r.outstanding.slice(0, 500)}${r.notes ? ` | Notes: ${r.notes.slice(0, 200)}` : ''}`).join('\n');
}

module.exports = {
  CATEGORIES, CATEGORY_LABEL, DEFAULT_SETTINGS,
  loadSettings, loadEmployees, loadEffectivePunches, loadCorrections, loadOvertime, loadSummaries, profilesFor,
  timesheets, ownerAlerts, teamActivity, teamActivityBrief, approvedByWeek, missingTable,
};
