-- ============================================================================
-- 450_meeting_analyses.sql  (Ed 2026-09-23)
-- ----------------------------------------------------------------------------
-- Meeting Intelligence, Step 2c: Paige's analysis of a meeting transcript
-- (migration 449) and the checked result.
--
-- meeting_analyses  one row per analysis run; exactly one is CURRENT per
--   session. raw_output is Paige's structured output verbatim; checked is the
--   same after lib/meetings/intel_validate.js (every item OK | NEEDS_REVIEW
--   with reasons, time references, supporting transcript lines; executive-
--   session content withheld). speaker_snapshot records the speaker mappings
--   the analysis was run with, so the UI can say when mappings changed since.
--   draft_minutes_id links the DRAFT created in the existing minutes module
--   (meeting_minutes, status 'draft'); minutes are never finalized, emailed,
--   or turned into motions/projects/tasks from here.
--
-- Record ownership (CLAUDE.md): workpaper (AI judgment output, Bedrock's
--   production process). The draft minutes it produces live in meeting_minutes
--   and are an association_record there.
-- Security: service role only (RLS on, no policies). Purely additive.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS meeting_analyses (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                 uuid NOT NULL REFERENCES meeting_recording_sessions(id) ON DELETE RESTRICT,
  transcript_id              uuid NOT NULL REFERENCES meeting_transcripts(id) ON DELETE RESTRICT,
  meeting_id                 uuid NOT NULL REFERENCES meetings(id) ON DELETE RESTRICT,
  community_id               uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  is_current                 boolean NOT NULL DEFAULT true,
  status                     text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready')),
  model                      text NOT NULL,
  prompt_version             text NOT NULL,
  raw_output                 jsonb NOT NULL,
  checked                    jsonb NOT NULL,
  needs_review_count         integer NOT NULL DEFAULT 0,
  withheld_count             integer NOT NULL DEFAULT 0,
  speaker_snapshot           jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage                      jsonb,
  draft_minutes_id           uuid REFERENCES meeting_minutes(id) ON DELETE SET NULL,
  draft_minutes_created_at   timestamptz,
  draft_minutes_created_by   uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  requested_by_user_id       uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  record_ownership           text NOT NULL DEFAULT 'workpaper'
                               CHECK (record_ownership IN ('undetermined','association_record','workpaper','mixed')),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_analyses_one_current ON meeting_analyses (session_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS meeting_analyses_meeting_idx ON meeting_analyses (meeting_id);

ALTER TABLE meeting_analyses ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON meeting_analyses TO service_role;

COMMIT;
