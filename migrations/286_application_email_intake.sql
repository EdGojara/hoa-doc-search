-- ============================================================================
-- 286_application_email_intake.sql  (Ed 2026-07-12)
-- ----------------------------------------------------------------------------
-- Lets an ACC/ARC application arrive by EMAIL (Claire triages inbound mail and
-- hands anything that is an architectural application to Annie, the ACC/ARC
-- specialist). The application runs through the SAME pipeline as a web submit
-- (community_applications -> completeness -> AI assessment -> review queue).
-- Two new columns:
--   intake_method     — 'web' (default, the public form) or 'email' (Annie).
--   intake_source_ref — stable id of the source email ('email:<graphId>') so
--                       repeated mail pulls never create the application twice.
-- Record ownership: community_applications is an association_record (ARC file);
-- unchanged by this migration.
-- ============================================================================
BEGIN;

ALTER TABLE community_applications
  ADD COLUMN IF NOT EXISTS intake_method     TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS intake_source_ref TEXT;

-- Idempotency: one application per source email. Partial unique (only rows that
-- came in with a source ref) so web submits (NULL ref) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_community_applications_intake_ref
  ON community_applications (intake_source_ref)
  WHERE intake_source_ref IS NOT NULL;

COMMIT;
