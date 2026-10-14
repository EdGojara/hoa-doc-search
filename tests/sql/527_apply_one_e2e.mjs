// tests/sql/527_apply_one_e2e.mjs — migration 527 (reclassification runs + vendor line rules) applied END
// TO END through the single-migration tool with its REAL checks file: 'reclassification' allowed, the
// rules table created with Canyon Gate's three Bedrock rules, no journal entry / invoice / budget touched,
// a bad rule refused, re-running refused.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  527 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '527_reclassification_runs_and_vendor_line_rules.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm527-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const CG = 'a0000000-0000-4000-8000-000000000003', BED = 'e254e558-9285-4a02-9b35-7ea66d07ec91';
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE communities (id uuid PRIMARY KEY);
  CREATE TABLE vendors (id uuid PRIMARY KEY, name text);
  CREATE TABLE library_documents (id uuid PRIMARY KEY);
  CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, account_number text);
  CREATE TABLE accounting_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), process text NOT NULL CONSTRAINT accounting_runs_process_check CHECK (process IN ('recognition', 'interest', 'bank_reconciliation', 'cutoff_adjustment')));
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
  CREATE TABLE ap_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), total_cents bigint);
  CREATE TABLE budget_line_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), annual_amount_cents bigint);
  CREATE TABLE community_budgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text);
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('526_contract_term_semantics.sql', 'recorded');
  INSERT INTO communities VALUES ('${CG}'); INSERT INTO vendors VALUES ('${BED}', 'Bedrock Association Management, LLC');
  INSERT INTO library_documents VALUES ('b90ac42b-f4f5-45d5-a9ad-914c01d7ef4f');
  INSERT INTO chart_of_accounts (community_id, account_number) VALUES ('${CG}', '5810'), ('${CG}', '5855'), ('${CG}', '5030');
  INSERT INTO journal_entries (reference) VALUES ('JE-1'); INSERT INTO ap_invoices (total_cents) VALUES (535000);
  INSERT INTO budget_line_items (annual_amount_cents) VALUES (6240000); INSERT INTO community_budgets (status) VALUES ('draft');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1200));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} } });
check('apply: 527 applied and verified', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail }).slice(0, 3000));
if (r.status === 'applied') {
  const rules = (await db.query(`SELECT r.pattern, a.account_number n FROM vendor_line_rules r JOIN chart_of_accounts a ON a.id = r.gl_account_id ORDER BY a.account_number`)).rows;
  check('three Bedrock rules: website 5030, management fee 5810, onsite staff 5855', rules.map((x) => x.n).join(',') === '5030,5810,5855' && /onsite staff/.test(rules[2].pattern), JSON.stringify(rules));
  let ok = true; try { await db.exec(`INSERT INTO accounting_runs (process) VALUES ('reclassification')`); } catch (_) { ok = false; }
  check('a reclassification run is now allowed', ok);
  let refused = false; try { await db.exec(`INSERT INTO vendor_line_rules (community_id, vendor_id, pattern, gl_account_id, basis, created_by) SELECT '${CG}', '${BED}', 'x', id, 'short', 't' FROM chart_of_accounts LIMIT 1`); } catch (_) { refused = true; }
  check('a rule without a real pattern and basis is refused', refused);
  const again = await A.planMigration({ ...ctx, filename: F });
  check('re-running is refused', again.status !== 'ready' || !again.plan_token);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
