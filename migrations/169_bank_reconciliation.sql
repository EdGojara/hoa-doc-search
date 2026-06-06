-- 169: Bank Reconciliation module — full three-way rec (bank statement +
-- check register + GL) with matching, exceptions, and cheat-sheet export.
--
-- STRATEGY (per Ed 2026-06-06):
-- Today: trustEd produces the rec; operator manually enters it into
-- Vantaca's rec module to keep their books current. The cheat sheet
-- cuts that data-entry from ~30 min to ~5 min.
-- Tomorrow: when trustEd holds the full GL mirror, the Vantaca step
-- drops out entirely. This module is one tile in the back-office-
-- independence mosaic.
--
-- RECORD OWNERSHIP (per CLAUDE.md):
--   bank_accounts, bank_statement_imports, bank_statement_transactions,
--   bank_reconciliations, bank_reconciliation_items — ALL mixed:
--     - Bank statements + the rec they produce are association_record
--       (HOA's financial records). At termination they hand over.
--     - The matching algorithm output + exception classification + cheat
--       sheet formatting = workpaper (Bedrock IP).
--   Export tool filters at termination time.
--
-- BUILDS ON:
--   Migration 168 (vantaca_imports) — check register + GL flow through
--   that table. This migration adds 'check_register' as an allowed
--   report_type and links bank recs back to the source imports.
--
-- IDEMPOTENT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Extend vantaca_imports.report_type to allow check_register
-- ---------------------------------------------------------------------------
-- Existing CHECK constraint from 168 doesn't include 'check_register'.
-- Drop + re-add. The constraint name from 168 was auto-generated; the
-- ALTER syntax below handles it via column re-definition.
ALTER TABLE vantaca_imports
  DROP CONSTRAINT IF EXISTS vantaca_imports_report_type_check;

ALTER TABLE vantaca_imports
  ADD CONSTRAINT vantaca_imports_report_type_check
  CHECK (report_type IS NULL OR report_type IN (
    'ar_aging',
    'gl_export',
    'ap_ledger',
    'bank_reconciliation',
    'check_register',          -- NEW — list of checks issued in a period
    'owner_statement',
    'vendor_history',
    'budget_actual',
    'unknown'
  ));

-- ---------------------------------------------------------------------------
-- 2) bank_accounts — per-community bank account config
-- ---------------------------------------------------------------------------
-- One row per (community, real-world bank account). Operator names them
-- ("Operating BoA Checking", "Reserve Wells Fargo Money Market"). Phase 1
-- doesn't require pre-populating these — the rec workflow auto-creates a
-- row on first use if it doesn't exist.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id UUID NOT NULL REFERENCES management_companies(id),
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  account_nickname      TEXT NOT NULL,                          -- "Operating BoA"
  bank_name             TEXT,                                   -- "Bank of America"
  account_last4         TEXT,                                   -- "1234" (last 4 digits)
  account_type          TEXT
                          CHECK (account_type IN (
                            'operating', 'reserve', 'special_assessment',
                            'capital_improvement', 'escrow', 'other'
                          ))
                          DEFAULT 'operating',
  gl_account_number     TEXT,                                   -- Vantaca cash GL # this account ties to
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_community
  ON bank_accounts (community_id) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_bank_accounts_updated_at ON bank_accounts;
CREATE TRIGGER trg_bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) bank_statement_imports — uploaded bank statements (NOT Vantaca-sourced)
-- ---------------------------------------------------------------------------
-- Parallel to vantaca_imports in shape. Separate table because banks
-- aren't Vantaca; honest naming discipline. The bank rec workflow joins
-- both audit trails.
CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL REFERENCES management_companies(id),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  bank_account_id             UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,

  statement_period_start      DATE,
  statement_period_end        DATE,
  beginning_balance_cents     BIGINT,
  ending_balance_cents        BIGINT,
  total_deposits_cents        BIGINT,
  total_withdrawals_cents     BIGINT,
  total_fees_cents            BIGINT,
  total_interest_cents        BIGINT,

  source_filename             TEXT,
  source_storage_path         TEXT,
  source_sha256               TEXT,
  source_file_size_bytes      BIGINT,
  source_file_mime            TEXT,

  extraction_raw              JSONB,
  extraction_warnings         TEXT[],

  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN (
                                  'pending', 'processing', 'completed', 'failed', 'voided'
                                )),

  imported_by_user_id         UUID,
  imported_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_imports_community_period
  ON bank_statement_imports (community_id, statement_period_end DESC NULLS LAST)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_bank_statement_imports_account
  ON bank_statement_imports (bank_account_id, statement_period_end DESC NULLS LAST)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_bank_statement_imports_sha
  ON bank_statement_imports (source_sha256) WHERE source_sha256 IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bank_statement_imports_updated_at ON bank_statement_imports;
CREATE TRIGGER trg_bank_statement_imports_updated_at
  BEFORE UPDATE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) bank_statement_transactions — extracted line items per statement
-- ---------------------------------------------------------------------------
-- One row per transaction line. amount_cents is SIGNED:
--   - positive for deposits / credits / interest in
--   - negative for checks / withdrawals / fees / ACH out
-- transaction_type lets the matcher quickly partition by kind without
-- re-running NLP on the description.
CREATE TABLE IF NOT EXISTS bank_statement_transactions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_statement_import_id    UUID NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
  posting_date                DATE NOT NULL,
  amount_cents                BIGINT NOT NULL,                 -- signed
  description                 TEXT,
  check_number                TEXT,                            -- normalized to digits-only string when extracted; null if not a check
  transaction_type            TEXT
                                CHECK (transaction_type IN (
                                  'deposit', 'check', 'withdrawal', 'fee',
                                  'interest', 'ach_in', 'ach_out', 'wire_in',
                                  'wire_out', 'transfer', 'nsf', 'adjustment', 'other'
                                )),
  raw_extracted_text          TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_transactions_import
  ON bank_statement_transactions (bank_statement_import_id, posting_date);

CREATE INDEX IF NOT EXISTS idx_bank_statement_transactions_check
  ON bank_statement_transactions (bank_statement_import_id, check_number)
  WHERE check_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) bank_reconciliations — one rec attempt per (account, period)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id           UUID NOT NULL REFERENCES management_companies(id),
  community_id                    UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  bank_account_id                 UUID REFERENCES bank_accounts(id) ON DELETE RESTRICT,

  period_end                      DATE NOT NULL,
  period_start                    DATE,

  -- Source linkages (nullable until each input is attached)
  bank_statement_import_id        UUID REFERENCES bank_statement_imports(id) ON DELETE SET NULL,
  check_register_import_id        UUID REFERENCES vantaca_imports(id) ON DELETE SET NULL,
  gl_import_id                    UUID REFERENCES vantaca_imports(id) ON DELETE SET NULL,

  -- Summary numbers — populated after matching runs
  bank_ending_balance_cents       BIGINT,
  gl_ending_balance_cents         BIGINT,
  outstanding_checks_total_cents  BIGINT NOT NULL DEFAULT 0,
  deposits_in_transit_total_cents BIGINT NOT NULL DEFAULT 0,
  bank_only_adjustments_cents     BIGINT NOT NULL DEFAULT 0,   -- bank fees, interest, NSF not on GL
  gl_only_adjustments_cents       BIGINT NOT NULL DEFAULT 0,
  manual_adjustments_cents        BIGINT NOT NULL DEFAULT 0,

  -- Calculated:
  --   reconciled_balance = bank_ending - outstanding_checks + DIT + bank_only_adjustments
  --   difference = reconciled_balance - gl_ending
  -- Zero difference = balanced. Non-zero = needs investigation.
  reconciled_balance_cents        BIGINT,
  difference_cents                BIGINT,

  status                          TEXT NOT NULL DEFAULT 'in_progress'
                                    CHECK (status IN (
                                      'in_progress',         -- inputs being attached / matched
                                      'reconciled',          -- balanced (difference = 0)
                                      'unbalanced',          -- difference != 0, operator reviewing
                                      'exported_to_vantaca', -- operator entered the rec into Vantaca
                                      'voided'
                                    )),
  notes                           TEXT,
  prepared_by_user_id             UUID,
  prepared_at                     TIMESTAMPTZ,
  exported_at                     TIMESTAMPTZ,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_community_period
  ON bank_reconciliations (community_id, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_account_period
  ON bank_reconciliations (bank_account_id, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_status_workflow
  ON bank_reconciliations (status, period_end DESC)
  WHERE status IN ('in_progress', 'unbalanced');

DROP TRIGGER IF EXISTS trg_bank_reconciliations_updated_at ON bank_reconciliations;
CREATE TRIGGER trg_bank_reconciliations_updated_at
  BEFORE UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 6) bank_reconciliation_items — line-item match results
-- ---------------------------------------------------------------------------
-- One row per line item in the rec. Category determines which "side" of
-- the rec calculation it belongs to:
--   matched          — found on both bank and check register (or GL); no
--                       impact on the rec, just provenance
--   outstanding_check— issued in register, not yet cleared by bank
--   deposit_in_transit— on GL deposit side, not yet on bank statement
--   bank_only        — on bank statement, not on GL (fees, interest, NSF)
--   gl_only          — on GL, not on bank (timing or error — flag for review)
--   manual_adjustment— operator-entered correction
CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id               UUID NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  category                        TEXT NOT NULL
                                    CHECK (category IN (
                                      'matched', 'outstanding_check', 'deposit_in_transit',
                                      'bank_only', 'gl_only', 'manual_adjustment'
                                    )),
  amount_cents                    BIGINT NOT NULL,             -- signed
  date_ref                        DATE,
  description                     TEXT,
  check_number                    TEXT,

  -- Provenance — at most one of these is set per item
  bank_transaction_id             UUID REFERENCES bank_statement_transactions(id) ON DELETE SET NULL,
  check_register_ref              TEXT,                        -- check# from register, since we extract checks as JSON not separate table for now
  gl_ref                          TEXT,                        -- GL entry ref id from extraction

  match_confidence                TEXT
                                    CHECK (match_confidence IS NULL OR match_confidence IN ('high', 'medium', 'low', 'manual')),
  match_method                    TEXT,                        -- 'check_number_exact', 'amount_date_proximity', 'manual'
  operator_notes                  TEXT,
  reviewed_by_user_id             UUID,
  reviewed_at                     TIMESTAMPTZ,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_recon_items_rec_category
  ON bank_reconciliation_items (reconciliation_id, category);

CREATE INDEX IF NOT EXISTS idx_bank_recon_items_check
  ON bank_reconciliation_items (reconciliation_id, check_number)
  WHERE check_number IS NOT NULL;

DROP TRIGGER IF EXISTS trg_bank_recon_items_updated_at ON bank_reconciliation_items;
CREATE TRIGGER trg_bank_recon_items_updated_at
  BEFORE UPDATE ON bank_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMIT;
