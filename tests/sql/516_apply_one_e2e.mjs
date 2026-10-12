// tests/sql/516_apply_one_e2e.mjs — migration 516 (archived community status) applied END TO
// END through the single-migration tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 516 does (one changed constraint, no rows added,
//     ledger / GL / violations / interactions / documents byte-for-byte unchanged);
//   - only the community whose engagement ENDED (terminating, last day past) is archived,
//     with enforcement and ARC off; an active community, a prospect and a community still
//     inside its notice period are untouched;
//   - 'archived' is accepted afterwards and an unknown status is still refused;
//   - drift blocks it (a second ended community stops the plan at preflight).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite. --print-objects prints the catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  516 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '516_community_archived_status.sql';
const PRINT = process.argv.includes('--print-objects');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm516-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const realChecks = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const checks = PRINT ? { ...realChecks, objects: { added: [], changed: [], removed: [] } } : realChecks;
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(checks, null, 2));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const plusDays = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function buildWorld({ secondEnded = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text NOT NULL, updated_at timestamptz DEFAULT now());
    -- exactly as migration 382 added the lifecycle columns (inline CHECK => communities_management_status_check)
    ALTER TABLE communities
      ADD COLUMN IF NOT EXISTS management_status TEXT NOT NULL DEFAULT 'active' CHECK (management_status IN ('prospect', 'onboarding', 'active', 'terminating', 'terminated')),
      ADD COLUMN IF NOT EXISTS management_end_date DATE,
      ADD COLUMN IF NOT EXISTS financials_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS enforcement_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS arc_active BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, status text);
    CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid, debit_cents bigint, credit_cents bigint);
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, amount_cents bigint);
    CREATE TABLE violations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, current_stage text);
    CREATE TABLE interactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, type text);
    CREATE TABLE library_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, title text);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('382_community_management_lifecycle.sql', 'recorded');
  `);
  // Production shape: 9 active (one of them inside a notice period would be 'terminating'; here all active), 3 prospects, Eaglewood ended 2026-09-30.
  for (let i = 0; i < 9; i++) await db.exec(`INSERT INTO communities (id, name) VALUES ('${id(100 + i)}', 'Active ${i + 1}')`);
  for (let i = 0; i < 3; i++) await db.exec(`INSERT INTO communities (id, name, management_status) VALUES ('${id(200 + i)}', 'Prospect ${i + 1}', 'prospect')`);
  await db.exec(`INSERT INTO communities (id, name, management_status, management_end_date, financials_active) VALUES ('${id(300)}', 'Eaglewood', 'terminating', '${plusDays(-12)}', false)`);
  if (secondEnded) await db.exec(`INSERT INTO communities (id, name, management_status, management_end_date) VALUES ('${id(301)}', 'Also ended', 'terminating', '${plusDays(-1)}')`);
  // Historical records that must be preserved byte for byte.
  await db.exec(`INSERT INTO journal_entries (community_id, status) VALUES ('${id(300)}', 'posted');
    INSERT INTO journal_entry_lines (journal_entry_id, debit_cents, credit_cents) SELECT id, 1000, 0 FROM journal_entries;
    INSERT INTO homeowner_transactions (community_id, amount_cents) VALUES ('${id(300)}', 26000);
    INSERT INTO violations (community_id, current_stage) VALUES ('${id(300)}', 'certified_209');
    INSERT INTO interactions (community_id, type) VALUES ('${id(300)}', 'letter_209');
    INSERT INTO library_documents (community_id, title) VALUES ('${id(300)}', 'Eaglewood declaration');`);
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
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, row_changes: r.detail && r.detail.row_changes, written: r.detail && r.detail.tables_written, error: r.error }, null, 2)); process.exit(0); }
check('apply: 516 applied and verified through the tool (objects, row changes, protected history unchanged, verify)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));
if (r.status === 'applied') {
  const e = await q1(`SELECT management_status s, enforcement_active ea, arc_active aa, financials_active fa FROM communities WHERE name = 'Eaglewood'`);
  check('Eaglewood is archived with enforcement, ARC and financials off', e.s === 'archived' && e.ea === false && e.aa === false && e.fa === false, JSON.stringify(e));
  check('no other community changed', (await q1(`SELECT count(*)::int n FROM communities WHERE management_status = 'active' AND enforcement_active AND arc_active`)).n === 9 && (await q1(`SELECT count(*)::int n FROM communities WHERE management_status = 'prospect'`)).n === 3);
  check('history kept: the ledger row, journal entry, violation, letter and document are still there', (await q1(`SELECT (SELECT count(*) FROM homeowner_transactions) + (SELECT count(*) FROM journal_entries) + (SELECT count(*) FROM violations) + (SELECT count(*) FROM interactions) + (SELECT count(*) FROM library_documents) n`)).n == 5);
  check('an unknown status is still refused', /communities_management_status_check/.test(await tryErr(`UPDATE communities SET management_status = 'gone' WHERE name = 'Active 1'`) || ''));
}
const notice = await buildWorld();
await notice.db.exec(`UPDATE communities SET management_status = 'terminating', management_end_date = '${plusDays(30)}' WHERE name = 'Active 1'`);
const planN = await A.planMigration({ ...ctx(notice.client), filename: F });
check('any status change since review (here a community entering its notice period) stops the plan at preflight; nothing is archived on a world the owner did not review', planN.status !== 'ready', JSON.stringify({ status: planN.status }));
const drift = await buildWorld({ secondEnded: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: a second ended community BLOCKS the plan (preflight expects exactly Eaglewood), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
