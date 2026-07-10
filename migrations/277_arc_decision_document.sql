-- ============================================================================
-- 277_arc_decision_document.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- Store the ARC decision LETTER itself (the PDF that went to the homeowner), not
-- just its filename + an extracted summary. So the exact approval letter is
-- retrievable + linkable from the ARC record and the board activity report —
-- "capture what was approved and sent to the homeowner."
--
-- source_document_path = path in the 'documents' storage bucket. The letter is
-- an association_record (ARC files belong to the HOA). No new table.
-- ============================================================================
BEGIN;

ALTER TABLE arc_historical_decisions
  ADD COLUMN IF NOT EXISTS source_document_path TEXT;

COMMIT;
