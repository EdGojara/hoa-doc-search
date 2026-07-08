-- ============================================================================
-- 264_system_errors.sql  (Ed 2026-07-08)
-- ----------------------------------------------------------------------------
-- "Nothing fails silently" — for the platform itself, not just homeowner mail.
-- Mail Scan was 100% broken for weeks and nobody knew, because a 500 vanished
-- into a cryptic client message and was never surfaced to Ed. This table is the
-- capture point: every server error (5xx) is logged with the endpoint, the
-- message, and who hit it, so a broken feature shows up on an admin screen in
-- minutes instead of after staff waste hours guessing.
--
-- record_ownership = workpaper (internal operational telemetry, Bedrock's).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS system_errors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method        text,
  path          text,
  status_code   integer,
  error_message text,
  user_email    text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_errors_created ON system_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_errors_path    ON system_errors (path);

GRANT SELECT, INSERT ON system_errors TO service_role;
GRANT SELECT          ON system_errors TO authenticated;

COMMIT;
