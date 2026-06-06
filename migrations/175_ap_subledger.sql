-- 175: Accounts Payable sub-ledger — vendor invoices, GL coding, approval
-- workflow, payment tracking.
--
-- BUILDS THE WORKFLOW (per Ed 2026-06-06):
--   Drop invoice PDF → AI extract → auto-code GL → auto-post JE
--   → land in approval queue → operator approves → payment run → check prints
--
-- BUILDS ON:
--   - vendors table (existing, from migration 009) — extended here with AP fields
--   - migration 170 (GL foundation) — uses posting engine for JE
--   - migration 173 (banks master) — payment runs select bank account from here
--
-- RECORD OWNERSHIP (per CLAUDE.md):
--   ap_invoices + ap_invoice_lines = association_record. The HOA's bills.
--   ap_invoice_approvals (workflow log) = mixed: who approved what is
--     auditable for the association; Bedrock's internal routing rules =
--     workpaper.
--
-- IDEMPOTENT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Extend vendors table with AP-specific fields
-- ---------------------------------------------------------------------------
-- Existing vendors table (migration 009) has name + community_id + basics.
-- Add the columns AP needs for auto-coding, payment, and 1099 reporting.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS category TEXT;
-- category values mirror what the auto-coding engine maps to GL accounts:
-- landscaping, pool, janitorial, security, utilities_electric, utilities_water,
-- utilities_gas, utilities_trash, insurance, management, legal, audit_tax,
-- repairs, supplies, postage, other

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS default_gl_account_id UUID
  REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
-- The GL account this vendor's invoices are typically coded to. After 3+
-- invoices coded to the same account, the system can suggest setting this.

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 30;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_1099_vendor BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w9_on_file BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w9_received_date DATE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tax_id TEXT;        -- EIN or SSN — sensitive; encrypt in app layer

-- Remit address (where checks get mailed; may differ from vendor's business address)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS payee_name TEXT;    -- name on check face (may differ from legal name)
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_address_line1 TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_address_line2 TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_city TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_state TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS remit_zip TEXT;

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_manager_name TEXT;     -- vendor-side rep
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_manager_email TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS account_manager_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_vendors_category_active
  ON vendors (community_id, category) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_vendors_1099
  ON vendors (community_id) WHERE is_1099_vendor = TRUE;

-- ---------------------------------------------------------------------------
-- 2) ap_invoices — the canonical AP record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ap_invoices (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  vendor_id                     UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,

  -- Vendor-side invoice identifiers (what's printed on their bill)
  vendor_invoice_number         TEXT,
  invoice_date                  DATE NOT NULL,
  due_date                      DATE,
  terms                         TEXT,                            -- 'Net 30', 'Due on Receipt', etc.

  -- Money (cents, like everywhere else)
  subtotal_cents                BIGINT NOT NULL DEFAULT 0,
  tax_cents                     BIGINT NOT NULL DEFAULT 0,
  total_cents                   BIGINT NOT NULL CHECK (total_cents > 0),
  amount_paid_cents             BIGINT NOT NULL DEFAULT 0
                                  CHECK (amount_paid_cents >= 0 AND amount_paid_cents <= total_cents),

  -- Source document (the PDF)
  source_document_id            UUID REFERENCES library_documents(id) ON DELETE SET NULL,
  source_filename               TEXT,

  -- Auto-coding provenance
  auto_coded                    BOOLEAN NOT NULL DEFAULT FALSE,
  auto_coding_confidence        TEXT
                                  CHECK (auto_coding_confidence IS NULL OR auto_coding_confidence IN ('high','medium','low','manual')),
  auto_coding_signal            TEXT,                            -- 'vendor_default', 'vendor_category', 'description_nlp', etc.

  -- Workflow status
  status                        TEXT NOT NULL DEFAULT 'awaiting_approval'
                                  CHECK (status IN (
                                    'awaiting_approval',  -- new — needs approver action
                                    'approved',           -- approved, awaiting payment
                                    'partially_paid',
                                    'paid',
                                    'voided',
                                    'disputed',
                                    'on_hold'
                                  )),

  -- GL linkage — the JE that recorded this payable
  posting_journal_entry_id      UUID REFERENCES journal_entries(id) ON DELETE SET NULL,

  -- Workflow attribution
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

  -- Per-vendor invoice# uniqueness: same vendor can't bill the same invoice
  -- number twice (dedup safety). community-scoped because two communities
  -- might have legitimately separate invoices from the same vendor with
  -- the same number.
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
-- 3) ap_invoice_lines — line-level detail (one row per invoice line)
-- ---------------------------------------------------------------------------
-- Each line gets its own GL account so split-coded invoices work naturally
-- (rare for HOA but common at scale — split a utility bill across two
-- properties, etc.). Sum of line amounts equals invoice subtotal.
CREATE TABLE IF NOT EXISTS ap_invoice_lines (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id                    UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  line_number                   INTEGER NOT NULL,

  description                   TEXT NOT NULL,
  quantity                      NUMERIC(12,3) DEFAULT 1,
  unit_price_cents              BIGINT,
  amount_cents                  BIGINT NOT NULL,                 -- line total in cents (signed allowed for credits)

  -- GL coding — may be null until auto-coder runs or operator picks
  gl_account_id                 UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  -- Tax handling (some HOA vendors add sales tax)
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
-- 4) ap_invoice_approvals — workflow log
-- ---------------------------------------------------------------------------
-- One row per approval event. Append-only audit trail of who did what.
-- Supports multi-step approval workflow (Bedrock manager → board treasurer
-- for high-$ items) when Phase 2 adds dual-approval.
CREATE TABLE IF NOT EXISTS ap_invoice_approvals (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id                    UUID NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  action                        TEXT NOT NULL
                                  CHECK (action IN (
                                    'submitted',           -- intake completed, awaiting approval
                                    'approved',
                                    'rejected',
                                    'requested_more_info',
                                    'reassigned',
                                    'released_for_payment',
                                    'voided'
                                  )),
  user_id                       UUID,
  user_name                     TEXT,                            -- snapshot at action time (in case user later renamed/deleted)
  amount_at_time_cents          BIGINT,                          -- audit: was the amount changed after approval?
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ap_approvals_invoice
  ON ap_invoice_approvals (invoice_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5) ap_payments — payment records (cash going out to vendors)
-- ---------------------------------------------------------------------------
-- One row per payment to a vendor. payment_method='check' will FK to the
-- check_register row (built when check printing ships). For now, manual
-- ACH / wire / cash payments use this table directly.
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

  -- GL linkage
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
-- 6) ap_payment_applications — which payment paid which invoice
-- ---------------------------------------------------------------------------
-- Mirror of ar_payment_applications. One row per (payment, invoice) pair
-- with applied_cents. Lets one check pay multiple invoices (common — combine
-- several open invoices into one check to the same vendor).
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
-- 7) v_ap_aging — open AP aging per community
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

COMMIT;
