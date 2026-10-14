// tests/sql/523_apply_one_e2e.mjs — migration 523 (LOPF Savings -> Reserve transfer configuration)
// applied END TO END through the single-migration tool with its REAL checks file: GL 4015 is an
// interfund transfer from SAV to RES, two Savings rules exist (the 2025 one flagged), the ICS rule
// from 519 is kept, nothing else changes; a 4015 already present stops the plan. PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  523 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '523_lopf_savings_reserve_transfer.sql';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm523-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const L = 'a0000000-0000-4000-8000-000000000002';
async function world({ drift = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE account_funds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, fund_code text);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, fund_id uuid, account_number text, account_name text, account_type text, account_subtype text, normal_balance text, is_active boolean, is_summary boolean, interfund_from_fund_id uuid, interfund_to_fund_id uuid);
    CREATE TABLE community_accounting_automation (community_id uuid NOT NULL, process text NOT NULL, enabled boolean, auto_post boolean, settings jsonb NOT NULL, CONSTRAINT caa_pk PRIMARY KEY (community_id, process));
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text);
    CREATE TABLE accounting_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), process text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('520_lopf_operating_opening.sql', 'recorded');
    INSERT INTO account_funds (community_id, fund_code) VALUES ('${L}', 'OPR'), ('${L}', 'RES'), ('${L}', 'SAV');
    INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type) VALUES ('${L}', '1100', 'Savings Account', 'asset'), ('${L}', '1110', 'Money Market Account', 'asset')${drift ? `, ('${L}', '4015', 'Something else', 'revenue')` : ''};
    INSERT INTO community_accounting_automation VALUES ('${L}', 'bank_reconciliation', true, false, '{"bank_account_ids": ["8467a5a4-1291-4d94-8c28-b5f85fd862e0"], "transfer_rules": [{"match": "INTRAFI ICS", "account": "1005"}]}');
    INSERT INTO journal_entries (reference) VALUES ('JE-1'); INSERT INTO accounting_runs (process) VALUES ('interest');`);
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
check('apply: 523 applied and verified', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));
if (r.status === 'applied') {
  const a = (await db.query(`SELECT c.account_type, c.account_subtype, c.normal_balance, f.fund_code AS home, ff.fund_code AS f, tf.fund_code AS t FROM chart_of_accounts c JOIN account_funds f ON f.id = c.fund_id JOIN account_funds ff ON ff.id = c.interfund_from_fund_id JOIN account_funds tf ON tf.id = c.interfund_to_fund_id WHERE c.account_number = '4015'`)).rows[0];
  check('4015: revenue interfund transfer, home SAV, from SAV to RES', a && a.account_type === 'revenue' && a.account_subtype === 'interfund_transfer' && a.home === 'SAV' && a.f === 'SAV' && a.t === 'RES', JSON.stringify(a));
  const s = (await db.query(`SELECT settings FROM community_accounting_automation`)).rows[0].settings;
  check('two Savings rules added; the ICS rule kept; only the 2025 rule flagged', s.transfer_rules.length === 3 && s.transfer_rules[0].account === '1005' && s.transfer_rules.filter((x) => x.account === '4015' && x.counter_cash_account === '1110').length === 2 && s.transfer_rules.filter((x) => x.flag).length === 1 && /2025/.test(s.transfer_rules.find((x) => x.flag).match));
  const again = await A.planMigration({ ...ctx(client), filename: F });
  check('re-running is refused (already applied / 4015 exists)', again.status !== 'ready' || !again.plan_token);
}
const d = await world({ drift: true });
const p2 = await A.planMigration({ ...ctx(d.client), filename: F });
check('drift: an existing 4015 stops the plan (no token)', p2.status !== 'ready' && !p2.plan_token, JSON.stringify({ status: p2.status }));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
