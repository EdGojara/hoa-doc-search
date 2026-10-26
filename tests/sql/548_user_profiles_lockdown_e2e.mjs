// tests/sql/548_user_profiles_lockdown_e2e.mjs — security fix for user_profiles.
//
// Builds the production shape with Supabase's roles: a NON-superuser owner of the
// public schema objects (as Supabase's `postgres` is), supabase_auth_admin owning
// auth.users, authenticated / anon, and service_role with BYPASSRLS. auth.uid()
// is Supabase's own definition (reads the request JWT claims PostgREST sets).
// Migration 039 is applied exactly as committed, and every profile is created the
// real way (a sign-up row in auth.users firing the 039 trigger).
//
// Proves, in order:
//   BEFORE 548  the hole is real: a signed-in staffer can make themself admin with
//               the owner's email, demote or delete the owner, insert an admin,
//               and read every profile (anon is refused, as on production);
//   APPLY       548 goes through lib/migrations/apply_one.js with its real checks
//               file (preflight, catalog diff, protected rows, verify);
//   AFTER 548   every one of those writes is refused; a staffer reads only their
//               own row; the server (service_role) still reads and writes; sign-up
//               and sign-in triggers still work; the owner is still the only
//               admin; no existing row changed.
// Engines: PGlite (Postgres 17 in-process, the default) or a NATIVE PostgreSQL
// server when PG_TEST_URL is a superuser connection to a throwaway server (each
// world is a fresh database there; cluster-wide roles are created only if
// missing). Skips when neither is available.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const NATIVE = process.env.PG_TEST_URL || null;
let PGlite = null;
if (!NATIVE) {
  try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
  catch (_) { console.log('SKIP  548 user_profiles lockdown e2e (@electric-sql/pglite not installed, PG_TEST_URL not set)'); process.exit(0); }
}
// One interface for both engines: exec(multi-statement sql) and query(sql) -> { rows, affectedRows }.
let worldSeq = 0;
async function newDb() {
  if (!NATIVE) return new PGlite();
  const { Client } = require('pg');
  const admin = new Client({ connectionString: NATIVE }); await admin.connect();
  const name = `m548_${process.pid}_${++worldSeq}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const u = new URL(NATIVE); u.pathname = '/' + name;
  const c = new Client({ connectionString: u.toString() }); await c.connect();
  const version = (await c.query('select version() v')).rows[0].v;
  return { native: true, version, name,
    exec: async (sql) => { const r = await c.query(sql); return (Array.isArray(r) ? r : [r]).map((x) => ({ rows: x.rows || [], affectedRows: x.rowCount })); },
    query: async (sql, params) => { const r = await c.query(sql, params); return { rows: r.rows, affectedRows: r.rowCount }; },
    close: () => c.end() };
}
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '548_user_profiles_lockdown.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm548-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));

const ED = '00000000-0000-4000-8000-0000000000ed';
const ANA = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b2';
const CY = '00000000-0000-4000-8000-0000000000c3';
const OWNER = 'egojara@bedrocktx.com';

async function buildWorld({ preApplied = false } = {}) {
  const db = await newDb();
  await db.exec(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
      -- stands in for Supabase's non-superuser "postgres" (owner of public objects)
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN CREATE ROLE app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
    END $r$;
    GRANT USAGE, CREATE ON SCHEMA public TO app_owner;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, supabase_auth_admin;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    SET ROLE supabase_auth_admin;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb NOT NULL DEFAULT '{}', last_sign_in_at timestamptz);
    -- Supabase's auth.uid(): the sub claim of the request JWT.
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, app_owner;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role, app_owner;
    GRANT SELECT, REFERENCES, TRIGGER ON auth.users TO app_owner;
    RESET ROLE;
    SET ROLE app_owner;
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('546_inspection_closeout_stages.sql', 'recorded');
    RESET ROLE;`);
  // Migration 039 exactly as committed, run by the owner role.
  await db.exec('SET ROLE app_owner;');
  await db.exec(lf(`${REPO}/migrations/039_user_profiles.sql`));
  await db.exec(lf(`${REPO}/migrations/131_user_home_tiles.sql`));
  await db.exec('RESET ROLE;');
  // Profiles are created the real way: GoTrue inserts the sign-up into auth.users.
  await db.exec(`SET ROLE supabase_auth_admin;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ED}', '${OWNER}', '{"full_name":"Ed Owner"}');
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ANA}', 'ana@bedrocktx.com', '{"full_name":"Ana Staff"}');
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${BEN}', 'ben@bedrocktx.com', '{"full_name":"Ben Staff"}');
    RESET ROLE;`);
  if (preApplied) await db.exec(`SET ROLE app_owner; ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY; RESET ROLE;`);
  await db.exec('SET ROLE app_owner;');   // the migration tool runs as the owner, as on Supabase
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

// Run one statement as a Supabase role (and JWT subject), always rolled back so
// the attempt never changes data. Returns { rows, affected, err }.
async function as(db, role, sub, sql) {
  await db.exec('BEGIN;');
  try {
    // What PostgREST (v12, as Supabase runs it) sets per request: the role, and the JWT claims as JSON.
    const claims = JSON.stringify(sub ? { sub, role, aud: 'authenticated' } : { role });
    await db.exec(`SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '${claims}', true);`);
    const r = await db.query(sql);
    return { rows: r.rows, affected: r.affectedRows ?? r.rows.length, err: null };
  } catch (e) { return { rows: [], affected: 0, err: e.message }; }
  finally { await db.exec('ROLLBACK;'); }
}
const staff = (db, sql) => as(db, 'authenticated', ANA, sql);
const denied = (r) => /permission denied/.test(r.err || '');

const { db, client } = await buildWorld();
console.log(db.native ? `ENGINE native server: ${db.version} (database ${db.name})` : 'ENGINE PGlite (Postgres 17, in-process)');
check('roles are representative: the table owner is not a superuser and cannot bypass RLS; only service_role bypasses RLS',
  JSON.stringify((await db.query(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('anon','app_owner','authenticated','service_role') ORDER BY rolname`)).rows)
  === JSON.stringify([{ rolname: 'anon', rolsuper: false, rolbypassrls: false }, { rolname: 'app_owner', rolsuper: false, rolbypassrls: false },
    { rolname: 'authenticated', rolsuper: false, rolbypassrls: false }, { rolname: 'service_role', rolsuper: false, rolbypassrls: true }]));
const snap = async () => (await db.query(`SELECT string_agg(row_to_json(u)::text, ',' ORDER BY id) j FROM user_profiles u`)).rows[0].j;
const roles = (await db.query(`SELECT email, role FROM user_profiles ORDER BY email`)).rows;
check('world: profiles created by the 039 sign-up trigger; the first (Ed) is admin, the rest staff',
  JSON.stringify(roles) === JSON.stringify([{ email: 'ana@bedrocktx.com', role: 'staff' }, { email: 'ben@bedrocktx.com', role: 'staff' }, { email: OWNER, role: 'admin' }]), JSON.stringify(roles));

// ---- BEFORE: the hole ---------------------------------------------------------------
console.log('-- before 548 (the vulnerability) --');
const b1 = await staff(db, `UPDATE user_profiles SET role = 'admin', email = '${OWNER}' WHERE id = '${ANA}'`);
check('HOLE: a staffer can make themself admin with the owner\'s email', !b1.err && b1.affected === 1, b1.err || '');
const b2 = await staff(db, `UPDATE user_profiles SET role = 'staff', is_active = false WHERE id = '${ED}'`);
check('HOLE: a staffer can demote and deactivate the owner', !b2.err && b2.affected === 1, b2.err || '');
const b3 = await staff(db, `DELETE FROM user_profiles WHERE id = '${ED}'`);
check('HOLE: a staffer can delete the owner\'s profile', !b3.err && b3.affected === 1, b3.err || '');
const b4 = await staff(db, `SELECT id FROM user_profiles`);
check('HOLE: a staffer can read every staff profile', b4.rows.length === 3);
check('anon (no sign-in) is already refused, as the live probe showed (42501)', denied(await as(db, 'anon', '', `SELECT id FROM user_profiles`)));
const before = await snap();

// ---- APPLY through the standard tool ---------------------------------------------------
console.log('-- apply 548 through apply_one --');
const ctx = { client, user: { id: 'owner-uuid', email: OWNER }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready; every preflight passes (they prove the hole is present and the owner is the only admin)', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, preflight: plan.preflight }).slice(0, 1200));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 548 applied and verified (objects, row changes, protected user_profiles, verify queries)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 3000));
await db.exec('RESET ROLE;');
check('no profile changed (byte-for-byte)', (await snap()) === before);

// ---- AFTER: closed ----------------------------------------------------------------------
console.log('-- after 548 --');
check('a staffer can no longer make themself admin', denied(await staff(db, `UPDATE user_profiles SET role = 'admin' WHERE id = '${ANA}'`)));
check('a staffer can no longer take the owner\'s email', denied(await staff(db, `UPDATE user_profiles SET email = '${OWNER}' WHERE id = '${ANA}'`)));
check('a staffer can no longer change their own activation or name', denied(await staff(db, `UPDATE user_profiles SET is_active = true, full_name = 'x' WHERE id = '${ANA}'`)));
check('a staffer can no longer demote or deactivate the owner', denied(await staff(db, `UPDATE user_profiles SET role = 'staff' WHERE id = '${ED}'`)));
check('a staffer can no longer delete any profile', denied(await staff(db, `DELETE FROM user_profiles WHERE id = '${ED}'`)));
check('a staffer can no longer insert an admin profile', denied(await staff(db, `INSERT INTO user_profiles (id, email, role) VALUES ('${CY}', 'x@example.test', 'admin')`)));
check('a staffer can no longer truncate the table', denied(await staff(db, `TRUNCATE user_profiles`)));
const own = await staff(db, `SELECT id, role FROM user_profiles`);
check('a staffer reads only their own row', own.rows.length === 1 && own.rows[0].id === ANA);
check('a signed-in user with no profile reads nothing', (await as(db, 'authenticated', CY, `SELECT id FROM user_profiles`)).rows.length === 0);
check('anon still has no access', denied(await as(db, 'anon', '', `SELECT id FROM user_profiles`)));
check('the server (service_role) still reads every profile', (await as(db, 'service_role', '', `SELECT id FROM user_profiles`)).rows.length === 3);
const sv = await as(db, 'service_role', '', `UPDATE user_profiles SET preferences = '{"home_tiles":["today"]}' WHERE id = '${ANA}'`);
check('the server still writes (e.g. PATCH /api/users/me/preferences)', !sv.err && sv.affected === 1, sv.err || '');
const sr = await as(db, 'service_role', '', `UPDATE user_profiles SET role = 'assistant' WHERE id = '${BEN}'`);
check('the server still changes roles (PATCH /api/users/:id, admin-gated in the app)', !sr.err && sr.affected === 1, sr.err || '');
await db.exec(`SET ROLE supabase_auth_admin; INSERT INTO auth.users (id, email) VALUES ('${CY}', 'cy@bedrocktx.com'); RESET ROLE;`);
check('a new sign-up still gets a staff profile from the 039 trigger', (await db.query(`SELECT role FROM user_profiles WHERE id = '${CY}'`)).rows[0]?.role === 'staff');
await db.exec(`SET ROLE supabase_auth_admin; UPDATE auth.users SET last_sign_in_at = now() WHERE id = '${ANA}'; RESET ROLE;`);
check('sign-in still updates last_sign_in_at through the 039 trigger', !!(await db.query(`SELECT last_sign_in_at FROM user_profiles WHERE id = '${ANA}'`)).rows[0]?.last_sign_in_at);
const admins = (await db.query(`SELECT email FROM user_profiles WHERE role = 'admin' AND is_active`)).rows.map((x) => x.email);
check('Ed is still the one and only active admin', JSON.stringify(admins) === JSON.stringify([OWNER]));

// ---- drift: the plan refuses when the database is not in the expected state -------------
const drift = await buildWorld({ preApplied: true });
const plan2 = await A.planMigration({ ...ctx, client: drift.client, filename: F });
check('drift: RLS already on BLOCKS the plan (no token)', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

if (db.close) { await db.close(); await drift.db.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
