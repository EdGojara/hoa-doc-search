-- 177: Fixed AP sub-ledger + check printing substrate (replaces failed 175 + 176)
--
-- Migrations 175 and 176 failed because 175's idx_vendors_category_active
-- index referenced vendors.community_id which doesn't exist — the existing
-- vendors table (migration 009) is MANAGEMENT-COMPANY level, not per-community.
-- Vendors are shared across all communities a manager handles (one Superior
-- LawnCare row covers both Quail Ridge AND August Meadows). 1099 prep at
-- year-end groups by vendor across the portfolio — that's why it's mgmt-co.
--
-- 176 was blocked because it references ap_payments which 175 never created.
--
-- This migration re-does everything 175 + 176 attempted, with:
--   - vendors indexes correctly scoped to management_company_id
--   - Idempotent IF NOT EXISTS guards throughout (re-runnable)
--   - No data loss — 175 partially-applied nothing (0 applied per Supabase),
--     so we're not patching dirty state, just doing it correctly.
--
-- After applying this, click 'Acknowledge 2 historical failures' in the
-- Supabase migration runner to clear 175 and 176 from the failed list —
-- their schema goals are achieved here.
--
-- Record ownership unchanged from 175 + 176 plans.

BEGIN;

-- ===========================================================================
-- PART A — From migration 175 (AP sub-ledger), corrected
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A1) Extend vendors with AP-specific fields (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS default_gl_account_id UUID
  REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
-- 'category' already exists in vendors (mig 009), skip.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 30;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_1099_vendor BOOLEAN NOT NULL DEFAULT FALSE;
-- 'w9_on_file' already exists, skip.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w9_received_date DATE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tax_id TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payee_name TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_address_line1 TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_address_line2 TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_city TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_state TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_zip TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_manager_name TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_manager_email TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_manager_phone TEXT;

-- FIXED indexes — mgmt-co level, not community-scoped
CREATE INDEX IF NOT EXISTS idx_vendors_category_mgmt_active
  ON vendors (management_company_id, category) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_vendors_1099_mgmt
  ON vendors (management_company_id) WHERE is_1099_vendor = TRUE;
CREATE INDEX IF NOT EXISTS idx_vendors_name_lookup
  ON vendors (management_company_id, lower(name));

-- ---------------------------------------------------------------------------
-- A2) ap_invoices — canonical AP record (per-community since each invoice
--      is for a specific HOA, even though vendor is shared)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_invoices (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  vendor_id                     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  vendor_invoice_number         TEXT,
  invoice_date                  DATE NOT NULL,
  due_date                      DATE,
  terms                         TEXT,
  subtotal_cents                BIGINT NOT NULL DEFAULT 0,
  tax_cents                     BIGINT NOT NULL DEFAULT 0,
  total_cents                   BIGINT NOT NULL CHECK (total_cents > 0),
  amount_paid_cents             BIGINT NOT NULL DEFAULT 0
                                  CHECK (amount_paid_cents >= 0 AND amount_paid_cents <= total_cents),
  source_document_id            UUID REFERENCES library_documents(id) ON DELETE SET NULL,
  source_filename               TEXT,
  auto_coded                    BOOLEAN NOT NULL DEFAULT FALSE,
  auto_coding_confidence        TEXT
                                  CHECK (auto_coding_confidence IS NULL OR auto_coding_confidence IN ('high','medium','low','manual')),
  auto_coding_signal            TEXT,
  status                        TEXT NOT NULL DEFAULT 'awaiting_approval'
                                  CHECK (status IN (
                                    'awaiting_approval', 'approved', 'partially_paid',
                                    'paid', 'voided', 'disputed', 'on_hold'
                                  )),
  posting_journal_entry_id      UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  received_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by_user_id           UUID,
  approved_at                   TIMESTAMPTZ,
  approved_by_user_id           UUID,
  paid_at                       TIMESTAMPTZ,
  voided_at                     TIMESTAMPTZ,
  voided_by_user_id             UUID,
  voided_reason                 TEXT,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, vendor_id, vendor_invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_ap_invoices_community_status
  ON ap_invoices (community_id, status, due_date)
  WHERE status IN ('awaiting_approval', 'approved', 'partially_paid');
CREATE INDEX IF NOT EXISTS idx_ap_invoices_vendor
  ON ap_invoices (vendor_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_ap_invoices_due_unpaid
  ON ap_invoices (community_id, due_date)
  WHERE status IN ('approved', 'partially_paid');

DROP TRIGGER IF EXISTS trg_ap_invoices_updated_at ON ap_invoices;
CREATE TRIGGER trg_ap_invoices_updated_at
  BEFORE UPDATE ON ap_invoices
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- A3) ap_invoice_lines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_invoice_lines (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id                    UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  line_number                   INTEGER NOT NULL,
  description                   TEXT NOT NULL,
  quantity                      NUMERIC(12,3) DEFAULT 1,
  unit_price_cents              BIGINT,
  amount_cents                  BIGINT NOT NULL,
  gl_account_id                 UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  tax_amount_cents              BIGINT NOT NULL DEFAULT 0,
  is_taxable                    BOOLEAN NOT NULL DEFAULT FALSE,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_ap_lines_invoice
  ON ap_invoice_lines (invoice_id, line_number);
CREATE INDEX IF NOT EXISTS idx_ap_lines_account
  ON ap_invoice_lines (gl_account_id);

-- ---------------------------------------------------------------------------
-- A4) ap_invoice_approvals (workflow log)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_invoice_approvals (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id                    UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  action                        TEXT NOT NULL
                                  CHECK (action IN (
                                    'submitted', 'approved', 'rejected', 'requested_more_info',
                                    'reassigned', 'released_for_payment', 'voided'
                                  )),
  user_id                       UUID,
  user_name                     TEXT,
  amount_at_time_cents          BIGINT,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_approvals_invoice
  ON ap_invoice_approvals (invoice_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- A5) ap_payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_payments (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  vendor_id                     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  payment_date                  DATE NOT NULL,
  amount_cents                  BIGINT NOT NULL CHECK (amount_cents > 0),
  payment_method                TEXT NOT NULL
                                  CHECK (payment_method IN ('check', 'ach', 'wire', 'credit_card', 'cash', 'other')),
  check_number                  TEXT,
  bank_account_id               UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  posting_journal_entry_id      UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  status                        TEXT NOT NULL DEFAULT 'completed'
                                  CHECK (status IN ('pending', 'completed', 'voided', 'returned_nsf')),
  voided_at                     TIMESTAMPTZ,
  voided_reason                 TEXT,
  notes                         TEXT,
  created_by_user_id            UUID,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_payments_community
  ON ap_payments (community_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_ap_payments_vendor
  ON ap_payments (vendor_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_ap_payments_check
  ON ap_payments (bank_account_id, check_number) WHERE check_number IS NOT NULL;

DROP TRIGGER IF EXISTS trg_ap_payments_updated_at ON ap_payments;
CREATE TRIGGER trg_ap_payments_updated_at
  BEFORE UPDATE ON ap_payments
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- A6) ap_payment_applications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_payment_applications (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id                    UUID NOT NULL REFERENCES ap_payments(id) ON DELETE RESTRICT,
  invoice_id                    UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE RESTRICT,
  applied_cents                 BIGINT NOT NULL CHECK (applied_cents > 0),
  applied_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_ap_pay_apps_payment ON ap_payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS idx_ap_pay_apps_invoice ON ap_payment_applications (invoice_id);

-- ---------------------------------------------------------------------------
-- A7) v_ap_aging view
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_ap_aging CASCADE;
CREATE VIEW v_ap_aging AS
WITH open_invoices AS (
  SELECT
    i.community_id,
    i.vendor_id,
    i.id AS invoice_id,
    i.vendor_invoice_number,
    i.total_cents - i.amount_paid_cents AS balance_remaining_cents,
    i.due_date,
    (CURRENT_DATE - i.due_date) AS days_past_due,
    i.status
  FROM ap_invoices i
  WHERE i.status IN ('approved', 'partially_paid', 'awaiting_approval')
    AND (i.total_cents - i.amount_paid_cents) > 0
)
SELECT
  community_id, vendor_id,
  COUNT(*) AS open_invoice_count,
  SUM(balance_remaining_cents) AS total_balance_cents,
  SUM(CASE WHEN days_past_due <= 0  THEN balance_remaining_cents ELSE 0 END) AS current_cents,
  SUM(CASE WHEN days_past_due BETWEEN 1   AND 30 THEN balance_remaining_cents ELSE 0 END) AS bucket_1_30_cents,
  SUM(CASE WHEN days_past_due BETWEEN 31  AND 60 THEN balance_remaining_cents ELSE 0 END) AS bucket_31_60_cents,
  SUM(CASE WHEN days_past_due BETWEEN 61  AND 90 THEN balance_remaining_cents ELSE 0 END) AS bucket_61_90_cents,
  SUM(CASE WHEN days_past_due > 90 THEN balance_remaining_cents ELSE 0 END) AS over_90_cents
FROM open_invoices
GROUP BY community_id, vendor_id;

GRANT SELECT ON v_ap_aging TO anon, authenticated, service_role;

-- ===========================================================================
-- PART B — From migration 176 (check printing substrate), unchanged
-- ===========================================================================

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS next_check_number INTEGER NOT NULL DEFAULT 1000;

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS check_stock_format TEXT
  CHECK (check_stock_format IS NULL OR check_stock_format IN (
    'std_top','std_middle','std_bottom','voucher_top','three_per_page'
  )) DEFAULT 'std_top';

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS check_stock_vendor TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS check_stock_micr_pre_encoded BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS dual_sig_threshold_cents BIGINT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS signature_image_path TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS signature_image_path_secondary TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS authorized_signers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number_encrypted TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_format TEXT
  CHECK (positive_pay_format IS NULL OR positive_pay_format IN (
    'csv_standard','bai2','nacha','first_citizens','newfirst','columbia',
    'boa_cashpro','chase','wells_fargo','custom'
  ));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_submission_method TEXT
  CHECK (positive_pay_submission_method IS NULL OR positive_pay_submission_method IN (
    'sftp','portal_upload','email','api','manual'
  ));
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS positive_pay_credentials_ref TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS statement_format_hint TEXT;

CREATE TABLE IF NOT EXISTS check_register (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                    UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  bank_account_id                 UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  check_number                    TEXT NOT NULL,
  issue_date                      DATE NOT NULL,
  payee_name                      TEXT NOT NULL,
  amount_cents                    BIGINT NOT NULL CHECK (amount_cents > 0),
  amount_in_words                 TEXT NOT NULL,
  memo                            TEXT,
  status                          TEXT NOT NULL DEFAULT 'issued'
                                    CHECK (status IN ('issued','outstanding','cleared','voided','stop_payment','stale')),
  voided_at                       TIMESTAMPTZ,
  voided_by_user_id               UUID,
  voided_reason                   TEXT,
  cleared_date                    DATE,
  cleared_via_bank_statement_id   UUID REFERENCES bank_statement_imports(id) ON DELETE SET NULL,
  stop_payment_at                 TIMESTAMPTZ,
  stop_payment_reason             TEXT,
  ap_payment_id                   UUID REFERENCES ap_payments(id) ON DELETE SET NULL,
  posting_journal_entry_id        UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  bank_reconciliation_id          UUID REFERENCES bank_reconciliations(id) ON DELETE SET NULL,
  check_pdf_storage_path          TEXT,
  print_run_id                    UUID,
  printed_at                      TIMESTAMPTZ,
  printed_by_user_id              UUID,
  reprinted_count                 INTEGER NOT NULL DEFAULT 0,
  notes                           TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, check_number)
);

CREATE INDEX IF NOT EXISTS idx_check_register_account_status
  ON check_register (bank_account_id, status, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_check_register_outstanding
  ON check_register (bank_account_id, issue_date)
  WHERE status IN ('issued', 'outstanding');
CREATE INDEX IF NOT EXISTS idx_check_register_ap_payment
  ON check_register (ap_payment_id) WHERE ap_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_check_register_print_run
  ON check_register (print_run_id) WHERE print_run_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_check_register_updated_at ON check_register;
CREATE TRIGGER trg_check_register_updated_at
  BEFORE UPDATE ON check_register
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Race-safe check number sequencer
CREATE OR REPLACE FUNCTION reserve_next_check_number(p_bank_account_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_check_number INTEGER;
BEGIN
  UPDATE bank_accounts
  SET next_check_number = next_check_number + 1
  WHERE id = p_bank_account_id
  RETURNING next_check_number - 1 INTO v_check_number;
  IF v_check_number IS NULL THEN
    RAISE EXCEPTION 'bank_account_not_found: %', p_bank_account_id;
  END IF;
  RETURN v_check_number;
END;
$$ LANGUAGE plpgsql;

-- Seed Quail Ridge Operating bank account (per Ed's First Citizens statement)
DO $$
DECLARE
  v_qr_community_id UUID;
  v_first_citizens_bank_id UUID;
  v_existing UUID;
BEGIN
  SELECT id INTO v_qr_community_id FROM communities WHERE name ILIKE 'quail%ridge%' LIMIT 1;
  SELECT id INTO v_first_citizens_bank_id FROM banks
    WHERE management_company_id = '00000000-0000-0000-0000-000000000001'::uuid
      AND name = 'First Citizens Bank'
    LIMIT 1;

  IF v_qr_community_id IS NULL THEN
    RAISE NOTICE '[177] Quail Ridge community not found — skipping bank_account seed';
    RETURN;
  END IF;
  IF v_first_citizens_bank_id IS NULL THEN
    RAISE NOTICE '[177] First Citizens Bank not found in banks table';
    RETURN;
  END IF;

  SELECT id INTO v_existing FROM bank_accounts
    WHERE community_id = v_qr_community_id AND account_last4 = '4536' LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE bank_accounts SET
      bank_id = COALESCE(bank_id, v_first_citizens_bank_id),
      next_check_number = GREATEST(COALESCE(next_check_number, 29), 29),
      check_stock_format = COALESCE(check_stock_format, 'std_top'),
      check_stock_micr_pre_encoded = COALESCE(check_stock_micr_pre_encoded, TRUE),
      statement_format_hint = COALESCE(statement_format_hint, 'first_citizens')
    WHERE id = v_existing;
    RAISE NOTICE '[177] Quail Ridge Operating already exists — check config patched';
  ELSE
    INSERT INTO bank_accounts (
      management_company_id, community_id, bank_id,
      account_nickname, bank_name, account_last4,
      account_type, gl_account_number, is_active,
      next_check_number, check_stock_format, check_stock_micr_pre_encoded,
      statement_format_hint, notes
    ) VALUES (
      '00000000-0000-0000-0000-000000000001'::uuid,
      v_qr_community_id, v_first_citizens_bank_id,
      'Quail Ridge Operating', 'First Citizens Bank', '4536',
      'operating', '10100', TRUE,
      29, 'std_top', TRUE,
      'first_citizens',
      'CAB Interest Checking at First Citizens. 0.05% APY. Statement shows VANTACA PAYOUT entries (homeowner payments via Vantaca Pay).'
    );
    RAISE NOTICE '[177] Quail Ridge Operating bank account seeded (next check #29)';
  END IF;
END$$;

COMMIT;
