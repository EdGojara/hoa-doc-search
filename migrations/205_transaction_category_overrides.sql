-- ============================================================================
-- 205_transaction_category_overrides.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Operator override of auto-assigned charge_category on
-- homeowner_transactions rows. Auto-categorization via lib/ar/categorize.js
-- handles 95%+ but Vantaca free-text descriptions occasionally need a human
-- judgment call ("Misc charge for whatever Bob did" — assessment? admin fee?
-- adjustment?).
--
-- We don't just let operators stomp the category — every change goes through
-- the audit table with reason + operator identity. Same pattern as
-- property_enforcement_state_audit (regulatory defense if denial decisions
-- are ever challenged).
--
-- Also adds an `is_operator_override` flag on homeowner_transactions so the
-- backfill migration (204) never re-categorizes a row a human has corrected.
-- ============================================================================

BEGIN;

ALTER TABLE homeowner_transactions
  ADD COLUMN IF NOT EXISTS is_operator_override BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN homeowner_transactions.is_operator_override IS
  'TRUE if an operator manually set charge_category. Protects against auto-categorize backfills overwriting human judgment.';

CREATE TABLE IF NOT EXISTS homeowner_transaction_category_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES homeowner_transactions(id) ON DELETE CASCADE,
  category_before TEXT,
  category_after  TEXT NOT NULL,
  reason TEXT NOT NULL,
  performed_by TEXT NOT NULL,           -- operator email / id
  ip_address INET,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_cat_audit_txn
  ON homeowner_transaction_category_audit(transaction_id, changed_at DESC);

GRANT SELECT, INSERT ON homeowner_transaction_category_audit TO service_role;
GRANT SELECT ON homeowner_transaction_category_audit TO authenticated;

COMMIT;
