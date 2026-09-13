-- ============================================================================
-- 426_community_key_issues.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- KEY ISSUES per community: the living matters a board/manager tracks — a MUD
-- dispute, a big capital project, a lawsuit, a vendor change. Distinct from the
-- key-EVENTS ledger (mig 412), which is a point-in-time timeline for the
-- newsletter. A Key Issue is an ongoing matter with a STATUS (current, closed,
-- or potentially-future), a summary, the relevant facts, its history, and the
-- approach we're taking.
--
-- Two audiences, one record:
--   - the AI team (Amanda + everyone) reads current/future issues via the
--     community context block, so they answer homeowners consistently, and
--   - the human team sees the same at /admin/community-issues.
--
-- This is the focused first cut of the long-noted "community matters layer".
-- Record ownership: association_record (the community's own history; exports on
-- termination). The `approach` field is internal guidance and is workpaper in
-- spirit, but lives here for one-record simplicity; the export tool can drop it.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS community_key_issues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'current'
                     CHECK (status IN ('current','closed','future')),
  category         text NOT NULL DEFAULT 'general'
                     CHECK (category IN ('governance','financial','legal','infrastructure','vendor','amenity','enforcement','security','environmental','general')),
  summary          text,               -- the overview (AI + human)
  facts            text,               -- relevant, settled facts (bulleted ok)
  history          text,               -- background / chronology (human-facing)
  approach         text,               -- how we're handling it (internal guidance for the AI + team)
  owner_persona    text,               -- which AI teammate owns it (e.g. 'amanda')
  opened_on        date,
  closed_on        date,
  record_ownership text NOT NULL DEFAULT 'association_record',
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cki_community_status ON community_key_issues (community_id, status);

DROP TRIGGER IF EXISTS trg_cki_updated_at ON community_key_issues;
CREATE TRIGGER trg_cki_updated_at BEFORE UPDATE ON community_key_issues
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON community_key_issues TO service_role;
GRANT SELECT ON community_key_issues TO authenticated;

COMMIT;
