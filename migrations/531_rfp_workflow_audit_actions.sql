-- ============================================================================
-- 531_rfp_workflow_audit_actions.sql  (Ed 2026-10-16)
-- ----------------------------------------------------------------------------
-- Amanda runs proposal / competing-bid matters through the RFP / Bid Workflow
-- (lib/vendors/rfp_workflow.js). Every association, classification, analysis and
-- queued vendor request is recorded on the existing immutable audit table,
-- rfp_decision_log, next to the operator's finalist / eliminate decisions.
--
--   1. action CHECK gains: associate, classify, analyze, request_queued
--   2. proposal_id becomes nullable: "comparison opened" and "analysis stored"
--      are RFP-level events, not about one proposal
--
-- Until this is applied, AMANDA_RFP_WORKFLOW=write still stores the same trail
-- inside vendor_comparisons.analysis_data.audit and reports the log insert error
-- (never silent). Record ownership unchanged: association_record.
-- Idempotent.
-- ============================================================================
BEGIN;

ALTER TABLE rfp_decision_log DROP CONSTRAINT IF EXISTS rfp_decision_log_action_check;
ALTER TABLE rfp_decision_log
  ADD CONSTRAINT rfp_decision_log_action_check
  CHECK (action IN ('mark_finalist', 'eliminate', 'reset', 'reorder', 'associate', 'classify', 'analyze', 'request_queued'));

ALTER TABLE rfp_decision_log ALTER COLUMN proposal_id DROP NOT NULL;

COMMENT ON COLUMN rfp_decision_log.action IS 'Operator decisions (mark_finalist, eliminate, reset, reorder) and Amanda''s workflow steps (associate, classify, analyze, request_queued). Amanda never writes mark_finalist or eliminate.';

GRANT SELECT, INSERT ON rfp_decision_log TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
