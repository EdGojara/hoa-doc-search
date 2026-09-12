-- ============================================================================
-- 417_voice_turn_perf.sql  (Ed 2026-09-12)
-- ----------------------------------------------------------------------------
-- Per-turn latency capture for the live phone Claire so we tune against REAL
-- production numbers (endpoint -> first audio), not a laptop's inflated hop.
-- Records the controllable slice per turn: time to Claire's first spoken
-- sentence, time to first audio byte out to the caller, and total turn time.
--
-- record_ownership: workpaper (Bedrock internal performance telemetry; not an
-- association record). Written server-side by lib/voice/bridge.js.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS voice_turn_perf (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  call_sid           text,
  community_id       uuid REFERENCES communities(id),
  question           text,
  first_sentence_ms  integer,   -- answer-start -> Claire's first sentence (brain)
  first_audio_ms     integer,   -- answer-start -> first audio byte to caller (brain + TTS)
  total_ms           integer,   -- answer-start -> full answer spoken
  model              text
);

CREATE INDEX IF NOT EXISTS idx_voice_turn_perf_created ON voice_turn_perf (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_turn_perf_community ON voice_turn_perf (community_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON voice_turn_perf TO service_role;
GRANT SELECT                          ON voice_turn_perf TO authenticated;

COMMIT;
