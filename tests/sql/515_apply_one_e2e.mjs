// tests/sql/515_apply_one_e2e.mjs — migration 515 (certified collections notices) applied END
// TO END through the single-migration tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 515 does (objects, row changes, protected tables);
//   - one DRAFT template per community (13, as production), seeded with the counsel questions;
//     no community's homeowner fee is on (collection_fee_autopost defaults false);
//   - the database enforces the notice controls: cure period >= 45 days, deadline = notice +
//     cure (the Vantaca 2025-deadline error cannot be stored), amount due = ledger + fee,
//     mailed only with a tracking number on the notice date, one open notice per account,
//     a tracking number used once, one approved template per community;
//   - fee idempotency keys: one homeowner fee row, one GL entry, one Bedrock billing item per
//     notice; billing_pending_items accepts source 'collection_notice' and still the old ones;
//   - drift blocks it (templates table already present stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite. --print-objects prints the catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  515 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '515_collection_notices.sql';
const PRINT = process.argv.includes('--print-objects');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm515-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const realChecks = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
const checks = PRINT ? { ...realChecks, objects: { added: [], changed: [], removed: [] } } : realChecks;
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(checks, null, 2));

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const COMMS = Array.from({ length: 13 }, (_, i) => id(100 + i));   // production has 13 communities
const C1 = COMMS[0], P1 = id(201), T1 = id(301);

async function buildWorld({ preTable = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text NOT NULL, legal_name text, hoa_legal_name text, management_company_id uuid,
      certified_collection_fee_cents integer NOT NULL DEFAULT 0, certified_fee_autopost boolean NOT NULL DEFAULT false);
    CREATE TABLE properties (id uuid PRIMARY KEY, community_id uuid REFERENCES communities(id));
    CREATE TABLE ownership_tenures (id uuid PRIMARY KEY, community_id uuid, property_id uuid, kind text);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, status text, source_module text, source_reference text);
    CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid REFERENCES journal_entries(id), account_id uuid, debit_cents bigint DEFAULT 0, credit_cents bigint DEFAULT 0);
    CREATE TABLE transaction_upload_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, status text);
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_batch_id uuid REFERENCES transaction_upload_batches(id), community_id uuid,
      property_id uuid, tenure_id uuid, amount_cents bigint, raw_row_jsonb jsonb);
    CREATE TABLE invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE billing_pending_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid NOT NULL, community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
      category text, description text NOT NULL, qty numeric(12,2) NOT NULL DEFAULT 1, unit_price numeric(12,4) NOT NULL DEFAULT 0, amount numeric(12,2) NOT NULL DEFAULT 0,
      source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','email')), source_ref text, submitted_by text, note text,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','billed','dismissed')), invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL, billed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('296_billing_pending_items.sql', 'recorded'), ('394_certified_letter_fee_autopost.sql', 'recorded'),
      ('195_homeowner_transactions.sql', 'recorded'), ('457_current_tenure_reader_views.sql', 'recorded');
  `);
  for (const [i, c] of COMMS.entries()) await db.exec(`INSERT INTO communities (id, name, management_company_id) VALUES ('${c}', 'Community ${i + 1}', '${id(1)}');`);
  await db.exec(`INSERT INTO properties VALUES ('${P1}', '${C1}'); INSERT INTO ownership_tenures VALUES ('${T1}', '${C1}', '${P1}', 'owner');
    INSERT INTO billing_pending_items (management_company_id, community_id, description, source) VALUES ('${id(1)}', '${C1}', 'existing manual item', 'manual');`);
  if (preTable) await db.exec(`CREATE TABLE collection_notice_templates (id uuid PRIMARY KEY);`);
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  return { db, client };
}

const OWNER = { id: 'owner-uuid', email: 'owner@example.test' };
const ctx = (client) => ({ client, user: OWNER, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' });
const { db, client } = await buildWorld();
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };
const plan = await A.planMigration({ ...ctx(client), filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx(client), planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, row_changes: r.detail && r.detail.row_changes, written: r.detail && r.detail.tables_written, error: r.error }, null, 2)); process.exit(0); }
check('apply: 515 applied and verified through the tool (objects, row changes, protected tables, verify)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));

if (r.status === 'applied') {
  check('one DRAFT template per community (13), with the five counsel questions and seven required elements',
    (await q1(`SELECT count(*)::int n FROM collection_notice_templates WHERE status = 'draft' AND counsel_status = 'questions_open' AND jsonb_array_length(counsel_questions) = 5 AND jsonb_array_length(required_elements) = 7`)).n === 13);
  check('no homeowner fee is on anywhere (collection_fee_autopost false)', (await q1(`SELECT count(*)::int n FROM communities WHERE collection_fee_autopost`)).n === 0);
  const tpl = (await q1(`SELECT id FROM collection_notice_templates WHERE community_id = '${C1}'`)).id;
  check('rule: a template cure period under 45 days is refused', /cure_days_check/.test(await tryErr(`UPDATE collection_notice_templates SET cure_days = 30 WHERE id = '${tpl}'`) || ''));
  await db.query(`UPDATE collection_notice_templates SET status = 'approved' WHERE id = '${tpl}'`);
  check('rule: one approved template per community', /uq_collection_template_approved|duplicate key/.test(await tryErr(`INSERT INTO collection_notice_templates (community_id, version, name, paragraphs, required_elements, status) VALUES ('${C1}', 2, 'x', '[]', '[]', 'approved')`) || ''));
  const batch = (await q1(`INSERT INTO collection_notice_batches (community_id, notice_date, template_id, prepared_by) VALUES ('${C1}', '2026-10-13', '${tpl}', 'Amanda (AI)') RETURNING id`)).id;
  const notice = (o = {}) => `INSERT INTO collection_notices (batch_id, community_id, property_id, tenure_id, notice_date, deadline_date, cure_days, ledger_balance_cents, fee_cents, amount_due_cents,
      statement_snapshot, snapshot_sha256, snapshot_as_of, template_id, template_version, status, certified_tracking_number, mailed_date)
    VALUES ('${batch}', '${C1}', '${P1}', '${T1}', '${o.notice || '2026-10-13'}', '${o.deadline || '2026-11-27'}', ${o.cure || 45}, 38302, ${o.fee ?? 2500}, ${o.due ?? 40802},
      '{}', 'h', now(), '${tpl}', 1, '${o.status || 'draft'}', ${o.trk ? `'${o.trk}'` : 'NULL'}, ${o.mailed ? `'${o.mailed}'` : 'NULL'}) RETURNING id`;
  check('rule: the Vantaca error (2026 notice with a 2025 deadline) cannot be stored', /collection_notices_check/.test(await tryErr(notice({ deadline: '2025-10-16' })) || ''));
  check('rule: a cure period under 45 days cannot be stored', /cure_days_check|collection_notices_check/.test(await tryErr(notice({ cure: 30, deadline: '2026-11-12' })) || ''));
  check('rule: amount due must equal ledger + fee', /collection_notices_check/.test(await tryErr(notice({ due: 41453 })) || ''));
  check('rule: mailed needs a tracking number and the notice date', /collection_notices_check/.test(await tryErr(notice({ status: 'mailed', trk: '9407111899223197428490', mailed: '2026-10-14' })) || '')
    && /collection_notices_check/.test(await tryErr(notice({ status: 'mailed', mailed: '2026-10-13' })) || ''));
  const n1 = (await q1(notice())).id;
  check('a consistent notice is accepted', !!n1);
  check('rule: one open notice per account', /uq_collection_notice_open|duplicate key/.test(await tryErr(notice()) || ''));
  await db.query(`UPDATE collection_notices SET status = 'mailed', certified_tracking_number = '9407111899223197428490', mailed_date = '2026-10-13' WHERE id = '${n1}'`);
  check('rule: a tracking number is used once', /uq_collection_notice_tracking|duplicate key/.test(await tryErr(notice({ status: 'mailed', trk: '9407111899223197428490', mailed: '2026-10-13' })) || ''));
  const b1 = (await q1(`INSERT INTO transaction_upload_batches (community_id, status) VALUES ('${C1}', 'committed') RETURNING id`)).id;
  await db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, property_id, tenure_id, amount_cents, raw_row_jsonb) VALUES ('${b1}', '${C1}', '${P1}', '${T1}', 2500, '{"source":"collection_notice_fee","collection_notice_id":"${n1}"}')`);
  check('idempotency: a second homeowner fee row for the same notice is refused', /uq_homeowner_txn_collection_notice_fee|duplicate key/.test(await tryErr(`INSERT INTO homeowner_transactions (source_batch_id, community_id, amount_cents, raw_row_jsonb) VALUES ('${b1}', '${C1}', 2500, '{"source":"collection_notice_fee","collection_notice_id":"${n1}"}')`) || ''));
  await db.query(`INSERT INTO journal_entries (community_id, status, source_reference) VALUES ('${C1}', 'posted', 'collnotice:${n1}')`);
  check('idempotency: a second GL entry for the same notice is refused', /uq_journal_entries_collection_notice|duplicate key/.test(await tryErr(`INSERT INTO journal_entries (community_id, status, source_reference) VALUES ('${C1}', 'posted', 'collnotice:${n1}')`) || ''));
  await db.query(`INSERT INTO billing_pending_items (management_company_id, community_id, description, source, source_ref, amount) VALUES ('${id(1)}', '${C1}', 'letter', 'collection_notice', 'collection_notice:${n1}', 50)`);
  check('idempotency: a second Bedrock billing item for the same notice is refused; manual and email items still allowed',
    /uq_billing_pending_collection_notice|duplicate key/.test(await tryErr(`INSERT INTO billing_pending_items (management_company_id, community_id, description, source, source_ref) VALUES ('${id(1)}', '${C1}', 'again', 'collection_notice', 'collection_notice:${n1}')`) || '')
    && (await tryErr(`INSERT INTO billing_pending_items (management_company_id, community_id, description, source) VALUES ('${id(1)}', '${C1}', 'm', 'email')`)) === null
    && /billing_pending_items_source_check/.test(await tryErr(`INSERT INTO billing_pending_items (management_company_id, community_id, description, source) VALUES ('${id(1)}', '${C1}', 'x', 'bogus')`) || ''));
  check('service_role can write the notices; anon cannot read them', (await q1(`SELECT (has_table_privilege('service_role', 'collection_notices', 'INSERT') AND NOT has_table_privilege('anon', 'collection_notices', 'SELECT'))::int ok`)).ok === 1);
}

const drift = await buildWorld({ preTable: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing collection_notice_templates table BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
