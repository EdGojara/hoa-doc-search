// tests/sql/518_apply_one_e2e.mjs — migration 518 (cutoff_adjustment runs) applied END TO END
// through the single-migration tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 518 does (one changed constraint, no rows);
//   - a cutoff_adjustment run can be recorded afterwards; the other processes still can;
//     an unknown process is still refused;
//   - drift blocks it (a process check already changed stops the plan at preflight).
// Postgres 17 (PGlite). Skips without PGlite. --print-objects prints the catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  518 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '518_cutoff_adjustment_runs.sql';
const PRINT = process.argv.includes('--print-objects');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm518-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const real = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(PRINT ? { ...real, objects: { added: [], changed: [], removed: [] } } : real, null, 2));

async function world({ drift = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE accounting_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL, period_month date NOT NULL,
      process text NOT NULL CONSTRAINT accounting_runs_process_check CHECK (process IN ('recognition', 'interest')), status text NOT NULL DEFAULT 'prepared');
    ALTER TABLE accounting_runs DROP CONSTRAINT IF EXISTS accounting_runs_process_check;
    ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check CHECK (process IN ('recognition', 'interest', 'bank_reconciliation'));
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_number text);
    CREATE TABLE recognition_schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), description text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('511_kat_bank_reconciliation.sql', 'recorded');
    INSERT INTO accounting_runs (community_id, period_month, process) VALUES ('00000000-0000-0000-0000-000000000003', '2026-08-01', 'interest');
    INSERT INTO journal_entries (reference) VALUES ('JE-2026-00317');
    INSERT INTO chart_of_accounts (account_number) VALUES ('2300');
    INSERT INTO recognition_schedules (description) VALUES ('Hamann insurance');`);
  if (drift) await db.exec(`ALTER TABLE accounting_runs DROP CONSTRAINT accounting_runs_process_check; ALTER TABLE accounting_runs ADD CONSTRAINT accounting_runs_process_check CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment', 'other'));`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const ctx = (client) => ({ client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const tryErr = async (db, sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };

const { db, client } = await world();
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, error: r.error }, null, 2)); process.exit(0); }
check('apply: 518 applied and verified through the tool (one changed constraint, no row changes, protected tables unchanged)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));
if (r.status === 'applied') {
  check('a cutoff_adjustment run can be recorded', (await tryErr(db, `INSERT INTO accounting_runs (community_id, period_month, process) VALUES ('00000000-0000-0000-0000-000000000003', '2026-08-01', 'cutoff_adjustment')`)) === null);
  check('the existing processes are still allowed', (await tryErr(db, `INSERT INTO accounting_runs (community_id, period_month, process) VALUES ('00000000-0000-0000-0000-000000000003', '2026-09-01', 'bank_reconciliation')`)) === null);
  check('an unknown process is still refused', /accounting_runs_process_check/.test(await tryErr(db, `INSERT INTO accounting_runs (community_id, period_month, process) VALUES ('00000000-0000-0000-0000-000000000003', '2026-09-01', 'anything')`) || ''));
}
const d = await world({ drift: true });
const p2 = await A.planMigration({ ...ctx(d.client), filename: F });
check('drift: a process check that is not the 511 one stops the plan at preflight (no token)', p2.status !== 'ready' && !p2.plan_token, JSON.stringify({ status: p2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
