-- ============================================================================
-- 449_meeting_transcripts.sql  (Ed 2026-09-23)
-- ----------------------------------------------------------------------------
-- Meeting Intelligence, Step 2b: speaker-labeled transcripts of the joined
-- meeting audio (migration 448), from Deepgram PRERECORDED transcription
-- (diarization, utterances, punctuation, smart formatting, word timestamps,
-- confidence).
--
-- meeting_transcripts          one row per transcription run; exactly one is
--                              CURRENT per session. The raw Deepgram response
--                              is kept verbatim in storage (raw_storage_path,
--                              sha256) next to the joined audio.
-- meeting_transcript_segments  normalized utterances: speaker number, audio
--                              start/end, meeting-time start/end, text,
--                              confidence, and scope (open | executive).
--                              Utterances are split at recording gaps and at
--                              executive-session boundaries, so no segment
--                              straddles either.
-- meeting_speaker_mappings     staff map "Speaker 2" -> a board member from the
--                              roster, Manager, Vendor, Homeowner or Other.
--                              Changing a mapping never re-transcribes; the
--                              transcript display joins mappings at read time.
--                              No voice recognition / voiceprints are stored.
--
-- Record ownership (CLAUDE.md):
--   meeting_transcripts + segments: follow the recording, per-row
--     record_ownership copied from the session ('undetermined' until policy
--     is settled), never NULL.
--   meeting_speaker_mappings: workpaper (Bedrock's production process; table-level).
-- Security: service role only (RLS on, no policies). Purely additive.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS meeting_transcripts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid NOT NULL REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  assembly_id                uuid NOT NULL REFERENCES meeting_audio_assemblies(id) ON DELETE RESTRICT,
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  is_current                 boolean NOT NULL DEFAULT true,
  status                     text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready')),
  provider                   text NOT NULL DEFAULT 'deepgram' CHECK (provider IN ('deepgram')),
  model                      text NOT NULL,
  request_params             jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_request_id        text,
  raw_storage_path           text NOT NULL,
  raw_sha256                 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_bytes                  integer NOT NULL CHECK (raw_bytes > 0),
  audio_sha256               text NOT NULL CHECK (audio_sha256 ~ '^[0-9a-f]{64}$'),   -- the joined file this transcribes
  duration_ms                integer,
  speaker_count              integer NOT NULL DEFAULT 0,
  segment_count              integer NOT NULL DEFAULT 0,
  word_count                 integer NOT NULL DEFAULT 0,
  avg_confidence             real,
  record_ownership           text NOT NULL DEFAULT 'undetermined'
                               CHECK (record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_transcripts_one_current ON meeting_transcripts (session_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS meeting_transcripts_meeting_idx ON meeting_transcripts (meeting_id);

CREATE TABLE IF NOT EXISTS meeting_transcript_segments (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id              uuid NOT NULL REFERENCES meeting_transcripts(id) ON DELETE CASCADE,
  session_id                 uuid NOT NULL REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  idx                        integer NOT NULL CHECK (idx >= 0),
  speaker                    integer,                        -- Deepgram diarization number (0-based); NULL if not diarized
  start_ms                   integer NOT NULL CHECK (start_ms >= 0),   -- position in the joined audio
  end_ms                     integer NOT NULL,
  meeting_start_ms           integer,                        -- ms since the recording session started (gaps included)
  meeting_end_ms             integer,
  text                       text NOT NULL,
  confidence                 real,
  word_count                 integer NOT NULL DEFAULT 0,
  scope                      text NOT NULL DEFAULT 'open' CHECK (scope IN ('open','executive')),
  after_gap                  boolean NOT NULL DEFAULT false, -- the first segment after a recording gap
  record_ownership           text NOT NULL DEFAULT 'undetermined'
                               CHECK (record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  UNIQUE (transcript_id, idx),
  CHECK (end_ms >= start_ms)
);
CREATE INDEX IF NOT EXISTS meeting_transcript_segments_session_idx ON meeting_transcript_segments (session_id);

CREATE TABLE IF NOT EXISTS meeting_speaker_mappings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id              uuid NOT NULL REFERENCES meeting_transcripts(id) ON DELETE CASCADE,
  session_id                 uuid NOT NULL REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  speaker                    integer NOT NULL,
  role                       text NOT NULL CHECK (role IN ('board_member','manager','vendor','homeowner','other')),
  board_member_id            uuid REFERENCES board_members(id) ON DELETE SET NULL,
  display_name               text,
  updated_by_user_id         uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transcript_id, speaker),
  CHECK (role <> 'board_member' OR board_member_id IS NOT NULL)
);

DROP TRIGGER IF EXISTS trg_meeting_speaker_mappings_updated_at ON meeting_speaker_mappings;
CREATE TRIGGER trg_meeting_speaker_mappings_updated_at BEFORE UPDATE ON meeting_speaker_mappings
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE meeting_transcripts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_transcript_segments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_speaker_mappings     ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_transcripts          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_transcript_segments  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_speaker_mappings     TO service_role;

COMMIT;
