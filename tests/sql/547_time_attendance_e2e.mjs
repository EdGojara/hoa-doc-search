// tests/sql/547_time_attendance_e2e.mjs — migration 547 (Time & Attendance)
// applied END TO END through the single-migration tool with its REAL checks
// file, then exercised as the roles Supabase uses (authenticated with a JWT
// subject, service_role, anon). Proves:
//   - the checks file declares exactly what 547 creates; user_profiles is untouched;
//   - the database sets punch times; a client cannot write a punch directly;
//   - nobody (not even the table owner) can change or delete a punch;
//   - an employee sees only their own punches, corrections, summaries and tags;
//   - corrections keep the original, are decided once, by an active admin who is
//     not the employee, with a reason, and write audit_events atomically;
//   - activity summaries are versioned, never overwritten.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { WORLD, ED, ANA, BEN, OUTSIDER, CG } from './_ta_world.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  547 time & attendance e2e (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '547_time_attendance.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm547-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));

const db = new PGlite();
await db.exec(WORLD);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const profilesBefore = (await db.query(`SELECT string_agg(row_to_json(u)::text, ',' ORDER BY id) j FROM user_profiles u`)).rows[0].j;
const ctx = { client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, preflight: plan.preflight }).slice(0, 800));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 547 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 4000));
if (r.status !== 'applied') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
check('user_profiles is byte-identical after the migration', (await db.query(`SELECT string_agg(row_to_json(u)::text, ',' ORDER BY id) j FROM user_profiles u`)).rows[0].j === profilesBefore);

// ---- role helpers ----------------------------------------------------------
// as(who, sql): run as the Supabase role, with the JWT subject PostgREST would set.
async function as(who, sql) {
  const role = who === 'service' ? 'service_role' : who === 'anon' ? 'anon' : who === 'owner' ? null : 'authenticated';
  const sub = ['service', 'anon', 'owner'].includes(who) ? '' : who;
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${sub}', false);` + (role ? ` SET ROLE ${role};` : ''));
  try { return { rows: (await db.query(sql)).rows, err: null }; }
  catch (e) { return { rows: [], err: e.message }; }
  finally { await db.exec('RESET ROLE;'); }
}
const one = async (who, sql) => (await as(who, sql)).rows[0];

// ---- enrollment ------------------------------------------------------------
const enroll = (uid, actor) => as('service', `SELECT * FROM ta_set_employee('${uid}', 'nonexempt', true, true, 'New hire', '${actor}', 'test')`);
check('Ed (admin) enrolls Ana and Ben', !(await enroll(ANA, ED)).err && !(await enroll(BEN, ED)).err);
check('a staff member cannot enroll anyone (actor must be an active admin)', /only an active administrator/.test((await enroll(OUTSIDER, ANA)).err || ''));
check('an administrator cannot enroll themself', /cannot enroll themself/.test((await enroll(ED, ED)).err || ''));
check('enrollment wrote an audit event naming Ed', (await one('owner', `SELECT count(*)::int n FROM audit_events WHERE action = 'ta_employee.enrolled' AND actor_user_id = '${ED}' AND record_ownership = 'workpaper'`)).n === 2);
check('authenticated cannot call the owner functions', /permission denied/.test((await as(ANA, `SELECT * FROM ta_set_employee('${OUTSIDER}', 'nonexempt', true, true, 'x', '${ED}', 'x')`)).err || ''));

// ---- punches -----------------------------------------------------------------
const anaIn = await as(ANA, `SELECT * FROM ta_punch('in', 'start_shift')`);
check('Ana clocks in through ta_punch', !anaIn.err && anaIn.rows[0] && anaIn.rows[0].user_id === ANA, anaIn.err || '');
const anaPunch = anaIn.rows[0] || {};
check('the database set the time (within a few seconds of now)', Math.abs(Date.parse(anaPunch.punched_at) - Date.now()) < 10000);
check('a second clock-in the same day is refused', /already clocked in/.test((await as(ANA, `SELECT * FROM ta_punch('in', 'start_shift')`)).err || ''));
check("'other' needs a note", /ta_punches_other_needs_note/.test((await as(ANA, `SELECT * FROM ta_punch('out', 'other')`)).err || ''));
check('a clock-in reason cannot be used to clock out', /ta_punches_reason_check/.test((await as(ANA, `SELECT * FROM ta_punch('out', 'start_shift')`)).err || ''));
check('Ben cannot clock out before clocking in', /not clocked in/.test((await as(BEN, `SELECT * FROM ta_punch('out', 'end_of_shift')`)).err || ''));
check('Ben clocks in', !(await as(BEN, `SELECT * FROM ta_punch('in', 'start_shift')`)).err);
check('Ana clocks out for lunch', !(await as(ANA, `SELECT * FROM ta_punch('out', 'meal_break')`)).err);
check('an employee cannot insert a punch directly (and so cannot pick its time)',
  /permission denied/.test((await as(ANA, `INSERT INTO ta_punches (user_id, direction, reason, punched_at) VALUES ('${ANA}', 'in', 'start_shift', now() - interval '3 hours')`)).err || ''));
check('service_role cannot insert a punch directly either', /permission denied/.test((await as('service', `INSERT INTO ta_punches (user_id, direction, reason) VALUES ('${ANA}', 'in', 'start_shift')`)).err || ''));
check('a client-sent time is overwritten even for the table owner',
  Math.abs(Date.parse((await one('owner', `INSERT INTO ta_punches (user_id, direction, reason, punched_at) VALUES ('${ANA}', 'in', 'back_from_meal', '2020-01-01') RETURNING punched_at`)).punched_at) - Date.now()) < 10000);
check('an employee cannot update or delete a punch', /permission denied/.test((await as(ANA, `UPDATE ta_punches SET reason = 'other' WHERE id = '${anaPunch.id}'`)).err || '')
  && /permission denied/.test((await as(ANA, `DELETE FROM ta_punches WHERE id = '${anaPunch.id}'`)).err || ''));
check('not even the table owner can update, delete or truncate punches', /append-only/.test((await as('owner', `UPDATE ta_punches SET punched_at = now() WHERE id = '${anaPunch.id}'`)).err || '')
  && /append-only/.test((await as('owner', `DELETE FROM ta_punches`)).err || '') && /append-only/.test((await as('owner', `TRUNCATE ta_punches CASCADE`)).err || ''));
check('a signed-in staffer who is not enrolled cannot punch', /not enrolled/.test((await as(OUTSIDER, `SELECT * FROM ta_punch('in', 'start_shift')`)).err || ''));
check('no sign-in at all cannot punch', /permission denied|sign in required/.test((await as('anon', `SELECT * FROM ta_punch('in', 'start_shift')`)).err || ''));

// ---- privacy -----------------------------------------------------------------
const seen = async (who, t) => (await as(who, `SELECT DISTINCT user_id FROM ${t}`)).rows.map((x) => x.user_id).sort();
check('Ana sees only her own punches', JSON.stringify(await seen(ANA, 'ta_punches')) === JSON.stringify([ANA]));
check('Ben sees only his own punches', JSON.stringify(await seen(BEN, 'ta_punches')) === JSON.stringify([BEN]));
check('Ana sees only her own effective punches (view honours RLS)', JSON.stringify(await seen(ANA, 'v_ta_effective_punches')) === JSON.stringify([ANA]));
check('Ana sees only her own enrollment row', JSON.stringify(await seen(ANA, 'ta_employees')) === JSON.stringify([ANA]));
check('a non-enrolled staffer sees no punches at all', (await seen(OUTSIDER, 'ta_punches')).length === 0);
check('anon cannot read punches', /permission denied/.test((await as('anon', `SELECT * FROM ta_punches`)).err || ''));
check('service_role (owner API) sees everyone', (await seen('service', 'ta_punches')).length === 2);

// ---- corrections ---------------------------------------------------------------
const req = (who, sql) => as(who, `SELECT * FROM ta_request_correction(${sql})`);
const c1 = await req(ANA, `'change_time', '${anaPunch.id}', NULL, now() - interval '30 minutes', NULL, false, 'Forgot to clock in when I arrived'`);
check('Ana requests a time change on her punch', !c1.err && c1.rows[0] && c1.rows[0].status === 'pending', c1.err || '');
const corr = c1.rows[0] || {};
check('the request snapshots the original time and direction', corr.original_direction === 'in' && Date.parse(corr.original_at) === Date.parse(anaPunch.punched_at));
check('the request wrote an audit event naming Ana', (await one('owner', `SELECT count(*)::int n FROM audit_events WHERE entity_id = '${corr.id}' AND action = 'time_correction.requested' AND actor_user_id = '${ANA}'`)).n === 1);
check('a second pending request on the same punch is refused', /uq_ta_corrections_one_pending_per_punch/.test((await req(ANA, `'void_punch', '${anaPunch.id}', NULL, NULL, NULL, false, 'again'`)).err || ''));
const benPunch = (await one('service', `SELECT id FROM ta_punches WHERE user_id = '${BEN}' LIMIT 1`)).id;
check("Ana cannot request a correction on Ben's punch", /not this employee/.test((await req(ANA, `'void_punch', '${benPunch}', NULL, NULL, NULL, false, 'x'`)).err || ''));
check('a correction cannot be in the future', /future/.test((await req(ANA, `'add_punch', NULL, 'out', now() + interval '1 hour', 'end_of_shift', false, 'leaving later'`)).err || ''));
check('a correction needs a reason', /reason_not_blank/.test((await req(ANA, `'add_punch', NULL, 'out', now() - interval '1 hour', 'rest_break', false, '   '`)).err || ''));
check('Ben cannot see Ana\'s correction', (await as(BEN, `SELECT * FROM ta_corrections`)).rows.length === 0);
check('Ana cannot decide her own request (no grant)', /permission denied/.test((await as(ANA, `SELECT * FROM ta_decide_correction('${corr.id}', 'approved', 'ok', '${ED}')`)).err || ''));
check('Ana cannot change her request directly', /permission denied/.test((await as(ANA, `UPDATE ta_corrections SET status = 'approved' WHERE id = '${corr.id}'`)).err || ''));
check('a staff actor cannot decide', /only an active administrator/.test((await as('service', `SELECT * FROM ta_decide_correction('${corr.id}', 'approved', 'ok', '${BEN}')`)).err || ''));
check('a decision needs a reason', /decision_coherent/.test((await as('service', `SELECT * FROM ta_decide_correction('${corr.id}', 'approved', '  ', '${ED}')`)).err || ''));
const d1 = await as('service', `SELECT * FROM ta_decide_correction('${corr.id}', 'approved', 'Confirmed with Ana; she arrived at 8', '${ED}', 'POST /api/time/admin/corrections/:id/decide')`);
check('Ed approves the correction', !d1.err && d1.rows[0].status === 'approved' && d1.rows[0].decided_by === ED, d1.err || '');
check('a decided request is final', /final/.test((await as('service', `SELECT * FROM ta_decide_correction('${corr.id}', 'rejected', 'changed my mind', '${ED}')`)).err || ''));
check('the original punch is unchanged', Date.parse((await one('service', `SELECT punched_at FROM ta_punches WHERE id = '${anaPunch.id}'`)).punched_at) === Date.parse(anaPunch.punched_at));
const eff = await one(ANA, `SELECT * FROM v_ta_effective_punches WHERE punch_id = '${anaPunch.id}'`);
check('the effective time is the corrected one, with the original beside it', eff && eff.is_corrected && Date.parse(eff.effective_at) === Date.parse(corr.proposed_at) && Date.parse(eff.original_at) === Date.parse(anaPunch.punched_at));
const ae = await one('owner', `SELECT * FROM audit_events WHERE entity_id = '${corr.id}' AND action = 'time_correction.approved'`);
check('the approval audit event holds the employee, the original, the new value, the approver and the reason',
  ae && ae.actor_user_id === ED && ae.previous_value.employee_id === ANA && ae.previous_value.original_at && ae.new_value.proposed_at && /arrived at 8/.test(ae.reason));
const add = await req(ANA, `'add_punch', NULL, 'out', now() - interval '5 minutes', 'rest_break', false, 'Stepped out, forgot to punch'`);
await as('service', `SELECT * FROM ta_decide_correction('${add.rows[0].id}', 'approved', 'ok', '${ED}')`);
check('an approved added punch appears in the effective view', (await one(ANA, `SELECT count(*)::int n FROM v_ta_effective_punches WHERE origin = 'correction'`)).n === 1);
const v = await req(ANA, `'void_punch', '${anaPunch.id}', NULL, NULL, NULL, false, 'Duplicate'`);
await as('service', `SELECT * FROM ta_decide_correction('${v.rows[0].id}', 'rejected', 'Not a duplicate', '${ED}')`);
check('a rejected void leaves the punch in effect', (await one(ANA, `SELECT count(*)::int n FROM v_ta_effective_punches WHERE punch_id = '${anaPunch.id}'`)).n === 1);
const w = await req(ANA, `'void_punch', '${anaPunch.id}', NULL, NULL, NULL, false, 'oops'`);
check('Ana can withdraw her own pending request', (await as(ANA, `SELECT * FROM ta_withdraw_correction('${w.rows[0].id}')`)).rows[0]?.status === 'withdrawn');
check('Ben cannot withdraw Ana\'s request', /no pending request/.test((await as(BEN, `SELECT * FROM ta_withdraw_correction('${corr.id}')`)).err || ''));
check('corrections cannot be deleted', /append-only/.test((await as('owner', `DELETE FROM ta_corrections WHERE id = '${corr.id}'`)).err || ''));

// A second admin enrolled by Ed cannot approve their own correction.
await db.exec(`INSERT INTO user_profiles (id, email, full_name, role) VALUES ('00000000-0000-4000-8000-0000000000d4', 'dee@example.test', 'Dee Admin', 'admin')`);
await enroll('00000000-0000-4000-8000-0000000000d4', ED);
await as('00000000-0000-4000-8000-0000000000d4', `SELECT * FROM ta_punch('in', 'start_shift')`);
const dc = await req('00000000-0000-4000-8000-0000000000d4', `'add_punch', NULL, 'out', now() - interval '1 minute', 'rest_break', false, 'x'`);
check('no one approves their own correction, even an admin', /no_self_approval/.test((await as('service', `SELECT * FROM ta_decide_correction('${dc.rows[0].id}', 'approved', 'mine', '00000000-0000-4000-8000-0000000000d4')`)).err || ''));

// ---- overtime --------------------------------------------------------------------
const ot = await as(BEN, `SELECT * FROM ta_request_overtime('2026-10-25', 120, 'Month-end close')`);
check('Ben requests overtime', !ot.err && ot.rows[0].status === 'pending', ot.err || '');
check('Ed approves it with a reason', (await as('service', `SELECT * FROM ta_decide_overtime('${ot.rows[0].id}', 'approved', 'Close week', '${ED}')`)).rows[0]?.status === 'approved');
check('Ana cannot see Ben\'s overtime requests', (await as(ANA, `SELECT * FROM ta_overtime_requests`)).rows.length === 0);

// ---- activity summaries --------------------------------------------------------------
const s1 = await as(ANA, `SELECT * FROM ta_submit_activity((now() AT TIME ZONE 'America/Chicago')::date, ARRAY['accounting_ap','board_support'], 'Coded 14 bills', 'Two W-9s outstanding', NULL, ARRAY['${CG}']::uuid[])`);
check('Ana submits a summary tagged to Canyon Gate', !s1.err && s1.rows[0].version === 1, s1.err || '');
const s2 = await as(ANA, `SELECT * FROM ta_submit_activity((now() AT TIME ZONE 'America/Chicago')::date, ARRAY['accounting_ap'], 'Coded 15 bills', 'One W-9 outstanding')`);
check('an edit is a new version; the first is kept', s2.rows[0]?.version === 2 && (await one('service', `SELECT count(*)::int n FROM ta_activity_summaries WHERE user_id = '${ANA}'`)).n === 2);
check('the community tag is stored against the version it was given on', (await one(ANA, `SELECT count(*)::int n FROM ta_activity_communities WHERE community_id = '${CG}'`)).n === 1);
check('Ben cannot see Ana\'s summaries or tags', (await as(BEN, `SELECT * FROM ta_activity_summaries`)).rows.length === 0 && (await as(BEN, `SELECT * FROM ta_activity_communities`)).rows.length === 0);
check('an unknown category is refused', /categories_check/.test((await as(ANA, `SELECT * FROM ta_submit_activity((now() AT TIME ZONE 'America/Chicago')::date, ARRAY['sleeping'], 'x', 'y')`)).err || ''));
check('a summary for a future day is refused', /future day/.test((await as(ANA, `SELECT * FROM ta_submit_activity((now() AT TIME ZONE 'America/Chicago')::date + 2, ARRAY['admin'], 'x', 'y')`)).err || ''));
check('summaries cannot be edited in place', /append-only/.test((await as('owner', `UPDATE ta_activity_summaries SET accomplishments = 'z'`)).err || ''));

// ---- settings ------------------------------------------------------------------------
check('a semimonthly payroll schedule can be set by Ed with a reason',
  (await as('service', `SELECT * FROM ta_update_settings(0::smallint, 2400, 'semimonthly', NULL, 'QuickBooks schedule', '${ED}')`)).rows[0]?.pay_frequency === 'semimonthly');
check('biweekly needs an anchor date', /anchor_needed/.test((await as('service', `SELECT * FROM ta_update_settings(0::smallint, 2400, 'biweekly', NULL, 'x', '${ED}')`)).err || ''));
check('employees can read settings but not change them', (await as(ANA, `SELECT * FROM ta_settings`)).rows.length === 1
  && /permission denied/.test((await as(ANA, `UPDATE ta_settings SET weekly_threshold_minutes = 6000`)).err || ''));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
