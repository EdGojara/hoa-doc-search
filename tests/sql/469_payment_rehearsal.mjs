// tests/sql/469_payment_rehearsal.mjs — SQL rehearsal for migration 469 against an
// in-memory Postgres (PGlite) with stub tables mirroring the production columns it
// touches, plus migration 461's REAL applications trigger and 459's REAL ownership
// guard (so the sandbox owner lands on the lot's current tenure). Also exercises the
// separate sandbox provisioning (lib/payments/payment_sandbox_provision.js). Skips (exit 0)
// when @electric-sql/pglite is not installed; install it as a dev dependency to run
// it in npm test. Run: node tests/sql/469_payment_rehearsal.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try { ({ PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')); }
catch (_) { console.log('SKIP  migration 469 SQL rehearsal (@electric-sql/pglite not installed; set PGLITE_MODULE or add the dev dependency)'); process.exit(0); }
const m459 = fs.readFileSync(`${REPO}/migrations/459_ownership_transfer_single_path.sql`, 'utf8');
const m461 = fs.readFileSync(`${REPO}/migrations/461_homeowner_payment_applications.sql`, 'utf8');
const m469 = fs.readFileSync(`${REPO}/migrations/469_payments_safe_foundation.sql`, 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error('extract ' + a); return s.slice(i, j + b.length); };

const stub = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE communities (id uuid primary key, management_company_id uuid, gl_cutover_date date, is_demo boolean NOT NULL DEFAULT false, stripe_connected_account_id text);
CREATE TABLE properties (id uuid primary key, community_id uuid, vantaca_account_id text, trusted_account_number text);
CREATE UNIQUE INDEX uq_properties_trusted_account_number ON properties (trusted_account_number) WHERE trusted_account_number IS NOT NULL;
CREATE TABLE contacts (id uuid primary key, full_name text NOT NULL, primary_email text, notes text);
CREATE TABLE portal_users (id uuid primary key default gen_random_uuid(), management_company_id uuid NOT NULL, email text NOT NULL, full_name text,
  role text NOT NULL CHECK (role IN ('board_member','homeowner','staff','admin','franchisee')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','revoked')),
  contact_id uuid, notes text, UNIQUE (management_company_id, email));
CREATE TABLE portal_user_properties (portal_user_id uuid NOT NULL, property_id uuid NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(), granted_by text,
  revoked_at timestamptz, revoked_by text, notes text, PRIMARY KEY (portal_user_id, property_id));
CREATE TABLE account_funds (id uuid primary key default gen_random_uuid(), community_id uuid NOT NULL, fund_code text NOT NULL, fund_name text NOT NULL,
  fund_type text NOT NULL CHECK (fund_type IN ('operating','reserve','special_assessment','capital_improvement','escrow','other')),
  display_order int NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, notes text, UNIQUE (community_id, fund_code));
CREATE TABLE accounting_periods (id uuid primary key default gen_random_uuid(), community_id uuid NOT NULL, fiscal_year int NOT NULL, period_number int NOT NULL,
  period_type text NOT NULL DEFAULT 'monthly' CHECK (period_type IN ('monthly','quarterly','annual','adjustment')), period_start date NOT NULL, period_end date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked','reopened')), notes text,
  UNIQUE (community_id, fiscal_year, period_number), CHECK (period_end >= period_start));
CREATE TABLE ownership_tenures (id uuid primary key, community_id uuid, property_id uuid, kind text, start_date date, end_date date, vantaca_account_id text);
CREATE TABLE property_ownerships (id uuid primary key default gen_random_uuid(), property_id uuid, tenure_id uuid, contact_id uuid NOT NULL,
  is_primary bool NOT NULL DEFAULT false, start_date date NOT NULL, end_date date, source text, notes text);
CREATE TABLE transaction_upload_batches (id uuid primary key default gen_random_uuid(), management_company_id uuid, community_id uuid, period_label text, as_of_date date,
  source_format text CHECK (source_format IN ('csv','pdf','manual')), status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed','reverted')),
  row_count int, account_count int, total_charges_cents bigint, total_payments_cents bigint, min_transaction_date date, max_transaction_date date, uploaded_by text, notes text);
CREATE TABLE homeowner_transactions (id uuid primary key default gen_random_uuid(), source_batch_id uuid references transaction_upload_batches(id), source_row_index int,
  community_id uuid, vantaca_account_id text, trusted_account_number text, property_id uuid, contact_id uuid, tenure_id uuid, transaction_date date, description text,
  txn_type text CHECK (txn_type IN ('charge','payment','credit','adjustment','balance_brought_forward')), charge_category text, amount_cents bigint, running_balance_cents bigint,
  reduction_source text CHECK (reduction_source IS NULL OR (reduction_source IN ('cash_payment','prepaid_credit','credit_waiver','correcting_adjustment') AND amount_cents < 0)),
  raw_row_jsonb jsonb,
  CONSTRAINT homeowner_transactions_charge_category_check CHECK (charge_category IS NULL OR charge_category IN ('assessment','late_fee','interest','fine','attorney_fee',
    'admin_fee','payment','credit','refund','adjustment','prior_balance','other','certified_letter','attorney_fee_other','nsf_fee')));
CREATE TABLE journal_entries (id uuid primary key default gen_random_uuid(), community_id uuid, source_module text, source_reference text, status text default 'posted', total_debits_cents bigint default 0);
CREATE TABLE chart_of_accounts (id uuid primary key default gen_random_uuid(), community_id uuid, fund_id uuid, account_number text, account_name text,
  account_type text NOT NULL DEFAULT 'asset', account_subtype text, normal_balance text NOT NULL DEFAULT 'debit', is_summary bool NOT NULL DEFAULT false,
  is_active bool NOT NULL DEFAULT true, description text);
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
const real = [
  between(m461, 'CREATE TABLE IF NOT EXISTS homeowner_txn_applications', ');'),
  between(m461, 'CREATE OR REPLACE FUNCTION homeowner_txn_applications_guard()', '$fn$;'),
  between(m461, 'DROP TRIGGER IF EXISTS trg_homeowner_txn_applications_guard', 'homeowner_txn_applications_guard();'),
  between(m459, 'CREATE OR REPLACE FUNCTION ownership_transfer_in_progress()', '$fn$;'),
  between(m459, 'CREATE OR REPLACE FUNCTION property_ownerships_transfer_guard()', '$fn$;'),
  between(m459, 'DROP TRIGGER IF EXISTS trg_property_ownerships_transfer_guard', 'property_ownerships_transfer_guard();'),
].join('\n');

const db = new PGlite();
await db.exec(stub);
await db.exec(real);
await db.exec(m469);
console.log('migration 469 applied to an empty world (incl. self-test)');
await db.exec(m469);
console.log('migration 469 re-applied (idempotent)');

const q = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await q(s, p))[0];
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra); } };
const expectErr = async (name, fn, re) => { try { await fn(); fail++; console.log('FAIL ', name, '(no error)'); } catch (e) { const ok = !re || re.test(e.message); ok ? pass++ : fail++; console.log(ok ? 'PASS ' : 'FAIL ', name, ok ? '' : e.message); } };

// World: one lot, seller tenure (current), charges on the seller tenure.
const C = '00000000-0000-0000-0000-00000000000c', C2 = '00000000-0000-0000-0000-0000000000c2';
const P = '00000000-0000-0000-0000-0000000000a1', S = '00000000-0000-0000-0000-0000000000f1', B = '00000000-0000-0000-0000-0000000000f2';
const SK = '00000000-0000-0000-0000-00000000c0c1', BK = '00000000-0000-0000-0000-00000000c0c2', B0 = '00000000-0000-0000-0000-0000000b0001';
await db.exec(`
INSERT INTO communities VALUES ('${C}', gen_random_uuid(), '2026-07-01', false, NULL), ('${C2}', gen_random_uuid(), NULL, false, NULL);
INSERT INTO properties VALUES ('${P}', '${C}', '2013059', '1004384184');
INSERT INTO contacts VALUES ('${SK}', 'Seller'), ('${BK}', 'Buyer');
INSERT INTO ownership_tenures VALUES ('${S}', '${C}', '${P}', 'owner', '2026-05-19', NULL, '2013059');
INSERT INTO property_ownerships (property_id, contact_id, is_primary, start_date) VALUES ('${P}', '${SK}', true, '2026-05-19');
INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_subtype) VALUES ('${C}', '1000', 'Operating Cash', 'current_asset'), ('${C}', '1300', 'AR', 'current_asset'),
  ('${C2}', '1500', 'Other asset', 'current_asset');
INSERT INTO chart_of_accounts (community_id, account_number, account_name, account_type, normal_balance) VALUES ('${C}', '2100', 'Prepaid Assessments', 'liability', 'credit');
INSERT INTO transaction_upload_batches (id, community_id, source_format, status) VALUES ('${B0}', '${C}', 'manual', 'committed');
INSERT INTO homeowner_transactions (source_batch_id, community_id, property_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents)
VALUES ('${B0}', '${C}', '${P}', '${S}', '2026-07-01', 'Q3 assessment', 'charge', 'assessment', 20000),
       ('${B0}', '${C}', '${P}', '${S}', '2026-06-01', 'Prior balance', 'charge', 'prior_balance', 5000);
INSERT INTO assessment_autopay (property_id, status) VALUES ('${P}', 'active');
`);
const wBefore = await one(`SELECT (SELECT count(*) FROM homeowner_transactions)::int ht, (SELECT count(*) FROM payments)::int pay, (SELECT count(*) FROM journal_entries)::int je,
  (SELECT string_agg(status, ',') FROM assessment_autopay) autopay, (SELECT count(*) FROM transaction_upload_batches)::int batches`);
await db.exec(m469); await db.exec(m469);
const wAfter = await one(`SELECT (SELECT count(*) FROM homeowner_transactions)::int ht, (SELECT count(*) FROM payments)::int pay, (SELECT count(*) FROM journal_entries)::int je,
  (SELECT string_agg(status, ',') FROM assessment_autopay) autopay, (SELECT count(*) FROM transaction_upload_batches)::int batches`);
check('469 writes no payment, ledger row, batch, journal entry or autopay change', JSON.stringify(wBefore) === JSON.stringify(wAfter), JSON.stringify({ wBefore, wAfter }));
check('469 self-test leaves no stripe_events row and no self-test role behind', (await one(`SELECT count(*)::int n FROM stripe_events`)).n === 0
  && (await one(`SELECT count(*)::int n FROM community_account_roles WHERE updated_by <> 'migration 469'`)).n === 0);
check('469 flags no sandbox lot', (await one(`SELECT count(*)::int n FROM properties WHERE payment_sandbox`)).n === 0);

// ---- Account roles + 1090 ----
check('COA seeded 1090 beside 1000 (once, even after re-run)', (await one(`SELECT count(*)::int n FROM chart_of_accounts WHERE account_number='1090'`)).n === 1);
check('1090 is named cash in transit (balance sheet Cash group; not cash on hand)', /^Cash in Transit/.test((await one(`SELECT account_name n FROM chart_of_accounts WHERE account_number='1090'`)).n));
const roles = await q(`SELECT r.role, a.account_number FROM community_account_roles r JOIN chart_of_accounts a ON a.id=r.account_id WHERE r.community_id=$1 ORDER BY r.role`, [C]);
check('roles seeded: homeowner_ar=1300, operating_cash=1000, stripe_clearing=1090',
  roles.map((x) => x.role + '=' + x.account_number).join(',') === 'homeowner_ar=1300,operating_cash=1000,stripe_clearing=1090', JSON.stringify(roles));
check('roles: a community without 1000 gets no seeded roles (posting will block, not guess)', (await one(`SELECT count(*)::int n FROM community_account_roles WHERE community_id=$1`, [C2])).n === 0);
await expectErr('role: a liability account cannot be stripe_clearing', () => db.query(`UPDATE community_account_roles SET account_id=(SELECT id FROM chart_of_accounts WHERE community_id=$1 AND account_number='2100') WHERE community_id=$1 AND role='stripe_clearing'`, [C]), /debit-normal asset/);
await expectErr('role: an account from another community is refused', () => db.query(`INSERT INTO community_account_roles (community_id, role, account_id, updated_by) VALUES ($2, 'stripe_clearing', (SELECT id FROM chart_of_accounts WHERE community_id=$1 AND account_number='1090'), 't')`, [C, C2]), /not in community/);
await expectErr('role: an unknown role is refused', () => db.query(`INSERT INTO community_account_roles (community_id, role, account_id, updated_by) VALUES ($1, 'petty_cash', (SELECT id FROM chart_of_accounts WHERE community_id=$1 AND account_number='1500'), 't')`, [C2]), /check/i);
await expectErr('category: an invented category is still refused', () => db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, tenure_id, transaction_date, txn_type, charge_category, amount_cents) VALUES ($1, $2, $3, '2026-09-01', 'charge', 'made_up', 1)`, [B0, C, S]), /charge_category_check/);

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
  VALUES ($4, $1, $2, '2026-09-27', 'dup', 'payment', -1, 'cash_payment', jsonb_build_object('source','stripe_payment','payment_id',$3::text))`, [C, S, pid1, B0]), /uq_homeowner_txn_stripe_payment|duplicate/);

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
check('transfer: the payment row carries the Vantaca # from the TENURE, not the lot', (await one(`SELECT vantaca_account_id v FROM homeowner_transactions WHERE raw_row_jsonb->>'payment_id'=$1`, [pid2])).v === '2013059');

// ---- Explicit reversal (refund): the original payment stays; a reversal row reopens the charges ----
const openOf = async (chargeId) => Number((await one(`SELECT h.amount_cents - coalesce((SELECT sum(ap.applied_cents) FROM homeowner_txn_applications ap JOIN homeowner_transactions p ON p.id=ap.payment_txn_id JOIN transaction_upload_batches pb ON pb.id=p.source_batch_id AND pb.status<>'reverted' WHERE ap.charge_txn_id=h.id),0) o FROM homeowner_transactions h WHERE h.id=$1`, [chargeId])).o);
const asmt = (await one(`SELECT id FROM homeowner_transactions WHERE description='Q3 assessment'`)).id;
check('before reversal: the Q3 assessment is fully paid', await openOf(asmt) === 0);
const before = await bal(S);
const payTxn1 = (await one(`SELECT homeowner_txn_id h FROM payments WHERE id=$1`, [pid1])).h;
await expectErr('reversal: kind must be refund or chargeback', () => db.query(`SELECT reverse_stripe_tenure_payment($1, 'oops', 'x', '2026-10-02')`, [pid1]), /refund or chargeback/);
r = (await one(`SELECT reverse_stripe_tenure_payment($1, 'refund', 'refund re_1', '2026-10-02') r`, [pid1])).r;
check('reversal: drafted as its own row; balance unchanged until the GL reversal posts', r.already_drafted === false && r.batch_status === 'draft' && await bal(S) === before);
const r1b = (await one(`SELECT reverse_stripe_tenure_payment($1, 'refund', 'refund re_1', '2026-10-02') r`, [pid1])).r;
check('reversal: re-drafting returns the same row (no second reversal)', r1b.already_drafted === true && r1b.reversal_txn_id === r.reversal_txn_id);
const revJe = (await one(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:rev:'||$2) RETURNING id`, [C, pid1])).id;
const c1 = (await one(`SELECT payment_commit_reversal($1, $2) c`, [pid1, revJe])).c;
check('reversal: commit reverses the 1 application and reopens $200', c1.applications_reversed === 1 && Number(c1.reopened_cents) === 20000, JSON.stringify(c1));
check('reversal: seller balance goes back up by exactly $200', await bal(S) === before + 20000);
const orig1 = await one(`SELECT h.amount_cents, b.status FROM homeowner_transactions h JOIN transaction_upload_batches b ON b.id=h.source_batch_id WHERE h.id=$1`, [payTxn1]);
check('reversal: the ORIGINAL payment row is still on the ledger, committed, -$200', Number(orig1.amount_cents) === -20000 && orig1.status === 'committed');
const rev1 = await one(`SELECT h.amount_cents, h.charge_category, h.txn_type, h.transaction_date::text d FROM homeowner_transactions h WHERE h.reverses_txn_id=$1`, [payTxn1]);
check('reversal: a separate +$200 payment_reversal row, dated the refund date, points at the payment',
  Number(rev1.amount_cents) === 20000 && rev1.charge_category === 'payment_reversal' && rev1.txn_type === 'adjustment' && rev1.d === '2026-10-02', JSON.stringify(rev1));
check('reversal: the Q3 assessment is open again', await openOf(asmt) === 20000);
const apps1 = await one(`SELECT coalesce(sum(applied_cents),0)::bigint net, count(*)::int n FROM homeowner_txn_applications WHERE payment_txn_id=$1`, [payTxn1]);
check('reversal: original application kept, offset by an exact-negative reversal (net 0, 2 rows)', Number(apps1.net) === 0 && apps1.n === 2);
const pr = await one(`SELECT posting_state, reversal_txn_id, reversal_journal_entry_id, journal_entry_id FROM payments WHERE id=$1`, [pid1]);
check('reversal: payment shows reversed, linked to both journal entries and the reversal row',
  pr.posting_state === 'reversed' && pr.reversal_txn_id === r.reversal_txn_id && pr.reversal_journal_entry_id === revJe && pr.journal_entry_id === je);
r = (await one(`SELECT reverse_stripe_tenure_payment($1, 'refund', 'refund re_1', '2026-10-02') r`, [pid1])).r;
const c1b = (await one(`SELECT payment_commit_reversal($1, $2) c`, [pid1, revJe])).c;
check('reversal: repeating draft + commit is a no-op', r.already_reversed === true && c1b.already_committed === true && await bal(S) === before + 20000);
await expectErr('reversal: a second GL reversal entry for the same payment is refused', () => db.query(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:rev:'||$2)`, [C, pid1]), /uq_journal_entries_stripe_ref|duplicate/);
await expectErr('reversal: a second reversal row for the same payment is refused', () => db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, tenure_id, transaction_date, txn_type, charge_category, amount_cents, reverses_txn_id)
  VALUES ($4, $1, $2, '2026-10-02', 'adjustment', 'payment_reversal', 20000, $3)`, [C, S, payTxn1, B0]), /uq_homeowner_txn_reverses|duplicate/);
await expectErr('reversal: a reversal row must be positive and a reversal category', () => db.query(`INSERT INTO homeowner_transactions (source_batch_id, community_id, tenure_id, transaction_date, txn_type, charge_category, amount_cents, reverses_txn_id)
  VALUES ($3, $1, $2, '2026-10-02', 'adjustment', 'assessment', 20000, (SELECT id FROM homeowner_transactions WHERE description='Prior balance'))`, [C, S, B0]), /reversal_shape_check/);

// Planner exclusions: the reversal row is never treated as a charge.
const plan461 = (await one(`SELECT post_homeowner_tenure_payment($1,$2,$3,20000,'2026-10-05','1001','Title Co','{}'::jsonb,'test',true) r`, [C, P, S])).r;
check('461 planner: sees $250 open (assessment $200 + prior balance $50), NOT the +$200 reversal row',
  Number(plan461.open_before_cents) === 25000 && !JSON.stringify(plan461).includes(r1b.reversal_txn_id), JSON.stringify({ open: plan461.open_before_cents }));
check('461 planner: applies the payoff to the reopened assessment', plan461.applications.length === 1 && plan461.applications[0].charge_txn_id === asmt);
const g4 = await newGroup('card', 20000);
const pid4 = (await one(`SELECT payment_settle($1, NULL, 'pi_4', 'ch_4') r`, [g4])).r.payment_id;
const p4 = (await one(`SELECT post_stripe_tenure_payment($1, '2026-10-06') r`, [pid4])).r;
const p4apps = await q(`SELECT charge_txn_id FROM homeowner_txn_applications WHERE payment_txn_id=$1`, [p4.payment_txn_id]);
check('469 planner: a new online payment pays the reopened assessment, never the reversal row', p4.applied_cents === 20000 && p4apps.length === 1 && p4apps[0].charge_txn_id === asmt);

// Chargeback on a payment with no applications (unapplied credit).
r = (await one(`SELECT reverse_stripe_tenure_payment($1, 'chargeback', 'dispute dp_1', '2026-10-03') r`, [pid2])).r;
const cbJe = (await one(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:rev:'||$2) RETURNING id`, [C, pid2])).id;
const c2 = (await one(`SELECT payment_commit_reversal($1, $2) c`, [pid2, cbJe])).c;
check('chargeback: category chargeback, zero applications to reverse, reversal row visible', c2.applications_reversed === 0 &&
  (await one(`SELECT charge_category c FROM homeowner_transactions WHERE id=$1`, [r.reversal_txn_id])).c === 'chargeback');
r = (await one(`SELECT reverse_stripe_tenure_payment(payment_group_anchor($1, NULL), 'refund', 'refund re_9', '2026-10-03') r`, [g3])).r;
check('reversal of a never-posted payment is held for review, nothing written', r.action === 'review');

// ---- Payment sandbox: 469 provides only the capability; provisioning is separate ----
await expectErr('sandbox: a lot in a real (non-demo) community cannot be the sandbox', () => db.query(`UPDATE properties SET payment_sandbox=true WHERE id=$1`, [P]), /demo community/);
const DC = 'dc100000-0000-4000-a000-000000000000', LOT = 'e09d3deb-57c7-4028-b366-4f79c9379708', DT = '23e196cd-dc21-4021-a479-74a876aab6f8', DMC = 'd0000000-0000-4000-a000-000000000000';
const LOT2 = '00000000-0000-0000-0000-0000000000d2';
await db.exec(`INSERT INTO communities VALUES ('${DC}', '${DMC}', NULL, true, NULL);
  INSERT INTO properties VALUES ('${LOT}', '${DC}', NULL, NULL), ('${LOT2}', '${DC}', NULL, NULL);
  INSERT INTO ownership_tenures VALUES ('${DT}', '${DC}', '${LOT}', 'owner', NULL, NULL, NULL);`);
await db.exec(m469);
const dcFootprint = async () => one(`SELECT (SELECT count(*) FROM properties WHERE payment_sandbox)::int flagged,
  (SELECT count(*) FROM chart_of_accounts WHERE community_id=$1)::int coa, (SELECT count(*) FROM community_account_roles WHERE community_id=$1)::int roles,
  (SELECT count(*) FROM account_funds WHERE community_id=$1)::int funds, (SELECT count(*) FROM accounting_periods WHERE community_id=$1)::int periods,
  (SELECT count(*) FROM property_ownerships WHERE property_id=$2)::int owners, (SELECT count(*) FROM portal_users)::int portal,
  (SELECT count(*) FROM contacts WHERE id::text LIKE '5a0d0469%')::int contacts,
  (SELECT gl_cutover_date::text FROM communities WHERE id=$1) cutover, (SELECT trusted_account_number FROM properties WHERE id=$2) trusted`, [DC, LOT]);
const EMPTY = JSON.stringify({ flagged: 0, coa: 0, roles: 0, funds: 0, periods: 0, owners: 0, portal: 0, contacts: 0, cutover: null, trusted: null });
check('469 creates NO Drama Creek data (no flag, GL, periods, cutover, owner, portal login or Trusted #)', JSON.stringify(await dcFootprint()) === EMPTY, JSON.stringify(await dcFootprint()));

const require = createRequire(import.meta.url);
const { runPaymentSandbox, sandboxRows, SANDBOX, _sql } = require(`${REPO}/lib/payments/payment_sandbox_provision.js`);
// pg-style client over PGlite: parameterized -> one statement; plain -> multi-statement script.
const client = { query: async (sql, params) => (params ? db.query(sql, params) : (await db.exec(sql)).slice(-1)[0] || { rows: [] }) };
const TEST = 'sk_test_x';
await expectErr('provision: refused when Stripe is LIVE (nothing written)', () => runPaymentSandbox(client, { action: 'apply', key: 'sk_live_x' }), /Stripe is live/);
await expectErr('provision: refused when Stripe is unconfigured', () => runPaymentSandbox(client, { action: 'apply', key: '' }), /Stripe is unconfigured/);
await expectErr('provision: the SQL refuses when pasted outside the runner (no test-mode flag)', () => db.exec(_sql.preflightSql()), /runs only through payment_sandbox_provision/);
check('provision: refusals left nothing behind', JSON.stringify(await dcFootprint()) === EMPTY);
await db.exec(`UPDATE communities SET is_demo=false WHERE id='${DC}'`);
await expectErr('provision: refused against a non-demo community', () => runPaymentSandbox(client, { action: 'apply', key: TEST }), /not a demo community/);
await db.exec(`UPDATE communities SET is_demo=true WHERE id='${DC}'`);

const plan = await runPaymentSandbox(client, { action: 'plan', key: TEST });
check('provision plan: shows the full result, then rolls back', plan.committed === false && plan.after.periods === 16 && plan.after.portal_access === true && JSON.stringify(await dcFootprint()) === EMPTY);
check('provision: every row it can touch is listed with a fixed id (29 entries)', sandboxRows().length === 29 && sandboxRows().every((r) => r.key));

const ap = await runPaymentSandbox(client, { action: 'apply', key: TEST });
const fp = await dcFootprint();
check('provision apply: lot flagged, Trusted # 1002900060, cutover 2026-09-01', ap.committed && fp.flagged === 1 && fp.trusted === '1002900060' && fp.cutover === '2026-09-01', JSON.stringify(fp));
check('provision apply: OPR fund, 1000/1090/1300, 16 open periods, 3 roles', fp.funds === 1 && fp.coa === 3 && fp.periods === 16 && fp.roles === 3);
check('provision apply: test owner on the lot\'s CURRENT tenure (459 guard), portal login scoped to the lot', ap.after.ownership && ap.after.ownership.tenure_id === DT && ap.after.portal_user && ap.after.portal_access);
const pu = await one(`SELECT role, status, management_company_id, email FROM portal_users WHERE id=$1`, [SANDBOX.ids.portalUser]);
check('provision apply: portal login is an active homeowner on the demo company, demo-suppressed email', pu.role === 'homeowner' && pu.status === 'active' && pu.management_company_id === DMC && /@bedrock\.test$/.test(pu.email));
check('provision apply: created rows carry the fixed ids', (await one(`SELECT count(*)::int n FROM chart_of_accounts WHERE id = ANY($1::uuid[])`, [Object.values(SANDBOX.ids.coa)])).n === 3);
await runPaymentSandbox(client, { action: 'apply', key: TEST });
check('provision: re-running apply adds nothing', JSON.stringify(await dcFootprint()) === JSON.stringify(fp));
check('provision: the other Drama Creek lot is untouched', (await one(`SELECT payment_sandbox, trusted_account_number FROM properties WHERE id=$1`, [LOT2])).trusted_account_number === null);
await expectErr('sandbox: a second sandbox lot (even in the demo) is refused', () => db.query(`UPDATE properties SET payment_sandbox=true WHERE id=$1`, [LOT2]), /uq_properties_one_payment_sandbox|duplicate/);
await expectErr('sandbox: the sandbox lot cannot be moved into a real community', () => db.query(`UPDATE properties SET community_id=$1 WHERE id=$2`, [C, LOT]), /demo community/);
await db.exec(m469);
check('469 re-applied after provisioning: sandbox data unchanged (independent)', JSON.stringify(await dcFootprint()) === JSON.stringify(fp));

// Removal: refused while test activity exists; clean removal restores the empty state; recreate works.
const act = (await one(`INSERT INTO journal_entries (community_id, source_module, source_reference) VALUES ($1,'payment_intake','stripe:pay:test') RETURNING id`, [DC])).id;
await expectErr('remove: refused while the sandbox has test activity (kept, not deleted)', () => runPaymentSandbox(client, { action: 'remove', key: TEST }), /test activity/);
await db.query(`DELETE FROM journal_entries WHERE id=$1`, [act]);   // rehearsal-only cleanup
await expectErr('remove: refused when Stripe is live', () => runPaymentSandbox(client, { action: 'remove', key: 'sk_live_x' }), /Stripe is live/);
const prm = await runPaymentSandbox(client, { action: 'plan_remove', key: TEST });
check('remove plan: shows the empty result, then rolls back', prm.committed === false && prm.after.periods === 0 && !prm.after.portal_user && JSON.stringify(await dcFootprint()) === JSON.stringify(fp));
await runPaymentSandbox(client, { action: 'remove', key: TEST });
check('remove: every sandbox row gone; lot unflagged, Trusted # and cutover cleared', JSON.stringify(await dcFootprint()) === EMPTY, JSON.stringify(await dcFootprint()));
check('remove: payment schema untouched (roles table, sandbox column, guard still there)', (await one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='properties' AND column_name='payment_sandbox'`)).n === 1
  && (await one(`SELECT count(*)::int n FROM community_account_roles WHERE community_id=$1`, [C])).n === 3);
await runPaymentSandbox(client, { action: 'apply', key: TEST });
check('recreate: apply after remove rebuilds the identical sandbox', JSON.stringify(await dcFootprint()) === JSON.stringify(fp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
