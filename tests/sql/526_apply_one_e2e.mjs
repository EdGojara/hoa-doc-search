// tests/sql/526_apply_one_e2e.mjs — migration 526 (contract term semantics) applied END TO END through
// the single-migration tool with its REAL checks file: 'cap_pct' allowed, escalator_start_year added, the
// two Canyon Gate contracts corrected from their clauses, nothing else changed; re-running is refused.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  526 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '526_contract_term_semantics.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm526-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE vendor_contracts (id uuid PRIMARY KEY, vendor_name_raw text, escalator_kind text DEFAULT 'none' CONSTRAINT vendor_contracts_escalator_kind_check CHECK (escalator_kind IN ('max_cpi_or_pct','fixed_pct','cpi_only','none')), escalator_pct numeric(5,2), notes text);
  CREATE TABLE budget_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), annual_amount_cents bigint);
  CREATE TABLE community_budgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text);
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('521_budget_line_basis.sql', 'recorded');
  INSERT INTO vendor_contracts VALUES ('96321a51-d765-4fe2-ae37-adcfbd87f39a', 'United Protective Services of South Texas, L.P.', 'max_cpi_or_pct', 3, 'Attached'),
    ('506222f2-dd38-4708-ba45-856f64b3b29d', 'Gate Sentry, LLC', 'fixed_pct', 5, 'Attached'), ('00000000-0000-4000-8000-0000000000aa', 'Other Co', 'max_cpi_or_pct', 3, null);
  INSERT INTO budget_line_items (annual_amount_cents) VALUES (22914450); INSERT INTO community_budgets (status) VALUES ('draft'); INSERT INTO journal_entries (reference) VALUES ('JE-1');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1200));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} } });
check('apply: 526 applied and verified', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 1500));
if (r.status === 'applied') {
  const rows = (await db.query(`SELECT vendor_name_raw n, escalator_kind k, escalator_pct p, escalator_start_year y, notes FROM vendor_contracts ORDER BY vendor_name_raw`)).rows;
  const ups = rows.find((x) => /United/.test(x.n)); const gs = rows.find((x) => /Gate Sentry/.test(x.n)); const other = rows.find((x) => /Other/.test(x.n));
  check('UPS: a 3% ceiling, with a note quoting the clause', ups.k === 'cap_pct' && Number(ups.p) === 3 && /not to exceed 3%/.test(ups.notes));
  check('Gate Sentry: escalation from contract year 4, with a note', gs.y === 4 && /beginning with year 4/.test(gs.notes));
  check('no other contract changed', other.k === 'max_cpi_or_pct' && other.y === null && other.notes === null);
  let refused = false; try { await db.exec(`UPDATE vendor_contracts SET escalator_start_year = 1 WHERE vendor_name_raw = 'Other Co'`); } catch (_) { refused = true; }
  check('a start year below 2 is refused', refused);
  const again = await A.planMigration({ ...ctx, filename: F });
  check('re-running is refused', again.status !== 'ready' || !again.plan_token);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
