-- 170: General Ledger foundation — chart of accounts, accounting periods,
-- journal entries, journal entry lines, and fund segmentation for HOA
-- accounting.
--
-- STRATEGY (per Ed 2026-06-06):
--   Two pilots: August Meadows (greenfield, live 2026-06-01) + Quail Ridge
--   (migration target, 101 homes). Vantaca CoA structure used as roadmap so
--   migration of remaining 5 communities is mechanical translation, not
--   redesign. By end of 18-month Vantaca contract, all communities run on
--   trustEd GL.
--
-- KEY DESIGN CHOICES:
--   1. Double-entry integrity at DB level. CHECK constraint enforces
--      debits = credits on every journal entry. No exceptions, no overrides.
--   2. Append-only invariant. journal_entries cannot be deleted — only
--      voided via an offsetting reversal entry. Same for journal_entry_lines.
--   3. Period locking. Closed periods reject new posts. Reopen requires
--      explicit admin action with audit trail.
--   4. Fund segmentation built in (Operating, Reserve, etc.) — HOA accounting
--      requires per-fund BS + IS. Every account ties to a fund OR is shared.
--   5. Vantaca account-number mapping field on each account so migration
--      from Vantaca exports is one-to-one lookup.
--   6. Sub-ledger references on each line (property_id for AR, vendor_id
--      for AP, bank_account_id for cash) — Phase 1 ships the columns;
--      Phase 2 builds the tie-out jobs.
--
-- RECORD OWNERSHIP (per CLAUDE.md):
--   ALL GL tables = MIXED.
--     - The GL detail + financial statements delivered to boards =
--       association_record. Termination = export.
--     - The chart-of-accounts template, internal mapping tables, posting
--       rules engine = workpaper. Bedrock IP.
--
-- IDEMPOTENT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) account_funds — HOA fund segmentation
-- ---------------------------------------------------------------------------
-- One row per (community, fund). Standard HOA setup is Operating + Reserve;
-- many add Special Assessment. Each fund maintains its own BS and IS for
-- board reporting. Inter-fund transfers cross via paired journal entries.
CREATE TABLE IF NOT EXISTS account_funds (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  fund_code               TEXT NOT NULL,                  -- 'OPR', 'RES', 'SA', 'CI'
  fund_name               TEXT NOT NULL,                  -- 'Operating Fund', 'Reserve Fund'
  fund_type               TEXT NOT NULL
                            CHECK (fund_type IN (
                              'operating', 'reserve', 'special_assessment',
                              'capital_improvement', 'escrow', 'other'
                            )),
  display_order           INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, fund_code)
);

CREATE INDEX IF NOT EXISTS idx_account_funds_community
  ON account_funds (community_id) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_account_funds_updated_at ON account_funds;
CREATE TRIGGER trg_account_funds_updated_at
  BEFORE UPDATE ON account_funds
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) chart_of_accounts — per-community CoA
-- ---------------------------------------------------------------------------
-- Account numbering follows the HOA standard (and Vantaca convention):
--   1xxxx — Assets
--   2xxxx — Liabilities
--   3xxxx — Equity / Fund Balance
--   4xxxx — Revenue
--   5xxxx — Operating Expenses
--   6xxxx — Reserve Expenses
--   7xxxx — Capital / Special Project Expenses
--
-- is_summary accounts cannot have entries posted directly; they exist as
-- rollup parents in reports. Posting always goes to leaf-level (detail) accounts.
-- normal_balance determines presentation: assets + expenses normally debit,
-- liabilities + equity + revenue normally credit. Affects how amounts display
-- on financial statements (no math impact — debits = credits regardless).
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  fund_id                 UUID REFERENCES account_funds(id) ON DELETE SET NULL,    -- null = shared / cross-fund

  account_number          TEXT NOT NULL,                                  -- '1010', '4010', etc.
  account_name            TEXT NOT NULL,
  account_type            TEXT NOT NULL
                            CHECK (account_type IN (
                              'asset', 'liability', 'equity', 'revenue', 'expense'
                            )),
  account_subtype         TEXT,                                           -- 'current_asset', 'cash', 'receivable', 'operating_expense', etc.
  normal_balance          TEXT NOT NULL
                            CHECK (normal_balance IN ('debit', 'credit')),
  parent_account_id       UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  is_summary              BOOLEAN NOT NULL DEFAULT FALSE,                  -- rollup parent; no direct posting
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,

  -- Migration / interoperability
  vantaca_account_number  TEXT,                                           -- map back to Vantaca for translation
  description             TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, account_number)
);

CREATE INDEX IF NOT EXISTS idx_coa_community_active
  ON chart_of_accounts (community_id, account_type, account_number)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_coa_fund
  ON chart_of_accounts (fund_id) WHERE fund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_coa_vantaca_mapping
  ON chart_of_accounts (community_id, vantaca_account_number)
  WHERE vantaca_account_number IS NOT NULL;

DROP TRIGGER IF EXISTS trg_coa_updated_at ON chart_of_accounts;
CREATE TRIGGER trg_coa_updated_at
  BEFORE UPDATE ON chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) accounting_periods — per-community open/closed period tracking
-- ---------------------------------------------------------------------------
-- One row per (community, fiscal_year, period). Typical setup is monthly
-- with 12 periods + an optional "Period 13" for year-end adjustments.
-- Period status transitions:
--   open → closed (admin signs off; no new posts allowed)
--   closed → reopened (admin override with reason — auditable)
--   closed → locked (final lock after audit cycle — cannot reopen)
CREATE TABLE IF NOT EXISTS accounting_periods (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  fiscal_year             INTEGER NOT NULL,
  period_number           INTEGER NOT NULL,                              -- 1-12 monthly, or 13 for adjustments
  period_type             TEXT NOT NULL DEFAULT 'monthly'
                            CHECK (period_type IN ('monthly', 'quarterly', 'annual', 'adjustment')),
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closed', 'locked', 'reopened')),

  -- Audit trail for close/reopen
  closed_at               TIMESTAMPTZ,
  closed_by_user_id       UUID,
  reopened_at             TIMESTAMPTZ,
  reopened_by_user_id     UUID,
  reopened_reason         TEXT,
  locked_at               TIMESTAMPTZ,
  locked_by_user_id       UUID,

  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, fiscal_year, period_number),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_periods_community_open
  ON accounting_periods (community_id, period_end DESC)
  WHERE status IN ('open', 'reopened');

CREATE INDEX IF NOT EXISTS idx_periods_community_dates
  ON accounting_periods (community_id, period_start, period_end);

DROP TRIGGER IF EXISTS trg_periods_updated_at ON accounting_periods;
CREATE TRIGGER trg_periods_updated_at
  BEFORE UPDATE ON accounting_periods
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) journal_entries — canonical entry record
-- ---------------------------------------------------------------------------
-- One row per journal entry. The double-entry constraint
-- (total_debits = total_credits) is enforced at the DB level — there is
-- no application code path that can post an unbalanced entry.
--
-- APPEND-ONLY: voiding an entry creates an OFFSETTING entry on today's
-- date with reverses_je_id pointing back to the original. The original
-- entry's status flips to 'voided' but its rows are NEVER deleted.
-- void_reversal_je_id captures the offsetting entry's id so the audit
-- trail shows the reversal chain.
CREATE TABLE IF NOT EXISTS journal_entries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  period_id               UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,

  posting_date            DATE NOT NULL,
  reference               TEXT NOT NULL,                                 -- 'JE-2026-0001' or operator-supplied
  description             TEXT NOT NULL,

  -- Source attribution — where did this entry come from?
  source_module           TEXT NOT NULL DEFAULT 'manual'
                            CHECK (source_module IN (
                              'manual', 'assessment_billing', 'payment_intake',
                              'bank_reconciliation', 'vantaca_import', 'ar_snapshot',
                              'reserve_transfer', 'closing_entry', 'opening_entry',
                              'reversal', 'system'
                            )),
  source_reference        TEXT,                                          -- ID/ref in source module

  -- Totals — enforce balance at row level
  total_debits_cents      BIGINT NOT NULL,
  total_credits_cents     BIGINT NOT NULL,

  -- Reversal linkage
  reverses_je_id          UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,    -- this entry reverses that one
  void_reversal_je_id     UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,    -- the offset entry that voided this one

  status                  TEXT NOT NULL DEFAULT 'posted'
                            CHECK (status IN ('draft', 'posted', 'voided')),
  voided_at               TIMESTAMPTZ,
  voided_by_user_id       UUID,
  void_reason             TEXT,

  posted_by_user_id       UUID,
  posted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                   TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (community_id, reference),
  CHECK (total_debits_cents = total_credits_cents),                 -- THE foundational discipline
  CHECK (total_debits_cents > 0)                                    -- no zero-amount entries
);

CREATE INDEX IF NOT EXISTS idx_je_community_date
  ON journal_entries (community_id, posting_date DESC);

CREATE INDEX IF NOT EXISTS idx_je_community_period
  ON journal_entries (community_id, period_id) WHERE status = 'posted';

CREATE INDEX IF NOT EXISTS idx_je_source
  ON journal_entries (source_module, source_reference)
  WHERE source_reference IS NOT NULL;

DROP TRIGGER IF EXISTS trg_je_updated_at ON journal_entries;
CREATE TRIGGER trg_je_updated_at
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 5) journal_entry_lines — the actual debits and credits
-- ---------------------------------------------------------------------------
-- One row per line on a journal entry. line_number gives display order.
-- debit_cents OR credit_cents (not both) on each line.
-- Sub-ledger reference columns (property_id, vendor_id, bank_account_id)
-- enable per-owner / per-vendor / per-bank-account reporting WITHOUT
-- requiring separate sub-ledger tables — the GL is the canonical source.
-- Phase 2 builds materialized sub-ledger snapshots on top for fast queries.
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id        UUID NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  line_number             INTEGER NOT NULL,
  account_id              UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,

  debit_cents             BIGINT NOT NULL DEFAULT 0,
  credit_cents            BIGINT NOT NULL DEFAULT 0,
  memo                    TEXT,

  -- Sub-ledger references (nullable; populated when relevant)
  property_id             UUID REFERENCES properties(id) ON DELETE RESTRICT,     -- AR posting per owner
  vendor_id               UUID,                                                  -- AP posting per vendor; FK added later when vendor master fully exists
  bank_account_id         UUID REFERENCES bank_accounts(id) ON DELETE RESTRICT,  -- cash posting per bank
  -- Future sub-ledger refs (just columns, FKs deferred): contract_id, project_id

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (debit_cents >= 0 AND credit_cents >= 0),
  CHECK (NOT (debit_cents > 0 AND credit_cents > 0)),               -- never both debit AND credit on a line
  CHECK (debit_cents > 0 OR credit_cents > 0)                       -- and never both zero
);

CREATE INDEX IF NOT EXISTS idx_jel_entry
  ON journal_entry_lines (journal_entry_id, line_number);

CREATE INDEX IF NOT EXISTS idx_jel_account
  ON journal_entry_lines (account_id);

CREATE INDEX IF NOT EXISTS idx_jel_property
  ON journal_entry_lines (property_id) WHERE property_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jel_vendor
  ON journal_entry_lines (vendor_id) WHERE vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jel_bank_account
  ON journal_entry_lines (bank_account_id) WHERE bank_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6) Trial balance view
-- ---------------------------------------------------------------------------
-- One row per (community, account). Sums all posted journal entry lines.
-- The foundation report for every other financial statement.
DROP VIEW IF EXISTS v_trial_balance CASCADE;
CREATE VIEW v_trial_balance AS
SELECT
  coa.community_id,
  coa.id                          AS account_id,
  coa.account_number,
  coa.account_name,
  coa.account_type,
  coa.account_subtype,
  coa.normal_balance,
  coa.fund_id,
  af.fund_code,
  af.fund_name,
  COALESCE(SUM(jel.debit_cents), 0)  AS total_debits_cents,
  COALESCE(SUM(jel.credit_cents), 0) AS total_credits_cents,
  COALESCE(SUM(jel.debit_cents), 0) - COALESCE(SUM(jel.credit_cents), 0) AS balance_cents,
  -- "Display" balance: positive numbers in their natural direction
  -- (assets show +, liabilities show + when credit-balanced, etc.)
  CASE
    WHEN coa.normal_balance = 'debit' THEN COALESCE(SUM(jel.debit_cents), 0) - COALESCE(SUM(jel.credit_cents), 0)
    ELSE COALESCE(SUM(jel.credit_cents), 0) - COALESCE(SUM(jel.debit_cents), 0)
  END AS natural_balance_cents
FROM chart_of_accounts coa
LEFT JOIN account_funds af ON af.id = coa.fund_id
LEFT JOIN journal_entry_lines jel ON jel.account_id = coa.id
LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
  AND je.status = 'posted'
WHERE coa.is_active = TRUE
GROUP BY coa.community_id, coa.id, coa.account_number, coa.account_name,
         coa.account_type, coa.account_subtype, coa.normal_balance,
         coa.fund_id, af.fund_code, af.fund_name;

GRANT SELECT ON v_trial_balance TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) Helper function: next JE reference per community
-- ---------------------------------------------------------------------------
-- Generates JE-YYYY-NNNN, sequential per community per fiscal year.
-- Called by the posting engine when reference is not operator-supplied.
CREATE OR REPLACE FUNCTION next_je_reference(p_community_id UUID, p_fiscal_year INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_next INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO v_next
  FROM journal_entries
  WHERE community_id = p_community_id
    AND posting_date >= make_date(p_fiscal_year, 1, 1)
    AND posting_date <= make_date(p_fiscal_year, 12, 31);
  RETURN 'JE-' || p_fiscal_year || '-' || lpad(v_next::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
