-- ============================================================================
-- 414_persona_voices.sql  (Ed 2026-09-11)
-- ----------------------------------------------------------------------------
-- Per-persona VOICE selection, editable in-app, no redeploy.
--
-- Why: Ed switched the live avatar to Tessa in a client meeting (My
-- Neighborhood News) and only then heard she had a British accent. Her voice
-- was "Elenora - Professional", a British-reading HeyGen voice, set through the
-- TESSA_VOICE_ID env var. Choosing a voice meant editing Render and redeploying,
-- with no way to audition first, so a wrong accent reached a client unnoticed.
--
-- This table lets Ed pick each teammate's voice by ear from the /admin/voices
-- picker and have it take effect immediately. Keyed by FACE (the same token the
-- *_VOICE_ID env vars use, e.g. TESSA / CLAIRE) so a saved override lines up
-- with the env value it replaces. When a face has a row here, it wins over the
-- env var; when it doesn't, the env var (or none) still applies. So this is
-- additive and safe: existing configured voices keep working until Ed changes
-- one on purpose.
--
-- Record ownership: workpaper — this is Bedrock's own AI-team production config,
-- not an association record.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS persona_voices (
  face         text PRIMARY KEY,            -- e.g. 'TESSA', 'CLAIRE' (matches *_VOICE_ID env token)
  voice_id     text NOT NULL,               -- HeyGen voice_id
  voice_name   text,                        -- human label at the time it was chosen
  updated_by   text,                        -- owner email that set it
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- updated_at maintenance via the shared trigger helper.
DROP TRIGGER IF EXISTS trg_persona_voices_updated_at ON persona_voices;
CREATE TRIGGER trg_persona_voices_updated_at
  BEFORE UPDATE ON persona_voices
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON persona_voices TO service_role;

COMMIT;
