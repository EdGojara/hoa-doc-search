// tests/sql/471_deposit_followups_rehearsal.mjs — rehearsal for the PROPOSED migration
// 471 (vendor deposit follow-ups) on top of the REAL 364 vendor_deposits table:
// idempotent apply, no data created, follow-up CHECKs, the reconciliation ledger's
// paid-check and append-only guards, one decision per reconciliation, grants, and
// an end-to-end apply through lib/migrations/apply_one.js with its real checks file.
// Skips without PGlite. Set DUMP_471_OBJECTS=1 to print the object diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  471 deposit follow-up rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const M364 = lf(`${REPO}/migrations/364_vendor_deposits.sql`);
const M471 = lf(`${REPO}/migrations/471_vendor_deposit_followups.sql`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const expectErr = async (name, fn, re) => { try { await fn(); fail++; console.log('FAIL ', name, '(no error)'); } catch (e) { const ok = !re || re.test(e.message); ok ? pass++ : fail++; console.log(ok ? 'PASS ' : 'FAIL ', name, ok ? '' : e.message); } };

const C = '00000000-0000-0000-0000-00000000000c', V = '00000000-0000-0000-0000-0000000000e1', INV = '00000000-0000-0000-0000-0000000000a1', INV2 = '00000000-0000-0000-0000-0000000000a2', DEP = '00000000-0000-0000-0000-0000000000d1';
const STUB = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TABLE communities (id uuid primary key, name text);
  CREATE TABLE vendors (id uuid primary key, name text);
  CREATE TABLE chart_of_accounts (id uuid primary key default gen_random_uuid(), account_number text);
  CREATE TABLE journal_entries (id uuid primary key default gen_random_uuid(), community_id uuid);
  CREATE TABLE journal_entry_lines (id uuid primary key default gen_random_uuid(), journal_entry_id uuid);
  CREATE TABLE ap_invoices (id uuid primary key, community_id uuid NOT NULL, vendor_id uuid NOT NULL, vendor_invoice_number text, total_cents bigint NOT NULL CHECK (total_cents > 0),
    amount_paid_cents bigint NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'awaiting_approval');
  CREATE TABLE ap_payments (id uuid primary key default gen_random_uuid(), amount_cents bigint);
  CREATE TABLE vendor_projects (id uuid primary key default gen_random_uuid(), community_id uuid NOT NULL, title text);
`;
async function world() {
  const db = new PGlite();
  await db.exec(STUB);
  await db.exec(`INSERT INTO communities VALUES ('${C}', 'Waterview Estates'); INSERT INTO vendors VALUES ('${V}', 'PRYME THYME KOOKERS');
    INSERT INTO ap_invoices (id, community_id, vendor_id, vendor_invoice_number, total_cents) VALUES ('${INV}', '${C}', '${V}', '2836', 334250), ('${INV2}', '${C}', '${V}', '2901', 334250);`);
  await db.exec(M364);
  await db.exec(`INSERT INTO vendor_deposits (id, community_id, vendor_id, deposit_invoice_id, deposit_amount_cents, remaining_balance_cents) VALUES ('${DEP}', '${C}', '${V}', '${INV}', 334250, 334250);`);
  return db;
}

// ---- apply twice, no data created, existing deposit untouched ----
const db = await world();
const snap = async () => JSON.stringify((await db.query(`SELECT id, deposit_amount_cents, remaining_balance_cents, status FROM vendor_deposits ORDER BY id`)).rows);
const before = await snap();
await db.exec(M471); await db.exec(M471);
check('471 applies twice (idempotent); existing deposit row unchanged; nothing created', before === await snap()
  && Number((await db.query(`SELECT count(*)::int n FROM vendor_deposit_reconciliations`)).rows[0].n) === 0);
const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='vendor_deposits'`)).rows.map((r) => r.column_name);
check('follow-up columns added', ['event_date', 'balance_due_date', 'balance_due_basis', 'agreed_total_cents', 'agreed_total_basis', 'project_id'].every((c) => cols.includes(c)));

// ---- follow-up CHECKs ----
await db.exec(`UPDATE vendor_deposits SET event_date='2026-10-10', balance_due_date='2026-10-10', balance_due_basis='staff_entered', agreed_total_cents=668500, agreed_total_basis='invoice_estimate' WHERE id='${DEP}'`);
check('follow-up recorded on the existing deposit', (await db.query(`SELECT balance_due_date::text d FROM vendor_deposits WHERE id='${DEP}'`)).rows[0].d === '2026-10-10');
await expectErr('an unknown agreed-total basis is refused', () => db.query(`UPDATE vendor_deposits SET agreed_total_basis='guess' WHERE id='${DEP}'`), /check/i);
await expectErr('a negative agreed total is refused', () => db.query(`UPDATE vendor_deposits SET agreed_total_cents=-1 WHERE id='${DEP}'`), /check/i);

// ---- reconciliation ledger ----
const rec = (o = {}) => db.query(`INSERT INTO vendor_deposit_reconciliations (deposit_id, community_id, vendor_id, incoming_invoice_id, form, deposit_billed_cents, deposit_paid_cents, deposit_still_owed_cents,
    incoming_face_cents, net_due_cents, final_total_cents, needs_review, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'emma') RETURNING id`,
  [DEP, C, V, INV2, o.form || 'balance_only', 334250, o.paid ?? 0, o.owed ?? 334250, 334250, 334250, 668500, false]);
const r1 = (await rec()).rows[0].id;
check('a reconciliation proposal is recorded', !!r1);
await expectErr('deposit paid + still owed must equal deposit billed', () => rec({ paid: 100, owed: 100 }), /paid_check/);
await expectErr('an unknown form is refused', () => rec({ form: 'guess' }), /check/i);
await expectErr('a reconciliation cannot be edited', () => db.query(`UPDATE vendor_deposit_reconciliations SET net_due_cents = 1`), /permanent/);
await expectErr('a reconciliation cannot be deleted', () => db.query(`DELETE FROM vendor_deposit_reconciliations`), /permanent/);
await db.query(`INSERT INTO vendor_deposit_reconciliation_decisions (reconciliation_id, decision, decided_by_name) VALUES ($1, 'approve', 'Ed')`, [r1]);
await expectErr('only one decision per reconciliation', () => db.query(`INSERT INTO vendor_deposit_reconciliation_decisions (reconciliation_id, decision, decided_by_name) VALUES ($1, 'reject', 'Ed')`, [r1]), /duplicate|unique/i);
const r2 = (await rec()).rows[0].id;
await db.query(`INSERT INTO vendor_deposit_reconciliation_decisions (reconciliation_id, decision, decided_by_name, note) VALUES ($1, 'unrelated', 'Ed', 'different job')`, [r2]);
check('"unrelated" is an allowed decision', true);
await expectErr('an unknown decision is refused', async () => { const r3 = (await rec()).rows[0].id; await db.query(`INSERT INTO vendor_deposit_reconciliation_decisions (reconciliation_id, decision, decided_by_name) VALUES ($1, 'pay', 'Ed')`, [r3]); }, /check/i);
await expectErr('decisions cannot be edited', () => db.query(`UPDATE vendor_deposit_reconciliation_decisions SET decision='reject'`), /permanent/);
await db.query(`INSERT INTO vendor_deposit_events (deposit_id, event_type, actor) VALUES ($1, 'followup_set', 'Ed')`, [DEP]);
await expectErr('events cannot be deleted', () => db.query(`DELETE FROM vendor_deposit_events`), /permanent/);
await expectErr('a deposit with a reconciliation cannot be deleted out from under it', () => db.query(`DELETE FROM vendor_deposits WHERE id='${DEP}'`), /foreign key|violates/i);
check('no payment or journal entry was written by any of this', Number((await db.query(`SELECT (SELECT count(*) FROM ap_payments) + (SELECT count(*) FROM journal_entries) AS n`)).rows[0].n) === 0);
const grants = (await db.query(`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'vendor_deposit_reconciliations'`)).rows;
check('ledger grants: service_role SELECT+INSERT only; nothing for anon/authenticated',
  grants.filter((g) => g.grantee === 'service_role').map((g) => g.privilege_type).sort().join(',') === 'INSERT,SELECT' && !grants.some((g) => ['anon', 'authenticated'].includes(g.grantee)), JSON.stringify(grants));

// ---- end to end through the single-migration tool with the real checks file ----
const checksPath = `${REPO}/migrations/checks/471_vendor_deposit_followups.json`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm471-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, '471_vendor_deposit_followups.sql'), M471);
fs.writeFileSync(path.join(dir, 'checks', '471_vendor_deposit_followups.json'), fs.existsSync(checksPath) ? lf(checksPath) : JSON.stringify({
  migration: '471_vendor_deposit_followups.sql', summary: 'dump', requires: [], preflight: [], expected_changes: ['x'], objects: { added: [], changed: [], removed: [] }, row_changes: {}, protected: [], verify: [], api_checks: [], reload_schema: true }));
const db2 = await world();
await db2.exec(`CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO schema_migrations (filename, sha256) VALUES ('321_vendor_projects.sql', 'r'), ('364_vendor_deposits.sql', 'r');`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db2.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db2.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'owner', email: 'owner@example.test' }, deployedCommit: 'feedface', migrationsDir: dir, secret: 's' };
const plan = await A.planMigration({ ...ctx, filename: '471_vendor_deposit_followups.sql' });
check('tool plan: 471 ready, all preflight green', plan.status === 'ready' && (plan.preflight || []).every((p) => p.ok), JSON.stringify(plan.preflight || plan.reason));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} }, apiCheck: async () => ({ ok: true, count: 0 }) });
if (process.env.DUMP_471_OBJECTS) console.log(JSON.stringify({ status: r.status, error: r.error, objects: r.detail && r.detail.objects, written: r.detail && r.detail.tables_written }, null, 1));
check('tool apply: 471 applied, verified, recorded; no rows written', r.status === 'applied' && r.detail.verify.every((v) => v.ok) && r.detail.protected.every((p) => p.unchanged) && r.detail.tables_written.length === 0,
  JSON.stringify({ status: r.status, error: r.error, written: r.detail && r.detail.tables_written }).slice(0, 500));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
