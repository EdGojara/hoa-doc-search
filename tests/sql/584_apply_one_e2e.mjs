// tests/sql/584_apply_one_e2e.mjs — migration 584 (split check allocations) applied END TO END
// through the single-migration tool with its REAL checks file, on top of the REAL 514. Proves:
//   - the checks file matches what 584 does (objects, row changes, protected tables);
//   - a closing check splits between the seller's (ended) and buyer's accounts; the lines must
//     total the check; a held line needs no account; an unknown funding party cannot be an owner line;
//   - post_check_receipt_split: one payment row per owner account, each applied in the 209.0063
//     order to that account only, excess stays on that account; draft until the GL entry posts;
//     idempotent; the commit records the receipt and every line;
//   - a single-account check still posts and commits exactly as before (514 path);
//   - the authorization request lists the check with the allocation fingerprint, refuses an
//     unbalanced allocation, and the fingerprint changes when a line changes.
// Postgres 17 (PGlite 0.3.x). Skips without PGlite.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  584 end-to-end apply rehearsal (@electric-sql/pglite not installed)'); process.exit(0); }
const require = createRequire(import.meta.url);
const A = require(`${REPO}/lib/migrations/apply_one.js`);
const F = '584_check_receipt_allocations.sql';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm584-e2e-'));
fs.mkdirSync(path.join(dir, 'checks'));
fs.writeFileSync(path.join(dir, F), lf(`${REPO}/migrations/${F}`));
const PRINT = process.argv.includes('--print-objects');
const realChecks = JSON.parse(lf(`${REPO}/migrations/checks/${F.replace('.sql', '.json')}`));
fs.writeFileSync(path.join(dir, 'checks', F.replace('.sql', '.json')), JSON.stringify(PRINT ? { ...realChecks, objects: { added: [], changed: [], removed: [] } } : realChecks, null, 2));

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const C = id(101), MC = id(1), P = id(201), P2 = id(202), SELLER = id(301), BUYER = id(302), T2 = id(303), K1 = id(401), K2 = id(402);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE communities (id uuid PRIMARY KEY, name text NOT NULL, management_company_id uuid);
  CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), fund_id uuid,
    account_number text NOT NULL, account_name text NOT NULL, account_type text NOT NULL, account_subtype text, normal_balance text NOT NULL,
    is_summary boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true, description text, UNIQUE (community_id, account_number));
  CREATE TABLE community_account_roles (community_id uuid NOT NULL REFERENCES communities(id), role text NOT NULL CHECK (role IN ('operating_cash', 'stripe_clearing', 'homeowner_ar')),
    account_id uuid NOT NULL REFERENCES chart_of_accounts(id), updated_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (community_id, role));
  CREATE TABLE library_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid, status text, source_module text, source_reference text);
  CREATE TABLE bank_statement_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount_cents bigint);
  CREATE TABLE properties (id uuid PRIMARY KEY, community_id uuid, trusted_account_number text, vantaca_account_id text);
  CREATE TABLE ownership_tenures (id uuid PRIMARY KEY, community_id uuid, property_id uuid, kind text, vantaca_account_id text, start_date date, end_date date);
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
  CREATE OR REPLACE FUNCTION conversion_sha256_jsonb(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(p::text, 'UTF8')), 'hex') $$;
  CREATE TABLE owner_authorizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL, subject text, summary text, items jsonb, items_sha256 text, owner_email text,
    requested_by text, requested_at timestamptz DEFAULT now(), expires_at timestamptz, coordinator text, sensitivity_tier int, status text NOT NULL DEFAULT 'requested',
    CONSTRAINT owner_authorizations_scope_check CHECK (scope IN ('conversion_objects', 'accounting_runs', 'arc_acc_decisions', 'closing_packages')));
  CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
  INSERT INTO communities VALUES ('${C}', 'Example HOA', '${MC}');
  INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance) VALUES ('${C}', '1000', 'Operating Cash Account', 'asset', 'debit'), ('${C}', '1300', 'Accounts Receivable', 'asset', 'debit');
`);
await db.exec(lf(`${REPO}/migrations/514_homeowner_check_receipts.sql`));
await db.exec(`
  INSERT INTO schema_migrations (filename, sha256) VALUES ('514_homeowner_check_receipts.sql', 'recorded'), ('524_unidentified_receipts_account.sql', 'recorded'), ('583_owner_authorized_closing_package.sql', 'recorded');
  -- a lot sold: the builder's account (ended) and the buyer's (current); and a second lot
  INSERT INTO properties VALUES ('${P}', '${C}', '1005000001', 'A1'), ('${P2}', '${C}', '1005000002', 'A2');
  INSERT INTO ownership_tenures VALUES ('${SELLER}', '${C}', '${P}', 'owner', 'A1', '2025-12-08', '2026-09-21'), ('${BUYER}', '${C}', '${P}', 'owner', 'A1b', '2026-09-22', NULL), ('${T2}', '${C}', '${P2}', 'owner', 'A2', '2020-01-01', NULL);
  INSERT INTO property_ownerships (tenure_id, contact_id) VALUES ('${SELLER}', '${K1}'), ('${BUYER}', '${K2}'), ('${T2}', '${K2}');
  INSERT INTO transaction_upload_batches (id, community_id, status, source_format) VALUES ('${id(501)}', '${C}', 'committed', 'manual');
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents) VALUES
    ('${id(501)}', 1, '${C}', '${P}', '${SELLER}', '2026-07-31', 'Builder assessment', 'charge', 'assessment', 14375),
    ('${id(501)}', 2, '${C}', '${P}', '${SELLER}', '2026-09-21', 'Builder days', 'charge', 'assessment', 3526),
    ('${id(501)}', 3, '${C}', '${P}', '${BUYER}', '2026-09-22', 'Buyer share', 'charge', 'assessment', 13697),
    ('${id(501)}', 4, '${C}', '${P}', '${BUYER}', '2026-09-22', 'Capitalization fee', 'charge', 'other', 49500),
    ('${id(501)}', 5, '${C}', '${P2}', '${T2}', '2026-01-01', 'Annual Assessment', 'charge', 'assessment', 26000);
`);
const client = { query: async (sql, params) => {
  if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
  const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
} };
const ctx = { client, user: { id: 'owner-uuid', email: 'owner@example.test' }, deployedCommit: 'deadbeefcafe', migrationsDir: dir, secret: 'e2e' };
const q1 = async (sql, params) => (await db.query(sql, params)).rows[0];
const tryErr = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

const plan = await A.planMigration({ ...ctx, filename: F });
check('plan: ready, every preflight passes', plan.status === 'ready' && plan.preflight.every((p) => p.ok), JSON.stringify({ status: plan.status, reason: plan.reason, preflight: plan.preflight }).slice(0, 1500));
const r = await A.applyMigration({ ...ctx, planToken: plan.plan_token, log: { error() {} } });
if (PRINT) { console.log(JSON.stringify({ status: r.status, objects: r.detail && r.detail.objects, error: r.error }, null, 2)); process.exit(0); }
check('apply: 584 applied and verified through the tool (objects, row changes, protected tables, verify)', r.status === 'applied', JSON.stringify({ status: r.status, error: r.error, detail: r.detail && r.detail.objects }).slice(0, 2500));

if (r.status === 'applied') {
  const doc = (await q1(`INSERT INTO library_documents DEFAULT VALUES RETURNING id`)).id;
  const rcpt = async (o) => (await q1(`INSERT INTO homeowner_check_receipts (community_id, scan_batch_id, status, front_document_id, front_sha256, check_number, amount_cents, check_date, received_date, payer_name, property_id, tenure_id, created_by)
    VALUES ($1, gen_random_uuid(), 'matched', $2, $3, $4, $5, '2026-09-22', '2026-11-28', 'Example Title', $6, $7, 'e2e') RETURNING id`, [C, doc, o.sha, o.num, o.amt, o.prop || null, o.ten || null])).id;
  const rc = await rcpt({ sha: 'img-split', num: '7001', amt: 99000 });
  const L = (o) => ({ kind: 'owner_account', property_id: P, funding_party: 'seller', purpose: 'assessment', basis: 'Settlement statement, seller column', ...o });
  const lines = [L({ tenure_id: SELLER, amount_cents: 27000 }), L({ tenure_id: BUYER, funding_party: 'buyer', amount_cents: 22500, basis: 'Settlement statement, buyer column' }),
    L({ tenure_id: BUYER, funding_party: 'seller', purpose: 'capitalization_fee', amount_cents: 49500, basis: 'Working capital paid by seller for the buyer' })];
  const setErr = (ls) => tryErr(`SELECT check_receipt_set_allocations($1, $2::jsonb, 'kat')`, [rc, JSON.stringify(ls)]);
  check('refused: lines that do not total the check', /total/.test(await setErr([lines[0], { ...lines[1], amount_cents: 1 }]) || ''));
  check('refused: an owner account of another lot', /does not belong/.test(await setErr([L({ tenure_id: T2, amount_cents: 49500 }), L({ tenure_id: BUYER, amount_cents: 49500 })]) || ''));
  check('refused: an unknown funding party on an owner account (table rule)', /check/i.test(await setErr([L({ tenure_id: SELLER, funding_party: 'unknown', amount_cents: 49500 }), L({ tenure_id: BUYER, amount_cents: 49500 })]) || ''));
  check('refused: a held-only allocation (at least one owner account)', /at least one line/.test(await setErr([{ kind: 'held', funding_party: 'unknown', purpose: 'held', amount_cents: 49500, basis: 'Not established on the statement' }, { kind: 'held', funding_party: 'unknown', purpose: 'held', amount_cents: 49500, basis: 'Not established on the statement' }]) || ''));
  const set = (await q1(`SELECT check_receipt_set_allocations($1, $2::jsonb, 'kat') j`, [rc, JSON.stringify(lines)])).j;
  check('set: three lines totalling the check, fingerprint returned, receipt carries the first owner line', set.lines === 3 && set.total_cents == 99000 && /^[0-9a-f]{64}$/.test(set.allocation_sha256)
    && (await q1(`SELECT tenure_id::text t FROM homeowner_check_receipts WHERE id = $1`, [rc])).t === SELLER, JSON.stringify(set));
  const dry = (await q1(`SELECT post_check_receipt_split($1, 'kat', true) j`, [rc])).j;
  const seller = dry.accounts.find((a) => a.tenure_id === SELLER); const buyer = dry.accounts.find((a) => a.tenure_id === BUYER);
  check('dry run: seller $270.00 applies $179.01, $90.99 stays on the SELLER account', seller.amount_cents == 27000 && seller.applied_cents == 17901 && seller.unapplied_cents == 9099, JSON.stringify(seller));
  check('dry run: buyer $720.00 applies $631.97 (assessment before the fee), $88.03 stays on the BUYER account', buyer.amount_cents == 72000 && buyer.applied_cents == 63197 && buyer.unapplied_cents == 8803 && buyer.applications[0].category === 'assessment', JSON.stringify(buyer));
  check('dry run writes nothing', (await q1(`SELECT count(*)::int n FROM transaction_upload_batches`)).n === 1);
  const post = (await q1(`SELECT post_check_receipt_split($1, 'kat', false) j`, [rc])).j;
  const rows = (await db.query(`SELECT tenure_id::text t, amount_cents::int a, transaction_date::text d FROM homeowner_transactions WHERE raw_row_jsonb->>'source' = 'check_receipt_allocation' ORDER BY source_row_index`)).rows;
  check('post: one payment row per owner account (seller -270.00, buyer -720.00) dated the received date, draft batch', rows.length === 2 && rows[0].t === SELLER && rows[0].a === -27000 && rows[1].t === BUYER && rows[1].a === -72000 && rows[0].d === '2026-11-28'
    && (await q1(`SELECT status FROM transaction_upload_batches WHERE id = $1`, [post.batch_id])).status === 'draft', JSON.stringify(rows));
  check('applications stay inside each account (none of the seller money reaches a buyer charge)',
    (await q1(`SELECT count(*)::int n FROM homeowner_txn_applications ap JOIN homeowner_transactions c ON c.id = ap.charge_txn_id WHERE ap.tenure_id <> c.tenure_id`)).n === 0
    && (await q1(`SELECT sum(applied_cents)::int s FROM homeowner_txn_applications WHERE tenure_id = $1`, [SELLER])).s === 17901);
  check('idempotent: a second post writes nothing', (await q1(`SELECT post_check_receipt_split($1, 'kat', false) j`, [rc])).j.already_posted === true
    && (await q1(`SELECT count(*)::int n FROM homeowner_transactions WHERE raw_row_jsonb->>'source' = 'check_receipt_allocation'`)).n === 2);
  const je = (await q1(`INSERT INTO journal_entries (community_id, status, source_module, source_reference) VALUES ($1, 'posted', 'payment_intake', $2) RETURNING id`, [C, `checkrcpt:${rc}`])).id;
  await db.query(`SELECT check_receipt_commit_posting($1, $2, 'kat')`, [rc, je]);
  const done = await q1(`SELECT r.status, b.status bs, (SELECT count(*)::int FROM homeowner_check_receipt_allocations a WHERE a.receipt_id = r.id AND a.status = 'recorded' AND a.homeowner_txn_id IS NOT NULL) n FROM homeowner_check_receipts r JOIN transaction_upload_batches b ON b.id = r.ledger_batch_id WHERE r.id = $1`, [rc]);
  check('commit: receipt recorded, batch committed, every line recorded with its ledger row', done.status === 'recorded' && done.bs === 'committed' && done.n === 3, JSON.stringify(done));
  check('a recorded receipt\'s allocation can no longer change', /can no longer change/.test(await setErr(lines) || ''));

  // held line
  const rh = await rcpt({ sha: 'img-held', num: '7002', amt: 50000 });
  await db.query(`SELECT check_receipt_set_allocations($1, $2::jsonb, 'kat')`, [rh, JSON.stringify([L({ tenure_id: BUYER, funding_party: 'buyer', amount_cents: 30000 }), { kind: 'held', funding_party: 'unknown', purpose: 'held', amount_cents: 20000, basis: 'Funding party not shown on the statement' }])]);
  const dh = (await q1(`SELECT post_check_receipt_split($1, 'kat', true) j`, [rh])).j;
  check('held: $200 held (no account), $300 applied to the buyer', dh.held_cents == 20000 && dh.accounts.length === 1 && dh.accounts[0].amount_cents == 30000, JSON.stringify(dh));

  // single-account check unchanged
  const rs = await rcpt({ sha: 'img-single', num: '7003', amt: 26000, prop: P2, ten: T2 });
  const ps = (await q1(`SELECT post_check_receipt_payment($1, 'staff', false) j`, [rs])).j;
  const je2 = (await q1(`INSERT INTO journal_entries (community_id, status, source_module, source_reference) VALUES ($1, 'posted', 'payment_intake', $2) RETURNING id`, [C, `checkrcpt:${rs}`])).id;
  await db.query(`SELECT check_receipt_commit_posting($1, $2, 'staff')`, [rs, je2]);
  check('single-account check: posts and commits exactly as before', ps.applied_cents == 26000 && (await q1(`SELECT status, homeowner_txn_id::text h FROM homeowner_check_receipts WHERE id = $1`, [rs])).h === ps.payment_txn_id);

  // authorization request
  const rq = await rcpt({ sha: 'img-req', num: '7004', amt: 40000 });
  await db.query(`SELECT check_receipt_set_allocations($1, $2::jsonb, 'kat')`, [rq, JSON.stringify([L({ tenure_id: SELLER, amount_cents: 10000 }), L({ tenure_id: BUYER, funding_party: 'buyer', amount_cents: 30000 })])]);
  const fp1 = (await q1(`SELECT check_receipt_allocation_sha256($1) f`, [rq])).f;
  const req = (await q1(`SELECT owner_authorization_request_check_allocations('Owner authorization X', 'test', $1::jsonb, 'owner@example.test', 'ai-team:amanda', 72) j`, [JSON.stringify([rq])])).j;
  check('request: one item with the allocation fingerprint, scope check_receipt_allocations', req.items.length === 1 && req.items[0].fingerprint === fp1 && (await q1(`SELECT scope FROM owner_authorizations WHERE id = $1`, [req.id])).scope === 'check_receipt_allocations');
  await db.query(`SELECT check_receipt_set_allocations($1, $2::jsonb, 'kat')`, [rq, JSON.stringify([L({ tenure_id: SELLER, amount_cents: 15000 }), L({ tenure_id: BUYER, funding_party: 'buyer', amount_cents: 25000 })])]);
  check('a changed allocation changes the fingerprint (the executor then refuses it)', (await q1(`SELECT check_receipt_allocation_sha256($1) f`, [rq])).f !== fp1);
  check('request refuses a receipt that is not matched', /not a matched receipt/.test(await tryErr(`SELECT owner_authorization_request_check_allocations('S', 'x', $1::jsonb, 'o@x.test', 'a', 72)`, [JSON.stringify([rc])]) || ''));
  check('service_role can write allocations, anon cannot read them', (await q1(`SELECT has_table_privilege('service_role', 'homeowner_check_receipt_allocations', 'INSERT') a, has_table_privilege('anon', 'homeowner_check_receipt_allocations', 'SELECT') b`)).a === true
    && (await q1(`SELECT has_table_privilege('anon', 'homeowner_check_receipt_allocations', 'SELECT') b`)).b === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
