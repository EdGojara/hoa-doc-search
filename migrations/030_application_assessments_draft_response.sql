-- ============================================================================
-- 030_application_assessments_draft_response.sql
-- ----------------------------------------------------------------------------
-- The AI assessment of an ACC application already generates a `draft_response`
-- (a Bedrock-voice email to the homeowner) and a `recommended_action` field.
-- We weren't storing either, so the manager queue couldn't use them — the
-- response textarea was falling back to a generic template instead of the
-- actual AI-generated draft.
--
-- This migration adds two columns + table+view permission grants.
--
-- Apply AFTER 029. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE application_assessments
  ADD COLUMN IF NOT EXISTS draft_response       TEXT,
  ADD COLUMN IF NOT EXISTS recommended_action   TEXT
                            CHECK (recommended_action IS NULL OR recommended_action IN
                                   ('approve', 'approve_with_conditions', 'request_more_info', 'deny', 'manual_review'));

-- Same denormalized snapshot pattern as the existing assessment fields —
-- mirror onto community_applications for fast queue queries
ALTER TABLE community_applications
  ADD COLUMN IF NOT EXISTS assessment_draft_response   TEXT,
  ADD COLUMN IF NOT EXISTS assessment_recommended_action TEXT
                            CHECK (assessment_recommended_action IS NULL OR assessment_recommended_action IN
                                   ('approve', 'approve_with_conditions', 'request_more_info', 'deny', 'manual_review'));

-- Belt-and-suspenders permission grants
GRANT SELECT, INSERT, UPDATE, DELETE ON application_assessments TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_responses TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_applications TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_attachments TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_reference_counters TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_services TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON community_addresses TO anon, authenticated, service_role;

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='application_assessments' AND column_name IN ('draft_response','recommended_action');
