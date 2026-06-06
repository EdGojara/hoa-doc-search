-- 171: Budgets + financial-statement support tables
--
-- Phase 1.5: ship financial statements (BS, IS, Equity, Budget vs Actual)
-- for August Meadows before its first board meeting. Calendar-year fiscal
-- structure for all associations.
--
-- WHY THIS NOW (per Ed 2026-06-06):
--   August Meadows is already live (since 6/1). FS reports cannot wait for
--   the leisurely 9-month plan — first board packet is weeks away. The GL
--   substrate (migration 170) is shipped; FS reports are query layers on
--   top. This migration adds the budget table they pull from.
--
-- Record ownership: budgets = MIXED (board-approved budget = association_record;
-- budget drafting + adjustments = workpaper).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) community_budgets — one approved budget per community per fiscal year
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_budgets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  fiscal_year             INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'approved', 'active', 'archived')),
  approved_at             TIMESTAMPTZ,
  approved_by_user_id     UUID,
  notes                   TEXT,
  source_filename         TEXT,                              -- if imported from a PDF/Excel
  source_storage_path     TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, fiscal_year)
);

CREATE INDEX IF NOT EXISTS idx_community_budgets_active
  ON community_budgets (community_id, fiscal_year)
  WHERE status IN ('approved', 'active');

DROP TRIGGER IF EXISTS trg_community_budgets_updated_at ON community_budgets;
CREATE TRIGGER trg_community_budgets_updated_at
  BEFORE UPDATE ON community_budgets
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) budget_line_items — per-account budget with monthly breakouts
-- ---------------------------------------------------------------------------
-- monthly_amounts_cents is a 12-element array indexed 0=Jan ... 11=Dec.
-- Allows non-even allocations (insurance posts in January, special events in
-- the months they occur, etc.). When operator enters only annual_amount_cents,
-- we auto-split evenly across 12 months on save.
CREATE TABLE IF NOT EXISTS budget_line_items (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id                UUID NOT NULL REFERENCES community_budgets(id) ON DELETE CASCADE,
  account_id               UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  fund_id                  UUID REFERENCES account_funds(id) ON DELETE SET NULL,

  annual_amount_cents      BIGINT NOT NULL DEFAULT 0,
  monthly_amounts_cents    BIGINT[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0,0,0,0,0,0]::BIGINT[],

  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (budget_id, account_id),
  CHECK (cardinality(monthly_amounts_cents) = 12)
);

CREATE INDEX IF NOT EXISTS idx_budget_line_items_budget
  ON budget_line_items (budget_id);

CREATE INDEX IF NOT EXISTS idx_budget_line_items_account
  ON budget_line_items (account_id);

DROP TRIGGER IF EXISTS trg_budget_line_items_updated_at ON budget_line_items;
CREATE TRIGGER trg_budget_line_items_updated_at
  BEFORE UPDATE ON budget_line_items
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) Convenience view: current-year active budget per community
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_current_budgets CASCADE;
CREATE VIEW v_current_budgets AS
SELECT
  cb.id                AS budget_id,
  cb.community_id,
  cb.fiscal_year,
  cb.status            AS budget_status,
  bli.account_id,
  coa.account_number,
  coa.account_name,
  coa.account_type,
  coa.account_subtype,
  bli.fund_id,
  af.fund_code,
  bli.annual_amount_cents,
  bli.monthly_amounts_cents
FROM community_budgets cb
JOIN budget_line_items bli ON bli.budget_id = cb.id
JOIN chart_of_accounts coa ON coa.id = bli.account_id
LEFT JOIN account_funds af ON af.id = bli.fund_id
WHERE cb.status IN ('approved', 'active');

GRANT SELECT ON v_current_budgets TO anon, authenticated, service_role;

COMMIT;
