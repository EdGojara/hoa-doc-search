-- ============================================================================
-- 540_acc_decision_authority_columns.sql  (Ed 2026-10-20)
-- ----------------------------------------------------------------------------
-- STEP 1 of 2 for ACC decision authority (lib/acc/decision_authority.js).
-- ADDITIVE ONLY, safe to apply BEFORE the code that uses it: nothing reads or
-- writes these columns until that code is deployed, no default, constraint or
-- trigger on an existing column changes, and no row is touched. The behavior
-- changes (status default + trigger) are step 2, migration 541, applied only
-- after the code is live. (The 539 lesson: a migration and the code that
-- depends on it must not need to land at the same moment.)
--
-- Adds to acc_decisions (all nullable):
--   approval_gate          'required' | 'not_required'  the app's driveway /
--                          paving classification, so the 541 trigger sees it
--   approval_gate_reason   why
--   owner_review           jsonb: Ed's in-app review of an escalated case
--                          {reviewed_at, reviewed_by_user_id, reviewed_by_email, notes}
--   decision_record        jsonb: the authorized final decision
--                          {decided_by: ed|annie|amanda, decided_by_email, outcome,
--                           decided_at, authority_basis {kind, reference,
--                           library_document_id, library_document_title,
--                           clearly_compliant}, committee_or_board {...}|null, ...}
--   compliance_evaluation  jsonb: the structured evaluation Annie / Amanda must
--                          complete before deciding (written by the engine later)
--
-- Record ownership: association_record (columns on acc_decisions).
-- ============================================================================
BEGIN;

ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS approval_gate text;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS approval_gate_reason text;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS owner_review jsonb;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS decision_record jsonb;
ALTER TABLE acc_decisions ADD COLUMN IF NOT EXISTS compliance_evaluation jsonb;

-- All existing rows have approval_gate NULL, so this constraint validates
-- instantly and cannot fail.
ALTER TABLE acc_decisions DROP CONSTRAINT IF EXISTS acc_decisions_approval_gate_check;
ALTER TABLE acc_decisions ADD CONSTRAINT acc_decisions_approval_gate_check
  CHECK (approval_gate IS NULL OR approval_gate IN ('required', 'not_required'));

COMMIT;
