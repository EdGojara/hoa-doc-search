-- ============================================================================
-- 363_chamber_meeting_broadcasts.sql
-- ----------------------------------------------------------------------------
-- CHAMBER — live board-meeting streaming to authenticated homeowners inside the
-- portal. This is the broadcast + governance layer on top of the EXISTING
-- meeting record (meeting_agendas); it is NOT a new meeting silo. trustEd owns
-- the authenticated viewing experience, agenda sync, request-to-speak queue,
-- executive-session stream cutoff, and recording retention policy — the parts
-- a bare Zoom/Teams setup can't do. The actual video transport stays with a
-- provider (Zoom/Mux/Cloudflare/YouTube) via an embed URL; we don't build
-- streaming.
--
-- Record ownership: association_record (the association's own meeting record).
-- Retention of the recording is a BOARD decision (retention_policy) because a
-- verbatim recording is discoverable and can contradict approved minutes.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS meeting_broadcasts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id  UUID,
  community_id           UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  meeting_agenda_id      UUID REFERENCES meeting_agendas(id) ON DELETE SET NULL,
  title                  TEXT,
  scheduled_at           TIMESTAMPTZ,
  status                 TEXT NOT NULL DEFAULT 'scheduled'
                           CHECK (status IN ('scheduled', 'live', 'ended', 'canceled')),
  -- Provider-agnostic playback: an iframe embed URL (Zoom web client, Mux /
  -- Cloudflare Stream player, unlisted YouTube, etc.). hls_url optional for a
  -- native player. We do not host the video.
  provider               TEXT DEFAULT 'other'
                           CHECK (provider IN ('zoom', 'mux', 'cloudflare', 'youtube', 'other')),
  player_embed_url       TEXT,
  hls_url                TEXT,
  -- Live agenda sync: which agenda item the board is on right now.
  current_item_index     INTEGER NOT NULL DEFAULT 0,
  -- Executive session: when TRUE the stream + recording are cut and viewers
  -- see a "board is in executive session" card. §209.0051 closed-session
  -- matters (legal, personnel, delinquent-owner, contract negotiation) must
  -- never be streamed.
  exec_session           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Recording + retention (board policy).
  recording_url          TEXT,
  recording_available    BOOLEAN NOT NULL DEFAULT FALSE,
  retention_policy       TEXT NOT NULL DEFAULT 'delete_after_minutes_approved'
                           CHECK (retention_policy IN ('retain', 'delete_after_minutes_approved', 'delete_after_days')),
  delete_recording_after DATE,
  consent_notice         TEXT,
  started_at             TIMESTAMPTZ,
  ended_at               TIMESTAMPTZ,
  record_ownership       TEXT NOT NULL DEFAULT 'association_record',
  created_by             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_broadcasts_community
  ON meeting_broadcasts (community_id, scheduled_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_meeting_broadcasts_live
  ON meeting_broadcasts (community_id) WHERE status = 'live';

-- Request-to-speak queue (homeowner forum). Homeowners are NOT in the meeting;
-- when the moderator allows one, that person is promoted into the live leg for
-- their allotted time.
CREATE TABLE IF NOT EXISTS meeting_speak_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id      UUID NOT NULL REFERENCES meeting_broadcasts(id) ON DELETE CASCADE,
  community_id      UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  contact_id        UUID,
  display_name      TEXT NOT NULL,
  property_address  TEXT,
  topic             TEXT,
  status            TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'allowed', 'speaking', 'done', 'denied', 'withdrawn')),
  allotted_seconds  INTEGER NOT NULL DEFAULT 180,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  allowed_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  record_ownership  TEXT NOT NULL DEFAULT 'association_record',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_speak_requests_broadcast
  ON meeting_speak_requests (broadcast_id, requested_at);

-- Live viewer presence ("Attending online: N") — one row per authenticated
-- homeowner watching, heartbeated. Attendance is an association record.
CREATE TABLE IF NOT EXISTS meeting_broadcast_viewers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  UUID NOT NULL REFERENCES meeting_broadcasts(id) ON DELETE CASCADE,
  community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  contact_id    UUID,
  display_name  TEXT,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  record_ownership TEXT NOT NULL DEFAULT 'association_record',
  UNIQUE (broadcast_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_viewers_live
  ON meeting_broadcast_viewers (broadcast_id, last_seen_at DESC);

DROP TRIGGER IF EXISTS trg_meeting_broadcasts_updated_at ON meeting_broadcasts;
CREATE TRIGGER trg_meeting_broadcasts_updated_at
  BEFORE UPDATE ON meeting_broadcasts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_speak_requests_updated_at ON meeting_speak_requests;
CREATE TRIGGER trg_speak_requests_updated_at
  BEFORE UPDATE ON meeting_speak_requests
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_broadcasts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_speak_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_broadcast_viewers TO service_role;
GRANT SELECT ON meeting_broadcasts TO authenticated;
GRANT SELECT ON meeting_speak_requests TO authenticated;
GRANT SELECT ON meeting_broadcast_viewers TO authenticated;

COMMIT;
