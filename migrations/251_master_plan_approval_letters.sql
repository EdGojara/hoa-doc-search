-- ============================================================================
-- 251_master_plan_approval_letters.sql
-- ----------------------------------------------------------------------------
-- Grouped master-plan approval letter (Ed 2026-06-30): "is the master plan
-- approvals producing an approval letter — we don't have to do them
-- individually we can do them by group for the master plans."
--
-- A master-plan approval is the builder's standard plan LIBRARY being accepted
-- for a community (Lennar = 18 plans / 59 elevations at Still Creek), not a
-- per-lot decision. The per-application letter (builder_application_responses,
-- FK'd to one application) is the wrong shape for this. This table holds ONE
-- letter per builder per community listing every currently-approved plan +
-- elevation, so approvals go out by group + are visible in the builder portal.
--
-- Record ownership: ASSOCIATION_RECORD — this letter is delivered to the
-- builder on behalf of the HOA's ACC, so it transfers on termination. The
-- plans_snapshot is the rendered-at content (audit trail of what was approved
-- when), distinct from the live master_plan_community_approvals state.
--
-- Per the CLAUDE.md scar ("New tables without service_role GRANTs are silently
-- unwritable"): explicit grants below.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS master_plan_approval_letters (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  builder_company_id            UUID NOT NULL REFERENCES builder_companies(id) ON DELETE CASCADE,
  reference_number              TEXT,
  plan_count                    INTEGER NOT NULL DEFAULT 0,
  elevation_count               INTEGER NOT NULL DEFAULT 0,
  -- Grouped plans as rendered (groupMasterPlansForLetter output): the audit
  -- snapshot of exactly what this letter stated was approved.
  plans_snapshot                JSONB NOT NULL DEFAULT '[]'::jsonb,
  letter_pdf_path               TEXT,
  letter_signed_url             TEXT,
  letter_signed_url_expires_at  TIMESTAMPTZ,
  email_subject                 TEXT,
  email_to                      TEXT,
  email_sent_at                 TIMESTAMPTZ,
  email_message_id              TEXT,
  generated_by                  TEXT,
  generated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mpal_community_builder
  ON master_plan_approval_letters (community_id, builder_company_id, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON master_plan_approval_letters TO service_role;
GRANT SELECT                          ON master_plan_approval_letters TO authenticated;

COMMIT;
