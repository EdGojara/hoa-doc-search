-- ============================================================================
-- 412_community_key_events.sql  (Ed 2026-09-07)
-- ----------------------------------------------------------------------------
-- The community KEY-EVENTS ledger: a persistent, per-community timeline of the
-- significant things that happened — a security-provider change, a completed
-- project, a community event, a board decision, a milestone. Captured from the
-- community's email + platform data (or added by staff), it's the source for:
--   - the newsletter's "This Month at <Community>",
--   - a per-community / per-month timeline view, and
--   - the ANNUAL year-in-review recap for the board meeting.
--
-- This is institutional memory: the platform remembers what happened so nobody
-- has to reconstruct the year from scratch. (See project_institutional_memory.)
--
-- Record ownership: association_record — it is the community's own history and
-- must export cleanly on termination.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS community_key_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id     uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  event_date       date NOT NULL,
  title            text NOT NULL,
  summary          text,
  category         text NOT NULL DEFAULT 'update'
                     CHECK (category IN ('governance','security','project','financial','event','amenity','maintenance','community','update')),
  impact           text NOT NULL DEFAULT 'normal' CHECK (impact IN ('minor','normal','major')),
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','email','ai','system')),
  source_email_id  uuid,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
  record_ownership text NOT NULL DEFAULT 'association_record',
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cke_community_date ON community_key_events (community_id, event_date DESC);

DROP TRIGGER IF EXISTS trg_cke_updated_at ON community_key_events;
CREATE TRIGGER trg_cke_updated_at BEFORE UPDATE ON community_key_events
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON community_key_events TO service_role;
GRANT SELECT ON community_key_events TO authenticated;

COMMIT;
