// tests/sql/onboarding_world.mjs — shared PGlite world for the onboarding engine
// tests: the stub tables 452 references, then the REAL 452 / 481 (and optionally
// 482 / 483 / 484) migration files, exactly as committed. Returns { db, client, rpc }.
//   rpc(name, args) calls a SQL function with named arguments, like supabase.rpc.
// { gl: true } replaces the minimal stubs with the accounting tables EXECUTE (488)
// writes, with the production columns and constraints that matter to it (170 GL +
// 454 superseded + 466 source_module; 195/199/455/456 homeowner ledger; 177 AP).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
export const COMM = '00000000-0000-0000-0000-0000000000c1';

const MIN_STUBS = `
    CREATE TABLE communities (id uuid PRIMARY KEY, name text);
    CREATE TABLE properties (id uuid PRIMARY KEY);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY);
    CREATE TABLE account_funds (id uuid PRIMARY KEY);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY);
    CREATE TABLE vendors (id uuid PRIMARY KEY);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`;

const GL_STUBS = `
    CREATE TABLE management_companies (id uuid PRIMARY KEY);
    CREATE TABLE communities (id uuid PRIMARY KEY, name text, management_company_id uuid REFERENCES management_companies(id), gl_cutover_date date, updated_at timestamptz);
    CREATE TABLE properties (id uuid PRIMARY KEY, community_id uuid, vantaca_account_id text, street_address text);
    CREATE TABLE contacts (id uuid PRIMARY KEY);
    CREATE TABLE account_funds (id uuid PRIMARY KEY, community_id uuid, fund_code text);
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY, community_id uuid, account_number text, fund_id uuid, vantaca_account_number text);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY);
    CREATE TABLE vendors (id uuid PRIMARY KEY, name text, management_company_id uuid);
    CREATE TABLE accounting_periods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), fiscal_year int NOT NULL, period_number int NOT NULL,
      period_start date NOT NULL, period_end date NOT NULL, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked','reopened')), UNIQUE (community_id, fiscal_year, period_number));
    CREATE TABLE journal_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), period_id uuid NOT NULL REFERENCES accounting_periods(id),
      posting_date date NOT NULL, reference text NOT NULL, description text NOT NULL,
      source_module text NOT NULL DEFAULT 'manual' CHECK (source_module IN ('manual','assessment_billing','payment_intake','bank_reconciliation','vantaca_import','ar_snapshot',
        'reserve_transfer','closing_entry','opening_entry','reversal','system','ap_invoice','certified_letter_fee','ap_billback','recognition')),
      source_reference text, total_debits_cents bigint NOT NULL, total_credits_cents bigint NOT NULL,
      reverses_je_id uuid REFERENCES journal_entries(id), void_reversal_je_id uuid REFERENCES journal_entries(id),
      status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','voided','superseded')),
      voided_at timestamptz, void_reason text, posted_at timestamptz NOT NULL DEFAULT now(), notes text,
      superseded_at timestamptz, superseded_reason text, superseded_by_conversion text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (community_id, reference), CHECK (total_debits_cents = total_credits_cents), CHECK (total_debits_cents > 0),
      CONSTRAINT journal_entries_superseded_audit CHECK (status <> 'superseded' OR (superseded_at IS NOT NULL AND superseded_reason IS NOT NULL)));
    CREATE TABLE journal_entry_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid NOT NULL REFERENCES journal_entries(id), line_number int NOT NULL,
      account_id uuid NOT NULL REFERENCES chart_of_accounts(id), fund_id uuid REFERENCES account_funds(id), debit_cents bigint NOT NULL DEFAULT 0, credit_cents bigint NOT NULL DEFAULT 0, memo text,
      property_id uuid REFERENCES properties(id), vendor_id uuid, bank_account_id uuid REFERENCES bank_accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (debit_cents >= 0 AND credit_cents >= 0), CHECK (NOT (debit_cents > 0 AND credit_cents > 0)), CHECK (debit_cents > 0 OR credit_cents > 0));
    CREATE TABLE ownership_tenures (id uuid PRIMARY KEY, community_id uuid, property_id uuid, kind text NOT NULL DEFAULT 'owner', start_date date, end_date date);
    CREATE TABLE transaction_upload_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), management_company_id uuid NOT NULL REFERENCES management_companies(id), community_id uuid NOT NULL REFERENCES communities(id),
      period_label text NOT NULL, as_of_date date NOT NULL, source_filename text, source_storage_path text,
      source_format text NOT NULL DEFAULT 'csv' CHECK (source_format IN ('csv','pdf','manual')), row_count int NOT NULL DEFAULT 0, account_count int NOT NULL DEFAULT 0,
      total_charges_cents bigint, total_payments_cents bigint, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed','reverted')),
      uploaded_by text, uploaded_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, reverted_at timestamptz, reverted_reason text, notes text,
      min_transaction_date date, max_transaction_date date, replaced_by_batch_id uuid REFERENCES transaction_upload_batches(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE homeowner_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_batch_id uuid NOT NULL REFERENCES transaction_upload_batches(id), source_row_index int NOT NULL,
      community_id uuid NOT NULL REFERENCES communities(id), vantaca_account_id text NOT NULL, property_id uuid REFERENCES properties(id), contact_id uuid REFERENCES contacts(id),
      transaction_date date NOT NULL, description text NOT NULL,
      txn_type text NOT NULL DEFAULT 'charge' CHECK (txn_type IN ('charge','payment','credit','adjustment','balance_brought_forward')),
      amount_cents bigint NOT NULL, running_balance_cents bigint, raw_row_jsonb jsonb, notes text, created_at timestamptz NOT NULL DEFAULT now(),
      charge_category text CHECK (charge_category IS NULL OR charge_category IN ('assessment','late_fee','interest','fine','attorney_fee','admin_fee','payment','credit','refund',
        'adjustment','prior_balance','other','certified_letter','attorney_fee_other','nsf_fee')),
      trusted_account_number text, tenure_id uuid REFERENCES ownership_tenures(id), UNIQUE (source_batch_id, source_row_index));
    CREATE TABLE ap_invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), community_id uuid NOT NULL REFERENCES communities(id), vendor_id uuid NOT NULL REFERENCES vendors(id),
      vendor_invoice_number text, invoice_date date NOT NULL, due_date date, subtotal_cents bigint NOT NULL DEFAULT 0, tax_cents bigint NOT NULL DEFAULT 0,
      total_cents bigint NOT NULL CHECK (total_cents > 0), amount_paid_cents bigint NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0 AND amount_paid_cents <= total_cents),
      status text NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval','approved','partially_paid','paid','voided','disputed','on_hold')),
      posting_journal_entry_id uuid REFERENCES journal_entries(id), voided_at timestamptz, notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (community_id, vendor_id, vendor_invoice_number));`;

export async function onboardingWorld(PGlite, { through = 485, gl = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE OR REPLACE FUNCTION trusted_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    ${gl ? GL_STUBS : MIN_STUBS}
    CREATE TABLE schema_migrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename text NOT NULL UNIQUE, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text, duration_ms integer, error text);
    INSERT INTO communities (id, name) VALUES ('${COMM}', 'Example Creek');`);
  await db.exec(lf(`${REPO}/migrations/452_conversion_staging.sql`));
  await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('452_conversion_staging.sql', 'recorded'), ('480_acc_finalization_record.sql', 'recorded')`);
  if (through >= 481) { await db.exec(lf(`${REPO}/migrations/481_onboarding_engine.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('481_onboarding_engine.sql', 'recorded')`); }
  if (through >= 482) { await db.exec(lf(`${REPO}/migrations/482_onboarding_service.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('482_onboarding_service.sql', 'recorded')`); }
  if (through >= 483) { await db.exec(lf(`${REPO}/migrations/483_onboarding_snapshot.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('483_onboarding_snapshot.sql', 'recorded')`); }
  if (through >= 484) { await db.exec(lf(`${REPO}/migrations/484_onboarding_activity_bridge.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('484_onboarding_activity_bridge.sql', 'recorded')`); }
  if (through >= 485) { await db.exec(lf(`${REPO}/migrations/485_onboarding_operator.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('485_onboarding_operator.sql', 'recorded')`); }
  if (through >= 486) { await db.exec(lf(`${REPO}/migrations/486_onboarding_bridge_decisions.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('486_onboarding_bridge_decisions.sql', 'recorded')`); }
  if (through >= 488) { await db.exec(lf(`${REPO}/migrations/488_onboarding_execute.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('488_onboarding_execute.sql', 'recorded')`); }
  if (through >= 491) { await db.exec(lf(`${REPO}/migrations/491_onboarding_batches_complete_result.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('491_onboarding_batches_complete_result.sql', 'recorded')`); }
  if (through >= 497) { await db.exec(lf(`${REPO}/migrations/497_onboarding_bridge_refresh_at_preflight.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('497_onboarding_bridge_refresh_at_preflight.sql', 'recorded')`); }
  if (through >= 498) { await db.exec(lf(`${REPO}/migrations/498_onboarding_execute_neutralize_counted.sql`)); await db.exec(`INSERT INTO schema_migrations (filename, sha256) VALUES ('498_onboarding_execute_neutralize_counted.sql', 'recorded')`); }
  const client = { query: async (sql, params) => {
    if (params) { const r = await db.query(sql, params.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v))); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }
    const rs = await db.exec(sql); const last = rs[rs.length - 1] || { rows: [] }; return { rows: last.rows, rowCount: last.affectedRows ?? 0 };
  } };
  const rpc = async (name, args = {}) => {
    if (!/^[a-z_]+$/.test(name)) throw new Error('bad function name');
    const keys = Object.keys(args);
    const sql = `SELECT ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`;
    try {
      const res = await db.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
      return res.rows[0] ? res.rows[0].r : null;
    } catch (e) { const err = new Error(e.message); err.code = e.code; throw err; }
  };
  return { db, client, rpc };
}
