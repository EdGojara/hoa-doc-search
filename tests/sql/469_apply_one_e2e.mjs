// tests/sql/469_apply_one_e2e.mjs — migration 469 applied END TO END through the
// single-migration tool (lib/migrations/apply_one.js) with its REAL checks file,
// in a production-shaped stub world (6 live-GL communities with 1000/1300, 10
// payment rows, ledger rows, 455-468 recorded). Proves the checks file matches
// what 469 actually does, and that drift blocks it. Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  469 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const { world469 } = await import('./_469_world.mjs');
const APPROVED_469_SHA256 = '5d10f2b485080dd459c020e7cbcf02b97fc17ded38d05728959d9d2ff2653130';
const F = '469_payments_safe_foundation.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };

// Deployed-folder copy with LF endings (what Render's Linux checkout has).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm469-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));

async function buildWorld({ extraCommunity = false } = {}) {
  const db = new PGlite();
  const { stub, real } = world469(REPO);
  await db.exec(stub); await db.exec(real);
  const checks = JSON.parse(fs.readFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), 'utf8'));
  await db.exec(`
    CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid, account_id uuid, debit_cents bigint, credit_cents bigint);
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) SELECT f, 'recorded' FROM unnest(ARRAY[${checks.requires.map((r) => `'${r}'`).join(',')}]) f;`);
  const comms = Array.from({ length: extraCommunity ? 7 : 6 }, (_, i) => `a0000000-0000-4000-8000-00000000000${i + 1}`);
  for (const c of comms) {
    await db.exec(`INSERT INTO communities VALUES ('${c}', gen_random_uuid(), '2026-06-01', false, NULL);
      INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_subtype) VALUES ('${c}', '1000', 'Operating Cash Account', 'current_asset'), ('${c}', '1300', 'Accounts Receivable', 'current_asset');
      INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance) VALUES ('${c}', '4000', 'Assessment Income', 'revenue', 'credit');`);
  }
  await db.exec(`INSERT INTO communities VALUES ('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), NULL, false, NULL);   -- no GL (August Meadows-like)
    INSERT INTO properties VALUES ('00000000-0000-0000-0000-0000000000b1', '${comms[0]}', '2013059', '1004384184');
    INSERT INTO contacts VALUES ('00000000-0000-0000-0000-0000000000c1', 'Owner', NULL, NULL);
    INSERT INTO ownership_tenures VALUES ('00000000-0000-0000-0000-0000000000d1', '${comms[0]}', '00000000-0000-0000-0000-0000000000b1', 'owner', '2026-01-01', NULL, '2013059');
    INSERT INTO transaction_upload_batches (id, community_id, source_format, status) VALUES ('00000000-0000-0000-0000-0000000000e1', '${comms[0]}', 'manual', 'committed');
    INSERT INTO homeowner_transactions (source_batch_id, community_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, raw_row_jsonb)
      VALUES ('00000000-0000-0000-0000-0000000000e1', '${comms[0]}', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', '2026-07-01', 'Q3', 'charge', 'assessment', 20000, '{"source":"stripe_assessment"}');
    INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ('${comms[0]}', 'payment_intake', 'cs_test_legacy');
    INSERT INTO payments (community_id, product_type, fee_type, amount_cents, status) SELECT '${comms[0]}', CASE WHEN g <= 6 THEN 'assessment_payment' ELSE 'amenity_rental' END, 'assessment', 100, 'pending' FROM generate_series(1, 10) g;`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });

// ---- the real thing ----
const { db, client } = await buildWorld();
const q1 = async (sql) => (await db.query(sql)).rows[0];
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: 469 hash is exactly the approved SHA-256', plan.sha256 === APPROVED_469_SHA256, plan.sha256);
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.length === 16 && plan.preflight.every((p) => p.ok), JSON.stringify(plan.preflight.filter((p) => !p.ok)));
check('plan: shows 6 + 18 inserts, 14 protected tables, 97 added / 2 changed / 0 removed objects',
  plan.row_changes.chart_of_accounts === 6 && plan.row_changes.community_account_roles === 18 && plan.protected.length === 14
  && plan.objects.added.length === 97 && plan.objects.changed.length === 2 && plan.objects.removed.length === 0);
const before = await q1(`SELECT (SELECT count(*) FROM payments)::int p, (SELECT count(*) FROM homeowner_transactions)::int h, (SELECT count(*) FROM journal_entries)::int j`);
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} },
  apiCheck: async ({ table }) => ({ ok: true, count: Number((await q1(`SELECT count(*)::int n FROM ${table}`)).n) }) });
check('apply: 469 applied and verified through the tool', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 600));
if (r.status === 'applied') {
  check('apply: exactly +6 accounts, +18 roles, stripe_events net 0', r.detail.row_changes.chart_of_accounts === 6 && r.detail.row_changes.community_account_roles === 18 && r.detail.row_changes.stripe_events === 0);
  check('apply: all 14 protected tables unchanged', r.detail.protected.length === 14 && r.detail.protected.every((p) => p.unchanged));
  check('apply: all 8 verification checks pass', r.detail.verify.length === 8 && r.detail.verify.every((v) => v.ok));
  check('apply: only chart_of_accounts / community_account_roles / stripe_events had rows written', r.detail.tables_written.map((t) => t.table).join() === 'chart_of_accounts,community_account_roles,stripe_events', JSON.stringify(r.detail.tables_written));
  const rec = await q1(`SELECT sha256, status, applied_via, commit_sha, error FROM schema_migrations WHERE filename = '${F}'`);
  check('record: 469 recorded with the approved hash, status applied, deployed commit, via owner_single_apply', rec.sha256 === APPROVED_469_SHA256 && rec.status === 'applied' && rec.applied_via === 'owner_single_apply' && rec.commit_sha === 'deadbeefcafe' && rec.error === null);
  const after = await q1(`SELECT (SELECT count(*) FROM payments)::int p, (SELECT count(*) FROM homeowner_transactions)::int h, (SELECT count(*) FROM journal_entries)::int j`);
  check('no payment, ledger row or journal entry created', JSON.stringify(before) === JSON.stringify(after));
  check('re-review after apply: already applied, no approval offered', (await A.planMigration({ ...ctx(client), filename: F })).status === 'already_applied');
}

// ---- production drift blocks it before anything runs ----
const w2 = await buildWorld({ extraCommunity: true });
const p2 = await A.planMigration({ ...ctx(w2.client), filename: F });
check('drift: a 7th community with a 1000 account BLOCKS the plan (preflight), no token', p2.status === 'blocked' && /exactly 6 accounts numbered 1000/.test(p2.reason) && !p2.plan_token);
const w3 = await buildWorld();
await w3.db.exec(`DELETE FROM schema_migrations WHERE filename = '461_homeowner_payment_applications.sql'`);
const p3 = await A.planMigration({ ...ctx(w3.client), filename: F });
check('drift: 461 not recorded BLOCKS the plan', p3.status === 'blocked' && /461_homeowner_payment_applications/.test(p3.reason));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
