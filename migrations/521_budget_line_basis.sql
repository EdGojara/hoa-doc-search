-- ============================================================================
-- 521_budget_line_basis.sql  (Ed 2026-10-14)
-- ----------------------------------------------------------------------------
-- WHY: a budget line's amount had no structured "why". Canyon Gate's 2027 draft
-- recorded its sourcing only in free-text notes; schedule_basis was null on all
-- 77 lines. A board (and Kat) must be able to see, per line, whether an amount is
-- a contract, a forecast from history, a board-approved project, a discretionary
-- allowance, the assessment, or an interfund transfer, the arithmetic, the source,
-- and whether it still needs review.
--
-- CHANGE (smallest; no new module): six nullable / defaulted columns on
-- budget_line_items, plus one trigger so a recorded basis can never silently
-- describe an amount it no longer explains:
--   amount_basis        contract | historical_forecast | board_project |
--                       discretionary | assessment | transfer
--   amount_calc         the arithmetic in words ("$5,200/mo x 12")
--   vendor_contract_id  the contract that sets the amount (ON DELETE SET NULL)
--   source_document_id  the library document behind it (ON DELETE SET NULL)
--   needs_review        true for an unverified contract, an estimate, a pending notice
--   review_note         what needs review, in words
-- When a line's annual amount changes and its basis is not rewritten in the same
-- update, the line is marked needs_review with the old and new amounts.
--
-- Record ownership: association_record (part of the budget line, like notes).
-- No existing amount, month, status, budget header, GL account or balance is
-- changed. ADD COLUMN fires no row trigger, so the migration 462 lock is untouched
-- and still blocks every change to an approved budget's lines.
-- ============================================================================

BEGIN;

ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS amount_basis text;
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS amount_calc text;
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS vendor_contract_id uuid REFERENCES vendor_contracts(id) ON DELETE SET NULL;
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES library_documents(id) ON DELETE SET NULL;
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE budget_line_items ADD COLUMN IF NOT EXISTS review_note text;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_line_items_amount_basis_check') THEN
    ALTER TABLE budget_line_items ADD CONSTRAINT budget_line_items_amount_basis_check
      CHECK (amount_basis IS NULL OR amount_basis IN ('contract', 'historical_forecast', 'board_project', 'discretionary', 'assessment', 'transfer'));
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS idx_budget_line_items_vendor_contract ON budget_line_items (vendor_contract_id) WHERE vendor_contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budget_line_items_source_document ON budget_line_items (source_document_id) WHERE source_document_id IS NOT NULL;

COMMENT ON COLUMN budget_line_items.amount_basis IS 'Why the amount is what it is: contract | historical_forecast | board_project | discretionary | assessment | transfer.';
COMMENT ON COLUMN budget_line_items.amount_calc IS 'The arithmetic behind the amount, in words (e.g. "$5,200/mo x 12").';
COMMENT ON COLUMN budget_line_items.vendor_contract_id IS 'The vendor contract that sets the amount (contract lines).';
COMMENT ON COLUMN budget_line_items.source_document_id IS 'The library document the amount comes from (the contract, notice or quote).';
COMMENT ON COLUMN budget_line_items.needs_review IS 'True while the amount rests on an unverified contract, an estimate or a pending notice, or changed after its basis was recorded.';
COMMENT ON COLUMN budget_line_items.review_note IS 'What needs review, in words.';

-- A recorded basis never silently describes an amount it no longer explains.
CREATE OR REPLACE FUNCTION budget_line_items_basis_stale() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.annual_amount_cents IS DISTINCT FROM OLD.annual_amount_cents
     AND OLD.amount_basis IS NOT NULL
     AND NEW.amount_basis IS NOT DISTINCT FROM OLD.amount_basis
     AND NEW.amount_calc IS NOT DISTINCT FROM OLD.amount_calc THEN
    NEW.needs_review := true;
    NEW.review_note := concat_ws(' ', NULLIF(OLD.review_note, ''),
      format('Amount changed from $%s to $%s after the basis was recorded; the basis describes the earlier amount.',
        to_char(OLD.annual_amount_cents / 100.0, 'FM999,999,999,990.00'), to_char(NEW.annual_amount_cents / 100.0, 'FM999,999,999,990.00')));
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_budget_line_items_basis_stale ON budget_line_items;
CREATE TRIGGER trg_budget_line_items_basis_stale BEFORE UPDATE OF annual_amount_cents ON budget_line_items
  FOR EACH ROW EXECUTE FUNCTION budget_line_items_basis_stale();

GRANT SELECT, INSERT, UPDATE, DELETE ON budget_line_items TO service_role;

COMMIT;
