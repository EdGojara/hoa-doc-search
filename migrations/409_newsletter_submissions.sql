-- ============================================================================
-- 409_newsletter_submissions.sql  (Ed 2026-09-06)
-- ----------------------------------------------------------------------------
-- Residents contribute community content for the newsletter from the portal — a
-- neighbor/family accomplishment, a local business worth knowing, an idea, an
-- event. Submissions land here; staff curate them into an issue in Newsletter
-- Studio (never auto-published). This is how the newsletter becomes
-- community-SOURCED, and it's involvement itself. (See project_community_partner_thesis.)
--
-- Record ownership: MIXED. The submission intake is Bedrock workpaper; anything
-- a resident submits that gets published in a delivered newsletter becomes an
-- association record. Community FK present for scoped export.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS newsletter_submissions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id       uuid NOT NULL,
  property_id        uuid,
  submitted_by_name  text,
  submitted_by_email text,
  category           text NOT NULL
                       CHECK (category IN ('neighbor_spotlight', 'local_business', 'idea', 'event', 'other')),
  subject            text,
  body               text,
  contact_info       text,   -- optional: who/where to reach (a business phone, an org)
  link               text,   -- optional URL
  status             text NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'used', 'declined')),
  reviewed_by        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nl_submissions_community ON newsletter_submissions (community_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_nl_submissions_updated ON newsletter_submissions;
CREATE TRIGGER trg_nl_submissions_updated BEFORE UPDATE ON newsletter_submissions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_submissions TO service_role;
GRANT SELECT ON newsletter_submissions TO authenticated;

COMMIT;
