// tests/sql/514_apply_one_e2e.mjs — migration 514 (homeowner check receipts) applied END TO
// END through the single-migration tool with its REAL checks file. Proves:
//   - the checks file matches exactly what 514 does (objects, row changes, protected tables);
//   - 1020 Undeposited Funds is added only where a community has Operating Cash and no
//     undeposited account; an existing one (August Meadows) is reused; every role is set;
//   - the same image / the same MICR check cannot be recorded twice; a returned check may
//     be re-presented;
//   - post_check_receipt_payment: dry run, 209.0063 application, unapplied credit, draft
//     batch until the GL entry posts, idempotent on the receipt, post-dated checks refused;
//   - check_receipt_commit_posting requires the receipt's own posted GL entry;
//   - a recorded receipt must carry its ledger row and GL entry (table CHECK);
//   - drift blocks it (receipts table already present stops the plan).
// Postgres 17 (PGlite 0.3.x). Skips without PGlite. --print-objects prints the catalog diff.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  514 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '514_homeowner_check_receipts.sql';
const PRINT = process.argv.includes('--print-objects');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm514-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const realChecks = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`) || '{}');
const checks = PRINT ? { ...realChecks, objects: { added: [], changed: [], removed: [] } } : realChecks;
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(checks, null, 2));

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C = [1, 2, 3, 4, 5, 6, 7].map((n) => id(100 + n));   // seven communities with Operating Cash (as production)
const AM = id(108);                                          // August Meadows: an existing 1020 Undeposited Funds, no 1000
const P1 = id(201), T1 = id(301), K1 = id(401), MC = id(1);

async function buildWorld({ preTable = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communities (id uuid PRIMARY KEY, name text NOT NULL, management_company_id uuid);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), fund_id uuid,
      account_number text NOT NULL, account_name text NOT NULL, account_type text NOT NULL, account_subtype text, normal_balance text NOT NULL,
      is_summary boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, description text, UNIQUE (community_id, account_number));
    CREATE TABLE community_account_roles (
      community_id uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
      role text NOT NULL CHECK (role IN ('operating_cash', 'stripe_clearing', 'homeowner_ar')),
      account_id uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
      updated_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (community_id, role));
    CREATE OR REPLACE FUNCTION community_account_roles_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
    DECLARE a chart_of_accounts%ROWTYPE;
    BEGIN
      SELECT * INTO a FROM chart_of_accounts WHERE id = NEW.account_id;
      IF NOT FOUND OR a.community_id <> NEW.community_id THEN RAISE EXCEPTION 'account % is not in community %', NEW.account_id, NEW.community_id; END IF;
      IF a.is_summary OR NOT a.is_active THEN RAISE EXCEPTION 'account % must be active and postable for role %', a.account_number, NEW.role; END IF;
      IF a.account_type <> 'asset' OR a.normal_balance <> 'debit' THEN RAISE EXCEPTION 'role % needs a debit-normal asset account', NEW.role; END IF;
      NEW.updated_at := now(); RETURN NEW;
    END $$;
    CREATE TRIGGER trg_community_account_roles_guard BEFORE INSERT OR UPDATE ON community_account_roles FOR EACH ROW EXECUTE FUNCTION community_account_roles_guard();
    CREATE TABLE library_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, status text, source_module text, source_reference text);
    CREATE TABLE journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid REFERENCES journal_entries(id), account_id uuid, debit_cents bigint DEFAULT 0, credit_cents bigint DEFAULT 0);
    CREATE TABLE bank_statement_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount_cents bigint);
    CREATE TABLE properties (id uuid PRIMARY KEY, community_id uuid, trusted_account_number text, vantaca_account_id text);
    CREATE TABLE ownership_tenures (id uuid PRIMARY KEY, community_id uuid, property_id uuid, kind text, vantaca_account_id text, end_date date);
    CREATE TABLE property_ownerships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenure_id uuid, contact_id uuid, is_primary boolean DEFAULT true, start_date date DEFAULT '2020-01-01');
    CREATE TABLE transaction_upload_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid, community_id uuid, period_label text, as_of_date date,
      source_format text, status text, row_count int, account_count int, total_charges_cents bigint, total_payments_cents bigint, min_transaction_date date, max_transaction_date date,
      uploaded_by text, notes text, committed_at timestamptz);
    CREATE TABLE homeowner_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_batch_id uuid REFERENCES transaction_upload_batches(id), source_row_index int, community_id uuid,
      vantaca_account_id text, trusted_account_number text, property_id uuid, contact_id uuid, tenure_id uuid, transaction_date date, description text, txn_type text, charge_category text,
      amount_cents bigint, reduction_source text, raw_row_jsonb jsonb, reverses_txn_id uuid);
    CREATE TABLE homeowner_txn_applications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, tenure_id uuid, payment_txn_id uuid, charge_txn_id uuid, applied_cents bigint,
      priority_step smallint, priority_basis text, applied_as_of date, method text, run_id uuid, approved_by text);
    CREATE OR REPLACE FUNCTION payment_application_step(p_category text, p_charge_date date, p_payment_date date) RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN p_category = 'assessment' AND p_charge_date <= p_payment_date THEN 1 WHEN p_category = 'assessment' THEN 2 WHEN p_category = 'attorney_fee' THEN 3
                  WHEN p_category = 'attorney_fee_other' THEN 4 WHEN p_category = 'fine' THEN 5
                  WHEN p_category IN ('interest', 'late_fee', 'admin_fee', 'nsf_fee', 'certified_letter', 'other', 'adjustment') THEN 6 END::smallint; $$;
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO schema_migrations (filename, sha256) VALUES ('469_payments_safe_foundation.sql', 'recorded'), ('461_homeowner_payment_applications.sql', 'recorded'),
      ('195_homeowner_transactions.sql', 'recorded'), ('169_bank_reconciliation.sql', 'recorded'), ('012_documents_module.sql', 'recorded');
  `);
  for (const [i, c] of C.entries()) {
    await db.exec(`INSERT INTO communities VALUES ('${c}', 'Community ${i + 1}', '${MC}');
      INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance) VALUES ('${c}', '1000', 'Operating Cash Account', 'asset', 'debit'), ('${c}', '1300', 'Accounts Receivable', 'asset', 'debit');
      INSERT INTO community_account_roles (community_id, role, account_id, updated_by) SELECT '${c}', 'operating_cash', id, 'm469' FROM chart_of_accounts WHERE community_id = '${c}' AND account_number = '1000';
      INSERT INTO community_account_roles (community_id, role, account_id, updated_by) SELECT '${c}', 'homeowner_ar', id, 'm469' FROM chart_of_accounts WHERE community_id = '${c}' AND account_number = '1300';`);
  }
  await db.exec(`INSERT INTO communities VALUES ('${AM}', 'August Meadows', '${MC}');
    INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance) VALUES ('${AM}', '1020', 'Undeposited Funds', 'asset', 'debit');
    INSERT INTO communities VALUES ('${id(109)}', 'No chart yet', '${MC}');
    INSERT INTO properties VALUES ('${P1}', '${C[0]}', '1005000001', '10311612');
    INSERT INTO ownership_tenures VALUES ('${T1}', '${C[0]}', '${P1}', 'owner', '10311612', NULL);
    INSERT INTO property_ownerships (tenure_id, contact_id) VALUES ('${T1}', '${K1}');
    INSERT INTO transaction_upload_batches (id, community_id, status, source_format) VALUES ('${id(501)}', '${C[0]}', 'committed', 'manual');
    INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents)
      VALUES ('${id(501)}', 1, '${C[0]}', '${P1}', '${T1}', '2026-01-01', 'Annual Assessment', 'charge', 'assessment', 26000),
             ('${id(501)}', 2, '${C[0]}', '${P1}', '${T1}', '2026-02-01', 'Late Fees', 'charge', 'late_fee', 1000);`);
  if (preTable) await db.exec(`CREATE TABLE homeowner_check_receipts (id uuid PRIMARY KEY);`);
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
check('apply: 514 applied and verified through the tool (objects, row changes, protected tables, verify)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error }).slice(0, 2000));

if (r.status === 'applied') {
  check('1020 Undeposited Funds added to the seven communities with Operating Cash, not to August Meadows (has one) or a community with no chart',
    (await q1(`SELECT count(*)::int n FROM chart_of_accounts WHERE account_number = '1020' AND description LIKE '%(mig 514)%'`)).n === 7
    && (await q1(`SELECT count(*)::int n FROM chart_of_accounts WHERE community_id = '${AM}'`)).n === 1);
  check('every community with an Undeposited Funds account has the undeposited_funds role (8), each pointing at it',
    (await q1(`SELECT count(*)::int n FROM community_account_roles r JOIN chart_of_accounts a ON a.id = r.account_id WHERE r.role = 'undeposited_funds' AND a.account_name ILIKE '%undeposited%'`)).n === 8);
  // receipts
  const doc = (await q1(`INSERT INTO library_documents DEFAULT VALUES RETURNING id`)).id;
  const ins = (o) => db.query(`INSERT INTO homeowner_check_receipts (community_id, scan_batch_id, status, front_document_id, front_sha256, check_number, amount_cents, check_date, received_date, payer_name, micr_fingerprint, property_id, tenure_id, created_by)
    VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, 'Ramiro Ruiz', $9, $10, $11, 'e2e') RETURNING id`, [C[0], o.status || 'matched', doc, o.sha, o.num || '1042', o.amt || 30000, o.date || '2026-10-09', o.recv || '2026-10-10', o.micr || null, P1, T1]);
  const rc = (await ins({ sha: 'img-a', micr: 'micr-a' })).rows[0].id;
  check('duplicate: the same front image cannot be a second receipt', /uq_check_receipt_front_image|duplicate key/.test(await tryErr(`INSERT INTO homeowner_check_receipts (community_id, scan_batch_id, front_sha256, created_by) VALUES ('${C[0]}', gen_random_uuid(), 'img-a', 'e2e')`) || ''));
  check('duplicate: the same check (MICR fingerprint) cannot be a second receipt', /uq_check_receipt_micr|duplicate key/.test(await tryErr(`INSERT INTO homeowner_check_receipts (community_id, scan_batch_id, front_sha256, micr_fingerprint, created_by) VALUES ('${C[0]}', gen_random_uuid(), 'img-b', 'micr-a', 'e2e')`) || ''));
  check('rule: a recorded receipt must carry its ledger row and GL entry', /homeowner_check_receipts_check/.test(await tryErr(`UPDATE homeowner_check_receipts SET status = 'recorded' WHERE id = '${rc}'`) || ''));
  const dry = (await q1(`SELECT post_check_receipt_payment('${rc}', 'staff', true) j`)).j;
  check('dry run: 209.0063 order (assessment first), $300 check = $270 applied + $30 unapplied credit', dry.dry_run === true && dry.applied_cents === 27000 && dry.unapplied_cents === 3000 && dry.applications[0].category === 'assessment', JSON.stringify(dry));
  check('dry run writes nothing', (await q1(`SELECT count(*)::int n FROM transaction_upload_batches`)).n === 1);
  const post = (await q1(`SELECT post_check_receipt_payment('${rc}', 'staff', false) j`)).j;
  const batch = await q1(`SELECT status FROM transaction_upload_batches WHERE id = '${post.batch_id}'`);
  const row = await q1(`SELECT amount_cents, transaction_date::text d, raw_row_jsonb->>'source' src FROM homeowner_transactions WHERE id = '${post.payment_txn_id}'`);
  check('post: one payment row dated the RECEIVED date, in a DRAFT batch, with two applications', batch.status === 'draft' && row.amount_cents == -30000 && row.d === '2026-10-10' && row.src === 'check_receipt'
    && (await q1(`SELECT count(*)::int n FROM homeowner_txn_applications WHERE payment_txn_id = '${post.payment_txn_id}'`)).n === 2, JSON.stringify({ batch, row }));
  const again = (await q1(`SELECT post_check_receipt_payment('${rc}', 'staff', false) j`)).j;
  check('idempotent: a second post returns the same draft, writes nothing', again.already_posted === true && again.payment_txn_id === post.payment_txn_id && (await q1(`SELECT count(*)::int n FROM homeowner_transactions WHERE raw_row_jsonb->>'source' = 'check_receipt'`)).n === 1);
  check('commit refuses a GL entry that is not this receipt\'s', /not this receipt/.test(await tryErr(`SELECT check_receipt_commit_posting('${rc}', '${id(999)}', 'staff')`) || ''));
  const je = (await q1(`INSERT INTO journal_entries (community_id, status, source_module, source_reference) VALUES ('${C[0]}', 'posted', 'payment_intake', 'checkrcpt:${rc}') RETURNING id`)).id;
  await db.query(`SELECT check_receipt_commit_posting('${rc}', '${je}', 'staff')`);
  const done = await q1(`SELECT r.status, b.status bs FROM homeowner_check_receipts r JOIN transaction_upload_batches b ON b.id = r.ledger_batch_id WHERE r.id = '${rc}'`);
  check('commit: the batch becomes visible (committed) and the receipt is recorded with its ledger row and GL entry', done.status === 'recorded' && done.bs === 'committed', JSON.stringify(done));
  check('one GL entry per receipt: a second checkrcpt entry is refused', /uq_journal_entries_check_refs|duplicate key/.test(await tryErr(`INSERT INTO journal_entries (community_id, status, source_reference) VALUES ('${C[0]}', 'posted', 'checkrcpt:${rc}')`) || ''));
  const pd = (await ins({ sha: 'img-c', micr: 'micr-c', num: '2001', date: '2026-10-20', recv: '2026-10-10' })).rows[0].id;
  check('a post-dated check is refused', /post-dated/.test(await tryErr(`SELECT post_check_receipt_payment('${pd}', 'staff', true)`) || ''));
  await db.query(`UPDATE homeowner_check_receipts SET status = 'returned' WHERE id = '${rc}'`);
  check('a RETURNED check may be re-presented (new receipt, same MICR)', (await tryErr(`INSERT INTO homeowner_check_receipts (community_id, scan_batch_id, front_sha256, micr_fingerprint, created_by) VALUES ('${C[0]}', gen_random_uuid(), 'img-d', 'micr-a', 'e2e')`)) === null);
  check('service_role can write, anon cannot read', (await q1(`SELECT has_table_privilege('service_role', 'homeowner_check_receipts', 'INSERT') a, has_table_privilege('anon', 'homeowner_check_receipts', 'SELECT') b`)).a === true
    && (await q1(`SELECT has_table_privilege('anon', 'homeowner_check_receipts', 'SELECT') b`)).b === false);
}

const drift = await buildWorld({ preTable: true });
const plan2 = await A.planMigration({ ...ctx(drift.client), filename: F });
check('drift: an existing homeowner_check_receipts table BLOCKS the plan (preflight), no token', plan2.status !== 'ready' && !plan2.plan_token, JSON.stringify({ status: plan2.status }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
