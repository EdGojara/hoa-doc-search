-- ============================================================================
-- 512_reserve_budget_projects.sql
-- ----------------------------------------------------------------------------
-- Reserve expenditures are planned capital PROJECTS, never a trend of prior
-- spending (Ed 2026-10-11). Each project in reserve_budget_items now carries:
--   account_id      the reserve GL account it is budgeted to (several projects may
--                   share one account; the formal budget and the financial
--                   statements use the per-account sums)
--   planned_month   expected timing, 1-12 within the fiscal year (null = not set)
--   review_status   'planned', or 'needs_review' for an amount carried from a saved
--                   budget that no project explains (kept, counted once, flagged;
--                   never treated as an approved project)
-- Existing rows keep their values; the new columns start null / 'planned'.
--
-- Record ownership: association_record (the HOA's reserve plan), as in 362.
-- Creates no journal entry, budget line or ledger row.
-- ============================================================================
BEGIN;

ALTER TABLE reserve_budget_items
  ADD COLUMN IF NOT EXISTS account_id    UUID,
  ADD COLUMN IF NOT EXISTS planned_month SMALLINT,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'planned';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reserve_budget_items_account_fkey') THEN
    ALTER TABLE reserve_budget_items ADD CONSTRAINT reserve_budget_items_account_fkey
      FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reserve_budget_items_planned_month_check') THEN
    ALTER TABLE reserve_budget_items ADD CONSTRAINT reserve_budget_items_planned_month_check
      CHECK (planned_month IS NULL OR planned_month BETWEEN 1 AND 12);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reserve_budget_items_review_status_check') THEN
    ALTER TABLE reserve_budget_items ADD CONSTRAINT reserve_budget_items_review_status_check
      CHECK (review_status IN ('planned', 'needs_review'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_reserve_budget_items_account ON reserve_budget_items (account_id);

COMMIT;
