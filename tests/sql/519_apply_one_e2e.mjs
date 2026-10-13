// tests/sql/519_apply_one_e2e.mjs — migration 519 (LOPF bank reconciliation setup) applied END TO END
// through the single-migration tool with its REAL checks file. Proves: one automation row added
// (enabled, auto-post off), Savings and Reserve opening positions set at 7/31 bank = book, no
// journal entry / run / statement touched, and drift (an automation row already present) blocks it.
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints the catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  519 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '519_lopf_bank_reconciliation.sql';
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm519-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const real = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(PRINT ? { ...real, objects: { added: [], changed: [], removed: [] } } : real, null, 2));
const L = 'a0000000-0000-4000-8000-000000000002';
const SAV = '8467a5a4-1291-4d94-8c28-b5f85fd862e0', RES = 'f7124b35-d108-44f9-a304-9834964dcae7', OPR = '13d7c91d-955c-43a1-bee6-a77c8b5a84de', ICS = 'a427816e-3810-47b9-aced-f4728fbc9e93';

async function world({ drift = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY, community_id uuid, account_nickname text, opening_position jsonb);
    CREATE TABLE community_accounting_automation (community_id uuid NOT NULL, process text NOT NULL, enabled boolean NOT NULL DEFAULT false, auto_post boolean NOT NULL DEFAULT false, settings jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by text, CONSTRAINT caa_pk PRIMARY KEY (community_id, process));
    CREATE TABLE bank_statement_imports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bank_account_id uuid, statement_period_end date, ending_balance_cents bigint);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, account_number text);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE accounting_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), process text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('511_kat_bank_reconciliation.sql', 'recorded');
    INSERT INTO communities VALUES ('${L}', 'Lakes of Pine Forest'), ('a0000000-0000-4000-8000-000000000003', 'Canyon Gate');
    INSERT INTO bank_accounts VALUES ('${SAV}', '${L}', 'LOPF Savings', NULL), ('${RES}', '${L}', 'LOPF Reserve Money Market', NULL), ('${OPR}', '${L}', 'LOPF Operating Checking', NULL), ('${ICS}', '${L}', 'LOPF ICS', NULL);
    INSERT INTO community_accounting_automation (community_id, process, enabled, settings) VALUES ('a0000000-0000-4000-8000-000000000003', 'bank_reconciliation', true, '{}');
    INSERT INTO bank_statement_imports (bank_account_id, statement_period_end, ending_balance_cents) VALUES ('${SAV}', '2026-07-31', 19776656), ('${RES}', '2026-07-31', 24058457);
    INSERT INTO chart_of_accounts (community_id, account_number) VALUES ('${L}', '4110'), ('${L}', '4120'), ('${L}', '4100'), ('${L}', '1005');
    INSERT INTO journal_entries (reference) VALUES ('JE-1'); INSERT INTO accounting_runs (process) VALUES ('interest');`);
  if (drift) await db.exec(`INSERT INTO community_accounting_automation (community_id, process, enabled, settings) VALUES ('${L}', 'bank_reconciliation', false, '{}')`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const ctx = (client) => ({ client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await world();
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, rows: r.detail && r.detail.row_changes, error: r.error }, null, 2)); process.exit(0); }
check('apply: 519 applied and verified (one automation row, no other row added; GL, runs, statements unchanged)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));
if (r.status === 'applied') {
  const a = (await db.query(`SELECT enabled, auto_post, settings FROM community_accounting_automation WHERE community_id = '${L}'`)).rows[0];
  check('LOPF automation: enabled, auto-post off, Savings + Reserve, interest 4110 / 4120, ICS transfer rule to 1005', a.enabled && !a.auto_post && a.settings.bank_account_ids.length === 2 && a.settings.interest_income_accounts[SAV] === '4110' && a.settings.interest_income_accounts[RES] === '4120' && a.settings.transfer_rules[0].account === '1005');
  const o = (await db.query(`SELECT id, opening_position FROM bank_accounts ORDER BY account_nickname`)).rows;
  check('opening positions only on Savings and Reserve, bank = book at 7/31', o.filter((x) => x.opening_position).map((x) => x.id).sort().join() === [RES, SAV].sort().join() && o.filter((x) => x.opening_position).every((x) => x.opening_position.bank_balance_cents === x.opening_position.book_balance_cents && x.opening_position.as_of_date === '2026-07-31'));
}
const d = await world({ drift: true });
const p2 = await A.planMigration({ ...ctx(d.client), filename: F });
check('drift: an existing LOPF automation row stops the plan at preflight (no token)', p2.status !== 'ready' && !p2.plan_token, JSON.stringify({ status: p2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
