-- 432_acc_shadow_decisions.sql
-- ============================================================================
-- SHADOW-ONLY evaluation store for the lib/ai router running against ACC
-- applications. This is DELIBERATELY a disposable EVALUATION table, NOT the
-- permanent production AI decision/audit schema (that generalized store comes
-- later, spanning ACC/reconciliation/violations/governance). Keeping it isolated
-- means we can iterate or drop it without touching a production audit system.
--
-- Nothing in the shadow path may act (no letters, no status mutation, no
-- homeowner comms) — this table only RECORDS what Miranda would have decided,
-- beside what the humans actually decided (acc_decisions.decision_type), so we can
-- measure agreement OVERALL, PER ITEM, and PER REQUIREMENT before ACC ever
-- graduates from shadow. (ROUTING_POLICY.md; Ed/ChatGPT 2026-09-19.)
--
-- Record ownership: WORKPAPER (Bedrock internal eval data; not an association
-- record, not transferable on termination).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS acc_shadow_decisions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_acc_decision_id    UUID NULL REFERENCES acc_decisions(id) ON DELETE SET NULL,
  community_id              UUID NULL REFERENCES communities(id),
  community_name            TEXT NULL,
  record_ownership          TEXT NOT NULL DEFAULT 'workpaper',

  policy_version            TEXT NULL,
  primary_provider          TEXT NULL,
  primary_model             TEXT NULL,
  verifier_provider         TEXT NULL,
  verifier_model            TEXT NULL,

  -- structured decisions (the contract), so agreement is field-by-field later
  primary_decision          TEXT NULL,
  primary_structured        JSONB NULL,
  verifier_decision         TEXT NULL,
  verifier_structured       JSONB NULL,
  agreement                 BOOLEAN NULL,
  agreement_reasons         JSONB NULL,
  deterministic_overrides   JSONB NULL,

  -- gate + routed verdict (business decision and execution are separate axes)
  severity                  TEXT NULL,
  evidence_incomplete       BOOLEAN NULL,
  business_decision         TEXT NULL,
  execution                 TEXT NULL,
  reason_code               TEXT NULL,
  notification_level        TEXT NULL,
  audit                     JSONB NULL,

  -- shadow health is separate from decision content: a router/provider/retrieval
  -- failure is shadow_status='error', never a (wrong) decision.
  shadow_status             TEXT NOT NULL DEFAULT 'ok'
                              CHECK (shadow_status IN ('ok','error')),
  error                     TEXT NULL,

  -- comparison to the human outcome (from acc_decisions at eval time). Human
  -- per-item/per-requirement labels don't exist historically, so those columns
  -- hold Miranda's side + human overall now, and per-item human labels once a
  -- human provides them (each disagreement -> an eval fixture / precedent).
  human_decision_type       TEXT NULL,
  overall_match             BOOLEAN NULL,
  item_match                JSONB NULL,
  requirement_match         JSONB NULL,
  human_override            JSONB NULL,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acc_shadow_source     ON acc_shadow_decisions (source_acc_decision_id);
CREATE INDEX IF NOT EXISTS idx_acc_shadow_community   ON acc_shadow_decisions (community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_shadow_match       ON acc_shadow_decisions (overall_match);
CREATE INDEX IF NOT EXISTS idx_acc_shadow_status      ON acc_shadow_decisions (shadow_status);

-- updated_at trigger (existing helper)
DROP TRIGGER IF EXISTS trg_acc_shadow_updated_at ON acc_shadow_decisions;
CREATE TRIGGER trg_acc_shadow_updated_at
  BEFORE UPDATE ON acc_shadow_decisions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- The Node API writes with the service role; a new table is silently unwritable
-- without this grant (repeated scar).
GRANT SELECT, INSERT, UPDATE, DELETE ON acc_shadow_decisions TO service_role;
GRANT SELECT                          ON acc_shadow_decisions TO authenticated;

COMMIT;

-- Verify:
--   SELECT id, community_name, business_decision, execution, reason_code,
--          human_decision_type, overall_match, shadow_status
--     FROM acc_shadow_decisions ORDER BY created_at DESC LIMIT 10;
