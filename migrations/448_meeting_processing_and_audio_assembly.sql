-- ============================================================================
-- 448_meeting_processing_and_audio_assembly.sql  (Ed 2026-09-23)
-- ----------------------------------------------------------------------------
-- Meeting Intelligence, Step 2a: the processing pipeline and audio assembly.
--
-- A server-VERIFIED recording session (migration 447) is processed in stages:
--   assemble   -> join the ~30 s pieces into one continuous audio file
--   transcribe -> Deepgram prerecorded transcription (migration 449)
--   analyze    -> Paige meeting intelligence (migration 450)
--
-- meeting_processing_jobs  one row per recording session. The job is the
--   durable queue: an in-process worker claims it with a lease, so a server
--   restart mid-stage simply lets the lease expire and the stage re-runs
--   (every stage is idempotent). A failed stage records WHICH stage failed and
--   why; Retry continues from that stage, never from the start.
-- meeting_audio_assemblies one row per session: the joined file (storage path,
--   sha256, bytes, duration), the timeline mapping audio time <-> meeting
--   time, the gaps that were NOT filled with audio, the executive-session
--   ranges, and a per-boundary report of how each overlap was removed.
--
-- Record ownership (CLAUDE.md):
--   meeting_processing_jobs   workpaper (Bedrock's production process; table-level)
--   meeting_audio_assemblies  follows the recording: per-row record_ownership,
--                             copied from the recording session ('undetermined'
--                             until policy is settled), never NULL.
-- Security: service role only (RLS on, no policies), same as migration 447.
-- Purely additive.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS meeting_processing_jobs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid NOT NULL UNIQUE REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  status                     text NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued','running','failed','ready')),
  current_stage              text NOT NULL DEFAULT 'assemble'
                               CHECK (current_stage IN ('assemble','transcribe','analyze','done')),
  stages                     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {assemble:{status,started_at,finished_at,attempts,error}, ...}
  failed_stage               text CHECK (failed_stage IS NULL OR failed_stage IN ('assemble','transcribe','analyze')),
  last_error                 text,
  attempts                   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),   -- automatic attempts of the current stage
  next_attempt_at            timestamptz,
  lease_owner                text,
  lease_expires_at           timestamptz,
  requested_by_user_id       uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_processing_jobs_open_idx ON meeting_processing_jobs (status, next_attempt_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS meeting_processing_jobs_meeting_idx ON meeting_processing_jobs (meeting_id);

CREATE TABLE IF NOT EXISTS meeting_audio_assemblies (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid NOT NULL UNIQUE REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  status                     text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready')),
  storage_path               text NOT NULL,
  mime                       text NOT NULL,
  bytes                      bigint NOT NULL CHECK (bytes > 0),
  sha256                     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  duration_ms                integer NOT NULL CHECK (duration_ms >= 0),   -- length of the joined audio
  meeting_span_ms            integer,                                     -- first audio to last audio, in meeting time (includes gaps)
  sample_rate                integer NOT NULL,
  segment_count              integer NOT NULL CHECK (segment_count >= 0),
  timeline                   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{seq, audio_from_ms, audio_to_ms, meeting_from_ms}]
  gaps                       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{at_audio_ms, meeting_from_ms, meeting_to_ms, ms, reason}] NOT filled with audio
  exec_ranges                jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{audio_from_ms, audio_to_ms, meeting_from_ms, meeting_to_ms}]
  boundaries                 jsonb NOT NULL DEFAULT '[]'::jsonb,   -- per joined boundary: expected/measured overlap, method, score
  source_verification        jsonb,                                -- the session verification this was built from
  ffmpeg_version             text,
  record_ownership           text NOT NULL DEFAULT 'undetermined'
                               CHECK (record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_audio_assemblies_meeting_idx ON meeting_audio_assemblies (meeting_id);

DROP TRIGGER IF EXISTS trg_meeting_processing_jobs_updated_at ON meeting_processing_jobs;
CREATE TRIGGER trg_meeting_processing_jobs_updated_at BEFORE UPDATE ON meeting_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_meeting_audio_assemblies_updated_at ON meeting_audio_assemblies;
CREATE TRIGGER trg_meeting_audio_assemblies_updated_at BEFORE UPDATE ON meeting_audio_assemblies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE meeting_processing_jobs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_audio_assemblies  ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_processing_jobs   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_audio_assemblies  TO service_role;

COMMIT;
