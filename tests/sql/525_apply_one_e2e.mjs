// tests/sql/525_apply_one_e2e.mjs — migration 525 (per-bank Positive Pay settings) applied END TO
// END through the single-migration tool with its REAL checks file: banks gains positive_pay_settings,
// NewFirst gets the 10:00 cutoff and its four expected recipients (no Graywood), no other bank or
// account changes; re-running is refused. PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  525 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '525_bank_positive_pay_settings.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm525-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE banks (id uuid PRIMARY KEY, name text, notes text);
  CREATE TABLE bank_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bank_id uuid, account_last4 text);
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('524_unidentified_receipts_account.sql', 'recorded');
  INSERT INTO banks VALUES ('16e07b6a-8902-4d1a-980e-db78938b98b3', 'NewFirst National Bank', null), ('d61b9780-eea7-457a-9897-94000744cb56', 'First Citizens Bank', null);
  INSERT INTO bank_accounts (bank_id, account_last4) VALUES ('16e07b6a-8902-4d1a-980e-db78938b98b3', '5313'); INSERT INTO journal_entries (reference) VALUES ('JE-1');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'o', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1200));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} } });
check('apply: 525 applied and verified', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 1500));
if (r.status === 'applied') {
  const s = (await db.query(`SELECT name, positive_pay_settings s FROM banks ORDER BY name`)).rows;
  const nf = s.find((x) => x.name === 'NewFirst National Bank').s;
  check('NewFirst: 10:00 cutoff, newfirst.com, four expected recipients, no Graywood', nf.exception_cutoff === '10:00' && nf.notice_sender_domain === 'newfirst.com' && nf.expected_recipients.length === 4 && !JSON.stringify(nf).includes('graywood'), JSON.stringify(nf));
  check('First Citizens untouched', s.find((x) => x.name === 'First Citizens Bank').s === null);
  const again = await A.planMigration({ ...ctx, filename: F });
  check('re-running is refused', again.status !== 'ready' || !again.plan_token);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
