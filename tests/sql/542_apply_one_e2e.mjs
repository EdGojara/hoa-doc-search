// tests/sql/542_apply_one_e2e.mjs — migration 542 (Positive Pay submission tracking)
// applied END TO END through the single-migration tool with its REAL checks file.
// Proves:
//   - the checks file declares exactly what 542 creates (catalog diff passes);
//   - exactly the four Addendum accounts are enrolled; every other account, the
//     former client's included, is not; no export cutoff is set;
//   - check_register and journal_entries are untouched;
//   - the one-live-row-per-check index refuses a second live row, and an outcome
//     without who recorded it and the bank's message is refused;
//   - drift blocks it (the tables already present stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  542 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '542_positive_pay_submissions.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm542-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const NF = '16e07b6a-8902-4d1a-980e-db78938b98b3';
const ADD = ['2dd4bf0b-0e71-4da0-b8a7-269845ddf54c', '52cf2b77-4277-4b11-9e3f-60177f419f5f', '13d7c91d-955c-43a1-bee6-a77c8b5a84de', '829b287e-3d9f-4a4e-9eab-4ba437a329be'];
const EAGLEWOOD = 'e2e85e98-d11d-417d-99e7-e555dfe9de51', QUAIL = '03a431b3-7389-49bc-a0e9-23820f708989';

async function buildWorld({ preTables = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE banks (id uuid PRIMARY KEY, name text, positive_pay_settings jsonb);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY, community_id uuid, bank_id uuid REFERENCES banks(id), account_nickname text);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE check_register (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bank_account_id uuid, check_number text, status text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities VALUES ('a0000000-0000-4000-8000-000000000003','Canyon Gate'), ('00000000-0000-0000-0000-00000000c0e1','Eaglewood');
    INSERT INTO banks VALUES ('${NF}','NewFirst National Bank','{"exception_cutoff":"10:00"}'), ('d61b9780-0000-0000-0000-000000000000','First Citizens Bank',NULL);
    INSERT INTO bank_accounts VALUES
      ('${ADD[0]}','a0000000-0000-4000-8000-000000000003','${NF}','Canyon Gate Operating'), ('${ADD[1]}',NULL,'${NF}','Still Creek Operating'),
      ('${ADD[2]}',NULL,'${NF}','LOPF Operating'), ('${ADD[3]}',NULL,'${NF}','Waterview Operating'),
      ('${EAGLEWOOD}','00000000-0000-0000-0000-00000000c0e1','${NF}','Eaglewood Operating'),
      ('${QUAIL}',NULL,'d61b9780-0000-0000-0000-000000000000','Quail Ridge Operating');
    INSERT INTO check_register (bank_account_id, check_number, status) VALUES ('${ADD[0]}','1025','issued'), ('${ADD[0]}','1026','voided');
    INSERT INTO journal_entries (reference) VALUES ('JE-2026-00295');
    INSERT INTO schema_migrations (filename, sha256) VALUES ('541_acc_decision_authority_guard.sql', 'recorded');`);
  if (preTables) await db.exec(`CREATE TABLE positive_pay_submissions (id uuid PRIMARY KEY);`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

const { db, client } = await buildWorld();
const q1 = async (sql) => (await db.query(sql)).rows[0];
const tryErr = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };
const regBefore = await q1(`SELECT string_agg(row_to_json(c)::text, ',' ORDER BY id) j FROM check_register c`);
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, error: plan.error, preflight: plan.preflight }).slice(0, 800));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
check('apply: 542 applied and verified through the tool (objects, row changes, protected tables, checks)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 4000));
if (r.status === 'applied') {
  const en = (await db.query(`SELECT id FROM bank_accounts WHERE positive_pay_enabled ORDER BY id`)).rows.map((x) => x.id);
  check('exactly the four Addendum accounts are enrolled', JSON.stringify(en) === JSON.stringify([...ADD].sort()));
  check('the former client (Eaglewood) and the non-NewFirst account (Quail Ridge) are not', !en.includes(EAGLEWOOD) && !en.includes(QUAIL));
  check('no export cutoff is set; the bank keeps its other settings', (await q1(`SELECT positive_pay_settings::text s FROM banks WHERE id = '${NF}'`)).s === '{"exception_cutoff": "10:00"}');
  check('check_register untouched', (await q1(`SELECT string_agg(row_to_json(c)::text, ',' ORDER BY id) j FROM check_register c`)).j === regBefore.j);
  const k = (await q1(`SELECT id FROM check_register WHERE check_number = '1025'`)).id;
  await db.exec(`INSERT INTO positive_pay_submissions (id, bank_id, file_name, file_sha256, check_count, total_cents, prepared_by) VALUES ('11111111-1111-1111-1111-111111111111','${NF}','f.csv','x',1,422503,'Kat')`);
  await db.exec(`INSERT INTO positive_pay_submissions (id, bank_id, file_name, file_sha256, check_count, total_cents, prepared_by) VALUES ('22222222-2222-2222-2222-222222222222','${NF}','g.csv','y',1,422503,'Kat')`);
  const ins = (sid, row) => `INSERT INTO positive_pay_submission_items (submission_id, check_register_id, community_id, bank_account_id, check_number, issue_date, payee_sent, amount_cents, row_number) VALUES ('${sid}','${k}','a0000000-0000-4000-8000-000000000003','${ADD[0]}','1025','2026-09-04','Star Protection Agency LLC',422503,${row})`;
  check('a check goes in one live file', (await tryErr(ins('11111111-1111-1111-1111-111111111111', 1))) === null);
  check('a second live row for the same check is refused (no duplicate submission)', /uq_pp_items_one_live_per_check/.test(await tryErr(ins('22222222-2222-2222-2222-222222222222', 1)) || ''));
  check('an accepted outcome without who recorded it and the bank message is refused', /check/i.test(await tryErr(`UPDATE positive_pay_submissions SET status = 'accepted' WHERE id = '11111111-1111-1111-1111-111111111111'`) || ''));
  check('an outcome recorded by Kat (no user id) with the bank message is accepted', (await tryErr(`UPDATE positive_pay_submissions SET status = 'accepted', outcome_recorded_at = now(), outcome_recorded_by_name = 'Kat Reed (AI accounting manager)', outcome_evidence = 'File imported successfully' WHERE id = '11111111-1111-1111-1111-111111111111'`)) === null);
  check('service_role can write both tables', (await q1(`SELECT has_table_privilege('service_role','positive_pay_submissions','INSERT') AND has_table_privilege('service_role','positive_pay_submission_items','UPDATE') ok`)).ok === true);
}
const drift = await buildWorld({ preTables: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing positive_pay_submissions table BLOCKS the plan, no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
