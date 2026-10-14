// tests/sql/522_apply_one_e2e.mjs — migration 522 (Kat follow-up runs) applied END TO END through the
// single-migration tool with its REAL checks file: the live-run index becomes one OPEN run per key for
// every process, a posted bank reconciliation or cutoff run allows a follow-up, and interest and
// recognition still allow only one posted run per month. Drift (two open runs for a key) blocks it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  522 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '522_accounting_run_followups.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm522-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const C = '11111111-1111-4111-8111-111111111111', BA = '22222222-2222-4222-8222-222222222222';
async function world({ drift = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE accounting_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, process text, period_month date, subject_id uuid, status text, created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX uq_accounting_runs_live ON accounting_runs (community_id, process, period_month, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('prepared', 'approved', 'posted', 'held', 'failed');
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE bank_reconciliations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('518_cutoff_adjustment_runs.sql', 'recorded');
    INSERT INTO accounting_runs (community_id, process, period_month, subject_id, status) VALUES ('${C}', 'bank_reconciliation', '2026-08-01', '${BA}', 'posted'), ('${C}', 'interest', '2026-08-01', NULL, 'posted');
    INSERT INTO journal_entries (reference) VALUES ('JE-1');`);
  if (drift) { await db.exec(`DROP INDEX uq_accounting_runs_live; CREATE UNIQUE INDEX uq_accounting_runs_live ON accounting_runs (id) WHERE status = 'never'; INSERT INTO accounting_runs (community_id, process, period_month, status) VALUES ('${C}', 'recognition', '2026-09-01', 'prepared'), ('${C}', 'recognition', '2026-09-01', 'held');`); }
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}
const ctx = (client) => ({ client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const ins = async (db, process, subject, status) => { try { await db.exec(`INSERT INTO accounting_runs (community_id, process, period_month, subject_id, status) VALUES ('${C}', '${process}', '2026-08-01', ${subject ? `'${subject}'` : 'NULL'}, '${status}')`); return true; } catch (_) { return false; } };
const { db, client } = await world();
check('before 522: a follow-up reconciliation after a posted run is refused (the gap)', !(await ins(db, 'bank_reconciliation', BA, 'prepared')));
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, preflight: plan.preflight }).slice(0, 1200));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
check('apply: 522 applied and verified (no rows changed)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 1500));
if (r.status === 'applied') {
  check('a follow-up reconciliation for the posted account-month is allowed', await ins(db, 'bank_reconciliation', BA, 'prepared'));
  check('but only one OPEN run per key', !(await ins(db, 'bank_reconciliation', BA, 'held')));
  check('a cutoff follow-up after a posted cutoff run is allowed', (await ins(db, 'cutoff_adjustment', null, 'posted')) && (await ins(db, 'cutoff_adjustment', null, 'prepared')));
  check('a second POSTED interest run for the month is refused (amounts not keyed to a source)', !(await ins(db, 'interest', null, 'posted')));
  check('a second posted recognition run is refused', (await ins(db, 'recognition', null, 'posted')) && !(await ins(db, 'recognition', null, 'posted')));
}
const d = await world({ drift: true });
const p2 = await A.planMigration({ ...ctx(d.client), filename: F });
check('drift: two open runs for one key stop the plan (no token)', p2.status !== 'ready' && !p2.plan_token, JSON.stringify({ status: p2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
