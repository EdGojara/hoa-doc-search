// tests/sql/_469_world.mjs — shared stub world for the migration 469 rehearsals: stub tables
// mirroring the production columns 469 touches, plus the REAL objects it depends on
// (461 applications table/trigger and closing-payoff function, 459 ownership guard).
import fs from 'fs';

export function world469(REPO) {
  const m459 = fs.readFileSync(`${REPO}/migrations/459_ownership_transfer_single_path.sql`, 'utf8');
  const m461 = fs.readFileSync(`${REPO}/migrations/461_homeowner_payment_applications.sql`, 'utf8');
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
  ];
  real.push(between(m461, 'CREATE OR REPLACE FUNCTION post_homeowner_tenure_payment(', '\n$$;'));
  return { stub, real: real.join('\n') };
}
