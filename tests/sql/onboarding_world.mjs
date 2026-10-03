// tests/sql/onboarding_world.mjs — shared PGlite world for the onboarding engine
// tests: the stub tables 452 references, then the REAL 452 / 481 (and optionally
// 482 / 483 / 484) migration files, exactly as committed. Returns { db, client, rpc }.
//   rpc(name, args) calls a SQL function with named arguments, like supabase.rpc.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
export const COMM = '00000000-0000-0000-0000-0000000000c1';

export async function onboardingWorld(PGlite, { through = 485 } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY);
    CREATE TABLE account_funds (id uuid PRIMARY KEY);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY);
    CREATE TABLE vendors (id uuid PRIMARY KEY);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities VALUES ('${COMM}', 'Example Creek');`);
  await db.exec(lf(`${REPO}/migrations/452_conversion_staging.sql`));
  await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('452_conversion_staging.sql', 'recorded'), ('480_acc_finalization_record.sql', 'recorded')`);
  if (through >= 481) { await db.exec(lf(`${REPO}/migrations/481_onboarding_engine.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('481_onboarding_engine.sql', 'recorded')`); }
  if (through >= 482) { await db.exec(lf(`${REPO}/migrations/482_onboarding_service.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('482_onboarding_service.sql', 'recorded')`); }
  if (through >= 483) { await db.exec(lf(`${REPO}/migrations/483_onboarding_snapshot.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('483_onboarding_snapshot.sql', 'recorded')`); }
  if (through >= 484) { await db.exec(lf(`${REPO}/migrations/484_onboarding_activity_bridge.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('484_onboarding_activity_bridge.sql', 'recorded')`); }
  if (through >= 485) { await db.exec(lf(`${REPO}/migrations/485_onboarding_operator.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('485_onboarding_operator.sql', 'recorded')`); }
  if (through >= 486) { await db.exec(lf(`${REPO}/migrations/486_onboarding_bridge_decisions.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('486_onboarding_bridge_decisions.sql', 'recorded')`); }
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  const rpc = async (name, args = {}) => {
    if (!/^[a-z_]+$/.test(name)) throw new Error('bad function name');
    const keys = Object.keys(args);
    const sql = `SELECT ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`;
    try {
      const res = await db.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
      return res.rows[0] ? res.rows[0].r : null;
    } catch (e) { const err = new Error(e.message); err.code = e.code; throw err; }
  };
  return { db, client, rpc };
}
