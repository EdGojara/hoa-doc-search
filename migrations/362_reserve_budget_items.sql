-- ============================================================================
-- 362_reserve_budget_items.sql
-- ----------------------------------------------------------------------------
-- The RESERVE side of a community's annual budget: the planned capital
-- expenditure projects (Pool Area furniture, Tennis Court resurface, Entry
-- Monument, etc.). These come off the reserve sheet of an uploaded budget
-- workbook and are named projects WITHOUT GL account numbers, so they can't
-- live in budget_line_items (account_id NOT NULL). The operating budget stays
-- in budget_line_items; this table holds the reserve expenditure plan.
--
-- Record ownership: association_record — this is the HOA's own reserve plan,
-- handed over on termination.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS reserve_budget_items (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id          UUID NOT NULL REFERENCES communities(id),
  fiscal_year           INTEGER NOT NULL,
  project_name          TEXT NOT NULL,
  category              TEXT,                                       -- optional grouping (Pool, Gates, Landscape...)
  planned_amount_cents  BIGINT NOT NULL DEFAULT 0,
  note                  TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  -- Optional future link to a reserve-study component (RUL / funding). Nullable,
  -- SET NULL on delete so the budget line survives a reserve-study rebuild.
  reserve_component_id  UUID REFERENCES reserve_components(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserve_budget_items_community_year
  ON reserve_budget_items (community_id, fiscal_year);

-- updated_at maintenance (standard trigger fn used across the schema)
DROP TRIGGER IF EXISTS trg_reserve_budget_items_updated_at ON reserve_budget_items;
CREATE TRIGGER trg_reserve_budget_items_updated_at
  BEFORE UPDATE ON reserve_budget_items
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON reserve_budget_items TO service_role;
GRANT SELECT                          ON reserve_budget_items TO authenticated;

COMMIT;
