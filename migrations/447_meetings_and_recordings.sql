-- ============================================================================
-- 447_meetings_and_recordings.sql  (Ed 2026-09-23)
-- ----------------------------------------------------------------------------
-- Meeting Intelligence, Step 1: server-side persistence for Meeting Recorder.
--
-- One MEETING is the root object. Under it: recording sessions, their ~30 s
-- audio segments (stored in the private 'meeting-audio' bucket), markers, and
-- executive-session intervals. Existing meeting tables (meeting_agendas,
-- meeting_minutes, meeting_broadcasts) are LINKED by optional FK, never
-- modified or migrated.
--
-- Policy is CONFIGURABLE, not hard-coded:
--   - community_meeting_policies holds per-community defaults (recording on/off,
--     executive-session recording rule, retention, record ownership, purpose).
--   - meetings copies those defaults at creation; each meeting can differ.
--   - record_ownership is never NULL: 'undetermined' until policy is settled.
--   - recording_purpose (per recording session): drafting_aid / official_record
--     / test; normal Meeting Recorder sessions default to 'drafting_aid'.
--   - Executive session is modeled separately (meeting_executive_sessions) so
--     whether it may be recorded can be decided per community later.
--
-- Record ownership (CLAUDE.md): meetings / recordings / markers carry a
-- per-row record_ownership (default 'undetermined'); the export tool decides
-- once policy is set. Policy rows are Bedrock configuration (workpaper).
--
-- Security: operator-only tables, written by the Node API with the service
-- role. RLS is enabled with no policies (anon/authenticated get nothing);
-- service_role is granted explicitly (CLAUDE.md: new tables without
-- service_role grants are silently unwritable).
-- Purely additive: no existing table or row is changed.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Per-community recording policy (configurable defaults)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_meeting_policies (
  community_id               uuid PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  recording_enabled          boolean NOT NULL DEFAULT true,
  exec_session_recording     text NOT NULL DEFAULT 'ask_each_time'
                               CHECK (exec_session_recording IN ('allowed','not_allowed','ask_each_time')),
  default_retention_policy   text NOT NULL DEFAULT 'retain'
                               CHECK (default_retention_policy IN ('retain','delete_after_minutes_approved','delete_after_days')),
  default_retention_days     integer CHECK (default_retention_days IS NULL OR default_retention_days > 0),
  default_record_ownership   text NOT NULL DEFAULT 'undetermined'
                               CHECK (default_record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  default_recording_purpose  text NOT NULL DEFAULT 'drafting_aid'
                               CHECK (default_recording_purpose IN ('drafting_aid','official_record','test')),
  recording_notice_text      text,
  updated_by_user_id         uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (default_retention_policy <> 'delete_after_days' OR default_retention_days IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 2) Meetings: the single root object
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title                      text NOT NULL,
  meeting_type               text NOT NULL DEFAULT 'regular'
                               CHECK (meeting_type IN ('regular','annual','special','executive','organizational','budget','emergency')),
  meeting_date               date NOT NULL,          -- Central calendar date (never derived from a UTC timestamp)
  scheduled_at               timestamptz,
  location                   text,
  status                     text NOT NULL DEFAULT 'scheduled'
                               CHECK (status IN ('scheduled','in_progress','recorded','closed','canceled')),
  -- Links to existing records (optional; never modified by this feature)
  meeting_agenda_id          uuid REFERENCES meeting_agendas(id) ON DELETE SET NULL,
  meeting_minutes_id         uuid REFERENCES meeting_minutes(id) ON DELETE SET NULL,
  meeting_broadcast_id       uuid REFERENCES meeting_broadcasts(id) ON DELETE SET NULL,
  -- Policy, copied from community_meeting_policies at creation, editable per meeting
  retention_policy           text NOT NULL DEFAULT 'retain'
                               CHECK (retention_policy IN ('retain','delete_after_minutes_approved','delete_after_days')),
  retention_days             integer CHECK (retention_days IS NULL OR retention_days > 0),
  record_ownership           text NOT NULL DEFAULT 'undetermined'
                               CHECK (record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  exec_session_recording     text NOT NULL DEFAULT 'ask_each_time'
                               CHECK (exec_session_recording IN ('allowed','not_allowed','ask_each_time')),
  created_by_user_id         uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_policy <> 'delete_after_days' OR retention_days IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS meetings_community_date_idx ON meetings (community_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS meetings_agenda_idx ON meetings (meeting_agenda_id) WHERE meeting_agenda_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Recording sessions (one per recording run; Resume continues the same one)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_recording_sessions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  client_session_id          text NOT NULL UNIQUE,   -- generated on the device; lets an offline start register later, idempotently
  recording_purpose          text NOT NULL DEFAULT 'drafting_aid'
                               CHECK (recording_purpose IN ('drafting_aid','official_record','test')),
  record_ownership           text NOT NULL DEFAULT 'undetermined'
                               CHECK (record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  status                     text NOT NULL DEFAULT 'recording'
                               CHECK (status IN ('recording','paused','interrupted','stopped','verified','incomplete','abandoned')),
  mic_name                   text,
  noise_reduction            boolean,
  mime                       text,
  audio_constraints          jsonb,
  segment_target_ms          integer,
  overlap_ms                 integer,
  device_summary             text,
  client_started_at          timestamptz NOT NULL,
  client_stopped_at          timestamptz,
  pauses                     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{from, to, ms}] from the device
  expected_segment_count     integer CHECK (expected_segment_count IS NULL OR expected_segment_count >= 0),
  highest_seq_seen           integer,
  last_heartbeat_at          timestamptz,
  last_upload_at             timestamptz,
  received_segment_count     integer NOT NULL DEFAULT 0,
  received_bytes             bigint NOT NULL DEFAULT 0,
  verification               jsonb,
  verified_at                timestamptz,
  upload_token_hash          text,                   -- sha256 of the per-session upload key; the key itself is never stored
  upload_token_expires_at    timestamptz,
  started_by_user_id         uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_recording_sessions_meeting_idx ON meeting_recording_sessions (meeting_id);
CREATE INDEX IF NOT EXISTS meeting_recording_sessions_community_idx ON meeting_recording_sessions (community_id, client_started_at DESC);

-- ---------------------------------------------------------------------------
-- 4) Recording segments (one per ~30 s audio piece)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_recording_segments (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid NOT NULL REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  seq                        integer NOT NULL CHECK (seq >= 0),
  storage_path               text NOT NULL UNIQUE,
  bytes                      integer NOT NULL CHECK (bytes > 0),
  sha256                     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),   -- recomputed by the server on arrival
  mime                       text,
  client_started_at          timestamptz,
  duration_ms                integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  is_partial                 boolean NOT NULL DEFAULT false,                   -- recovered after a reload
  session_scope              text NOT NULL DEFAULT 'open' CHECK (session_scope IN ('open','executive')),
  audible                    boolean,                -- device-side sound check (the server does not decode audio in Step 1)
  peak                       real,
  rms                        real,
  uploaded_by_user_id        uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  uploaded_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS meeting_recording_segments_meeting_idx ON meeting_recording_segments (meeting_id);

-- ---------------------------------------------------------------------------
-- 5) Markers (minutes / action item / important / exec start-end / pause ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_markers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  session_id                 uuid NOT NULL REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  client_marker_id           text NOT NULL,          -- device id; re-sending never duplicates
  kind                       text NOT NULL CHECK (kind IN (
                               'minutes','action_item','important','exec_start','exec_end',
                               'pause','resume','interrupted','resumed_after_interruption',
                               'recording_started','recording_stopped','mic_muted','no_sound','notice_ack')),
  offset_ms                  integer,                -- from the session's start
  occurred_at                timestamptz NOT NULL,
  note                       text,
  created_by_user_id         uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, client_marker_id)
);
CREATE INDEX IF NOT EXISTS meeting_markers_meeting_idx ON meeting_markers (meeting_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 6) Executive-session intervals, modeled separately
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_executive_sessions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  session_id                 uuid REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  started_at                 timestamptz NOT NULL,
  ended_at                   timestamptz,            -- NULL = still open
  start_marker_id            uuid REFERENCES meeting_markers(id) ON DELETE SET NULL,
  end_marker_id              uuid REFERENCES meeting_markers(id) ON DELETE SET NULL,
  audio_recorded             boolean NOT NULL DEFAULT true,
  policy_at_time             text NOT NULL CHECK (policy_at_time IN ('allowed','not_allowed','ask_each_time')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS meeting_executive_sessions_meeting_idx ON meeting_executive_sessions (meeting_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers (existing shared function)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_community_meeting_policies_updated_at ON community_meeting_policies;
CREATE TRIGGER trg_community_meeting_policies_updated_at BEFORE UPDATE ON community_meeting_policies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_meetings_updated_at ON meetings;
CREATE TRIGGER trg_meetings_updated_at BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_meeting_recording_sessions_updated_at ON meeting_recording_sessions;
CREATE TRIGGER trg_meeting_recording_sessions_updated_at BEFORE UPDATE ON meeting_recording_sessions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- Access: service role only (the Node API). RLS on, no policies.
-- ---------------------------------------------------------------------------
ALTER TABLE community_meeting_policies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_recording_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_recording_segments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_markers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_executive_sessions   ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON community_meeting_policies  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meetings                    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_recording_sessions  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_recording_segments  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_markers             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_executive_sessions  TO service_role;

COMMIT;
