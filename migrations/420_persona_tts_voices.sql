-- ============================================================================
-- 420_persona_tts_voices.sql  (Ed 2026-09-13)
-- ----------------------------------------------------------------------------
-- Per-teammate ElevenLabs SPOKEN voice, chosen by ear in /admin/voices — the
-- audio the homeowner hears on the /claire portal voice and the phone. This is
-- SEPARATE from persona_voices (mig 414), which holds the HeyGen *avatar* voice.
-- Until now every teammate spoke in one hardcoded English voice (Ava), so Mei
-- answered Mandarin and Isabella answered Spanish in an English voice. Keyed by
-- FACE (same token the ${FACE}_TTS_VOICE_ID env vars use); a row wins over env.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS persona_tts_voices (
  face        text PRIMARY KEY,
  voice_id    text NOT NULL,
  voice_name  text,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON persona_tts_voices TO service_role;
GRANT SELECT                          ON persona_tts_voices TO authenticated;

COMMIT;
