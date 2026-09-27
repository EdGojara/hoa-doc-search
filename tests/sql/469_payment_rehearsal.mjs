// SQL rehearsal for migration 469 against stub tables that mirror the production
// columns/constraints it touches (including 461's real applications trigger).
// tests/sql/469_payment_rehearsal.mjs — SQL rehearsal for migration 469 against an
// in-memory Postgres (PGlite) with stub tables mirroring the production columns it
// touches, plus migration 461's REAL applications trigger. Skips (exit 0) when
// @electric-sql/pglite is not installed; install it as a dev dependency to run it
// in npm test. Run: node tests/sql/469_payment_rehearsal.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  migration 469 SQL rehearsal (@electric-sql/pglite not installed; set PGLITE_MODULE or add the dev dependency)'); process.exit(0); }
const m461 = fs.readFileSync(`${REPO}/migrations/461_homeowner_payment_applications.sql`, 'utf8');
const m469 = fs.readFileSync(`${REPO}/migrations/469_payments_safe_foundation.sql`, 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error('extract ' + a); return s.slice(i, j + b.length); };

const stub = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE communities (id uuid primary key, management_company_id uuid, gl_cutover_date date);
CREATE TABLE properties (id uuid primary key, community_id uuid, vantaca_account_id text, trusted_account_number text);
CREATE TABLE contacts (id uuid primary key);
CREATE TABLE portal_users (id uuid primary key);
CREATE TABLE ownership_tenures (id uuid primary key, community_id uuid, property_id uuid, kind text, start_date date, end_date date, vantaca_account_id text);
CREATE TABLE property_ownerships (id uuid primary key default gen_random_uuid(), tenure_id uuid, contact_id uuid, is_primary bool, start_date date);
CREATE TABLE transaction_upload_batches (id uuid primary key default gen_random_uuid(), management_company_id uuid, community_id uuid, period_label text, as_of_date date,
  source_format text CHECK (source_format IN ('csv','pdf','manual')), status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed','reverted')),
  row_count int, account_count int, total_charges_cents bigint, total_payments_cents bigint, min_transaction_date date, max_transaction_date date, uploaded_by text, notes text);
CREATE TABLE homeowner_transactions (id uuid primary key default gen_random_uuid(), source_batch_id uuid references transaction_upload_batches(id), source_row_index int,
  community_id uuid, vantaca_account_id text, trusted_account_number text, property_id uuid, contact_id uuid, tenure_id uuid, transaction_date date, description text,
  txn_type text CHECK (txn_type IN ('charge','payment','credit','adjustment','balance_brought_forward')), charge_category text, amount_cents bigint, running_balance_cents bigint,
  reduction_source text CHECK (reduction_source IS NULL OR (reduction_source IN ('cash_payment','prepaid_credit','credit_waiver','correcting_adjustment') AND amount_cents < 0)),
  raw_row_jsonb jsonb);
CREATE TABLE journal_entries (id uuid primary key default gen_random_uuid(), community_id uuid, source_module text, source_reference text, status text default 'posted', total_debits_cents bigint default 0);
CREATE TABLE chart_of_accounts (id uuid primary key default gen_random_uuid(), community_id uuid, fund_id uuid, account_number text, account_name text, account_type text,
  account_subtype text, normal_balance text, is_summary bool, is_active bool, description text);
CREATE TABLE payments (id uuid primary key default gen_random_uuid(), community_id uuid, product_type text, product_id uuid, fee_type text, payee text, payee_display_name text,
  connected_account_id text, amount_cents int, method text, processor text, processor_payment_id text, processor_session_id text, processor_metadata jsonb,
  status text CHECK (status IN ('pending','succeeded','failed','refunded','partially_refunded','cancelled')), paid_at timestamptz, failure_reason text,
  initiated_by text, created_at timestamptz default now(), updated_at timestamptz default now());
CREATE TABLE assessment_autopay (id uuid primary key default gen_random_uuid(), property_id uuid, status text, status_reason text, cancelled_at timestamptz, cancelled_by text);
CREATE VIEW v_current_owner_balance AS
  SELECT t.community_id, t.property_id, t.id AS tenure_id, coalesce(sum(h.amount_cents),0)::bigint AS balance_cents
    FROM ownership_tenures t LEFT JOIN homeowner_transactions h ON h.tenure_id = t.id
    LEFT JOIN transaction_upload_batches b ON b.id = h.source_batch_id
   WHERE t.end_date IS NULL AND (b.status = 'committed' OR h.id IS NULL) GROUP BY 1,2,3;
`;
const appsTable = between(m461, 'CREATE TABLE IF NOT EXISTS homeowner_txn_applications', ');');
const appsTrigger = between(m461, 'CREATE OR REPLACE FUNCTION homeowner_txn_applications_guard()', '$fn$;');
const appsTrg = between(m461, 'DROP TRIGGER IF EXISTS trg_homeowner_txn_applications_guard', 'homeowner_txn_applications_guard();');

const db = new PGlite();
await db.exec(stub);
await db.exec(appsTable + '\n' + appsTrigger + '\n' + appsTrg);
await db.exec(m469);
console.log('migration 469 applied (incl. self-test)');
await db.exec(m469);
console.log('migration 469 re-applied (idempotent)');

const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const expectErr = async (name, fn, re) => { try { await fn(); fail++; console.log('FAIL ', name, '(no error)'); } catch (e) { const ok = !re || re.test(e.message); ok ? pass++ : fail++; console.log(ok ? 'PASS ' : 'FAIL ', name, ok ? '' : e.message); } };

// World: one lot, seller tenure (current), charges on the seller tenure.
const C = '00000000-0000-0000-0000-00000000000c', P = '00000000-0000-0000-0000-0000000000a1', S = '00000000-0000-0000-0000-0000000000f1', B = '00000000-0000-0000-0000-0000000000f2';
const SK = '00000000-0000-0000-0000-00000000c0c1', BK = '00000000-0000-0000-0000-00000000c0c2';
await db.exec(`
INSERT INTO communities VALUES ('${C}', gen_random_uuid(), '2026-07-01');
INSERT INTO properties VALUES ('${P}', '${C}', '2013059', '1004384184');
INSERT INTO contacts VALUES ('${SK}'), ('${BK}');
INSERT INTO ownership_tenures VALUES ('${S}', '${C}', '${P}', 'owner', '2026-05-19', NULL, '2013059');
INSERT INTO property_ownerships (tenure_id, contact_id, is_primary, start_date) VALUES ('${S}', '${SK}', true, '2026-05-19');
INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_subtype) VALUES ('${C}', '1000', 'Operating Cash', 'current_asset'), ('${C}', '1300', 'AR', 'current_asset');
INSERT INTO transaction_upload_batches (id, community_id, source_format, status) VALUES ('00000000-0000-0000-0000-0000000b0001', '${C}', 'manual', 'committed');
INSERT INTO homeowner_transactions (source_batch_id, community_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents)
VALUES ('00000000-0000-0000-0000-0000000b0001', '${C}', '${P}', '${S}', '2026-07-01', 'Q3 assessment', 'charge', 'assessment', 20000),
       ('00000000-0000-0000-0000-0000000b0001', '${C}', '${P}', '${S}', '2026-06-01', 'Prior balance', 'charge', 'prior_balance', 5000);
INSERT INTO assessment_autopay (property_id, status) VALUES ('${P}', 'active');
`);
await db.exec(m469); await db.exec(m469);
check('COA seeded 1090 Stripe Clearing beside 1000 (once, even after re-run)', (await one(`SELECT count(*)::int n FROM chart_of_accounts WHERE account_number='1090'`)).n === 1);
const bal = async (t) => Number((await one(`SELECT coalesce(sum(h.amount_cents),0)::bigint b FROM homeowner_transactions h JOIN transaction_upload_batches x ON x.id=h.source_batch_id AND x.status='committed' WHERE h.tenure_id=$1`, [t])).b);
check('seller balance starts at $250.00', await bal(S) === 25000);

// Checkout rows (group), identity enforced
const newGroup = async (method, amount) => {
  const g = (await one('SELECT gen_random_uuid() g')).g;
  await db.query(`INSERT INTO payments (community_id, product_type, product_id, fee_type, payee, amount_cents, status, processor_session_id,
     payment_group_id, property_id, tenure_id, contact_id, trusted_account_number, payment_method_type, settlement_state, posting_state)
     VALUES ($1,'assessment_payment',$2,'assessment','community_association',$3,'pending',$4,$5,$2,$6,$7,'1004384184',$8,'awaiting_payment','not_posted')`,
    [C, P, amount, 'cs_test_' + g.slice(0, 8), g, S, SK, method]);
  return g;
};
await expectErr('new-model assessment row without a tenure is refused', () => db.query(`INSERT INTO payments (community_id, product_type, fee_type, amount_cents, status, payment_group_id, property_id, trusted_account_number, settlement_state, posting_state)
  VALUES ($1,'assessment_payment','assessment',100,'pending',gen_random_uuid(),$2,'x','awaiting_payment','not_posted')`, [C, P]), /payments_assessment_identity_check/);

// ---- Card: paid -> credit once ----
const g1 = await newGroup('card', 20000);
let r = (await one(`SELECT payment_settle($1, NULL, 'pi_1', 'ch_1') r`, [g1])).r;
check('card: settle returns post', r.action === 'post');
const pid1 = r.payment_id;
check('card: before posting, balance unchanged', await bal(S) === 25000);
r = (await one(`SELECT post_stripe_tenure_payment($1, '2026-09-27') r`, [pid1])).r;
check('card: AR row written to a DRAFT batch (invisible until GL)', r.batch_status === 'draft' && await bal(S) === 25000);
check('card: $200 applied to the assessment first (209.0063), prior balance not auto-applied', r.applied_cents === 20000 && r.unapplied_cents === 0);
const r2 = (await one(`SELECT post_stripe_tenure_payment($1, '2026-09-27') r`, [pid1])).r;
check('card: re-running AR posting returns the same row (no second credit)', r2.already_posted === true && r2.payment_txn_id === r.payment_txn_id);
const je = (await one(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:pay:'||$2) RETURNING id`, [C, pid1])).id;
await expectErr('card: a second journal entry for the same payment is refused', () => db.query(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:pay:'||$2)`, [C, pid1]), /uq_journal_entries_stripe_ref|duplicate/);
await db.query(`SELECT payment_commit_posting($1, $2)`, [pid1, je]);
check('card: after commit the seller is credited exactly once ($250 -> $50)', await bal(S) === 5000);
r = (await one(`SELECT payment_settle($1, NULL, 'pi_1', 'ch_1') r`, [g1])).r;
check('card: a duplicate settle event is a no-op (done)', r.action === 'done');
await expectErr('card: a second ledger row for the same payment is refused by the unique key', () => db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, tenure_id, transaction_date, description, txn_type, amount_cents, reduction_source, raw_row_jsonb)
  VALUES ('00000000-0000-0000-0000-0000000b0001', $1, $2, '2026-09-27', 'dup', 'payment', -1, 'cash_payment', jsonb_build_object('source','stripe_payment','payment_id',$3::text))`, [C, S, pid1]), /uq_homeowner_txn_stripe_payment|duplicate/);

// ---- ACH: processing never credits; success credits once; failure never credits ----
const g2 = await newGroup('us_bank_account', 3000);
r = (await one(`SELECT payment_mark_processing($1, NULL, 'pi_2') r`, [g2])).r;
check('ACH: completed-but-unpaid -> processing', r.action === 'processing');
await expectErr('ACH: posting a processing payment is refused (cannot credit before settlement)', () => db.query(`SELECT post_stripe_tenure_payment(payment_group_anchor($1, NULL), '2026-09-27')`, [g2]), /not settled/);
check('ACH: pending ACH leaves the balance unchanged', await bal(S) === 5000);
const g3 = await newGroup('us_bank_account', 4000);
await db.query(`SELECT payment_mark_processing($1, NULL, 'pi_3')`, [g3]);
r = (await one(`SELECT payment_mark_failed($1, NULL, 'pi_3', 'failed', 'account closed') r`, [g3])).r;
check('ACH failure: processing -> failed', r.action === 'failed');
check('ACH failure: no ledger row exists and balance unchanged', (await one(`SELECT count(*)::int n FROM homeowner_transactions WHERE raw_row_jsonb->>'payment_id' = (SELECT id::text FROM payments WHERE payment_group_id=$1 AND fee_type='assessment')`, [g3])).n === 0 && await bal(S) === 5000);
r = (await one(`SELECT payment_settle($1, NULL, 'pi_3', NULL) r`, [g3])).r;
check('ACH: a late "paid" after failure is held for review, never auto-credited', r.action === 'review');
r = (await one(`SELECT payment_settle($1, NULL, 'pi_2', 'ch_2') r`, [g2])).r;
check('ACH success: processing -> post', r.action === 'post');

// ---- Sale between checkout and settlement: the seller (captured tenure) is credited ----
await db.exec(`UPDATE ownership_tenures SET end_date='2026-09-26' WHERE id='${S}';
  INSERT INTO ownership_tenures VALUES ('${B}', '${C}', '${P}', 'owner', '2026-09-27', NULL, NULL);`);
check('transfer: ending the seller tenure cancelled the seller autopay', (await one(`SELECT status, cancelled_by FROM assessment_autopay`)).cancelled_by === 'ownership_transfer');
const pid2 = r.payment_id;
r = (await one(`SELECT post_stripe_tenure_payment($1, '2026-09-28') r`, [pid2])).r;
check('transfer: the ACH payment posts to the SELLER tenure it was captured for', r.tenure_id === S);
check('transfer: seller has no open charge left for it, so it sits as unapplied credit (allowed)', r.unapplied_cents === 3000);
const je2 = (await one(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:pay:'||$2) RETURNING id`, [C, pid2])).id;
await db.query(`SELECT payment_commit_posting($1, $2)`, [pid2, je2]);
check('transfer: the buyer is not credited', await bal(B) === 0);
check('transfer: the payment row carries the lot Vantaca # from the TENURE, not the lot', (await one(`SELECT vantaca_account_id v FROM homeowner_transactions WHERE raw_row_jsonb->>'payment_id'=$1`, [pid2])).v === '2013059');

// ---- Reversal ----
const before = await bal(S);
r = (await one(`SELECT reverse_stripe_tenure_payment($1, 'refund re_1') r`, [pid1])).r;
check('reversal: full refund reverts the credit (seller balance +$200)', r.already_reversed === false && await bal(S) === before + 20000);
r = (await one(`SELECT reverse_stripe_tenure_payment($1, 'refund re_1') r`, [pid1])).r;
check('reversal: repeating it is a no-op', r.already_reversed === true && await bal(S) === before + 20000);
const open = await one(`SELECT coalesce(sum(ap.applied_cents),0)::bigint n FROM homeowner_txn_applications ap JOIN homeowner_transactions p ON p.id=ap.payment_txn_id JOIN transaction_upload_batches b ON b.id=p.source_batch_id AND b.status<>'reverted' WHERE ap.payment_txn_id=$1`, [pid1 && r.homeowner_txn_id || (await one(`SELECT homeowner_txn_id h FROM payments WHERE id=$1`, [pid1])).h]);
check('reversal: the reversed payment no longer counts as paying the assessment', Number(open.n) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
