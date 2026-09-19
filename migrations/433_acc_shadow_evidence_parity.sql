-- 433_acc_shadow_evidence_parity.sql
-- ============================================================================
-- ADDITIVE extension of acc_shadow_decisions (migration 432, already applied and
-- IMMUTABLE). The first shadow run showed Miranda received only the thin
-- project_summary while the human reviewer had the full application PDF — so a
-- Miranda-vs-human difference is NOT automatically an AI error. These columns let
-- us track evidence parity and treat a disagreement as an ADJUDICATION case
-- (Miranda wrong? human wrong? both defensible? insufficient evidence?), so shadow
-- mode can discover human mistakes too, not just reproduce historical decisions.
-- (Ed/ChatGPT 2026-09-19.)
--
-- Additive only: ADD COLUMN IF NOT EXISTS, no drop/recreate, existing rows keep
-- their values (new columns NULL). Table grants from 432 already cover new columns.
-- ============================================================================
BEGIN;

ALTER TABLE acc_shadow_decisions
  ADD COLUMN IF NOT EXISTS input_evidence_manifest JSONB,   -- exactly what Miranda saw: each source, type, read ok?, version, error
  ADD COLUMN IF NOT EXISTS input_complete          BOOLEAN, -- was the evidence package sufficient for a fair decision?
  ADD COLUMN IF NOT EXISTS disagreement_type       TEXT
    CHECK (disagreement_type IS NULL OR disagreement_type IN
           ('DECISION','EVIDENCE','RULE_INTERPRETATION','SUBJECTIVE_JUDGMENT','HUMAN_OVERRIDE','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS adjudication            TEXT     -- filled by a human later; never assumed
    CHECK (adjudication IS NULL OR adjudication IN
           ('AI_CORRECT','HUMAN_CORRECT','BOTH_DEFENSIBLE','INSUFFICIENT_EVIDENCE')),
  ADD COLUMN IF NOT EXISTS adjudication_rationale  TEXT;

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'acc_shadow_decisions'
--      AND column_name IN ('input_evidence_manifest','input_complete','disagreement_type','adjudication','adjudication_rationale');
