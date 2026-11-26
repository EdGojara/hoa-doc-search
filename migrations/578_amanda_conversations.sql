-- ============================================================================
-- 578_amanda_conversations.sql  (Ed 2026-11-26: Talk to Amanda, stage 1)
-- ----------------------------------------------------------------------------
-- Conversational Amanda reuses the EXISTING conversation store instead of a
-- parallel one: claire_sessions / claire_session_turns (366, 368) already hold
-- persona conversations with a staff identity (role 'staff', staff_user_id),
-- the active persona and a per-turn persona. This migration:
--
--   1. claire_sessions: new surface 'conversation' (a teammate talking with a
--      signed-in Bedrock user, by voice or text); channel, provider and the
--      provider's own conversation id; measured metrics (latency per turn,
--      barge-ins, failures) and measured cost / audio seconds; finalized_at
--      (summary and memory extraction done).
--   2. claire_session_turns: speaker 'teammate' (any AI teammate; the persona
--      column says which), the measured latency of that turn and the tools it
--      used.
--   3. amanda_memory: what Amanda keeps between conversations (facts,
--      preferences, commitments, open threads), one row per item, linked to the
--      conversation it came from, the community and the objective that tracks
--      it. ONE memory for every channel (voice, text, email).
--   4. agent_runs.run_kind gains 'conversation': one usage row per conversation
--      (audio minutes, provider cost, turns, tool calls) beside the per-call
--      model rows the router already writes.
--
-- Record ownership: claire_sessions rows on surface 'conversation' are
-- written with record_ownership = 'workpaper' (internal Bedrock operating
-- conversation). amanda_memory is 'workpaper' (Bedrock's memory layer, never an
-- association record); community_id is kept so a termination export can
-- confirm nothing of the association's lives only here.
-- No existing row is changed.
-- ============================================================================
BEGIN;

-- 1. claire_sessions -----------------------------------------------------------
ALTER TABLE claire_sessions DROP CONSTRAINT IF EXISTS claire_sessions_surface_check;
ALTER TABLE claire_sessions ADD CONSTRAINT claire_sessions_surface_check
  CHECK (surface IN ('visit', 'chamber', 'kiosk', 'conversation'));

ALTER TABLE claire_sessions
  ADD COLUMN IF NOT EXISTS channel                  TEXT,
  ADD COLUMN IF NOT EXISTS provider                 TEXT,
  ADD COLUMN IF NOT EXISTS provider_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS metrics                  JSONB,
  ADD COLUMN IF NOT EXISTS cost_usd                 NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS audio_seconds            INTEGER,
  ADD COLUMN IF NOT EXISTS finalized_at             TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claire_sessions_channel_check') THEN
    ALTER TABLE claire_sessions ADD CONSTRAINT claire_sessions_channel_check
      CHECK (channel IS NULL OR channel IN ('voice', 'text', 'phone', 'email'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_claire_sessions_conversations
  ON claire_sessions (staff_user_id, started_at DESC) WHERE surface = 'conversation';
CREATE INDEX IF NOT EXISTS idx_claire_sessions_provider_conv
  ON claire_sessions (provider_conversation_id) WHERE provider_conversation_id IS NOT NULL;

-- 2. claire_session_turns ------------------------------------------------------
ALTER TABLE claire_session_turns DROP CONSTRAINT IF EXISTS claire_session_turns_speaker_check;
ALTER TABLE claire_session_turns ADD CONSTRAINT claire_session_turns_speaker_check
  CHECK (speaker IN ('visitor', 'claire', 'system', 'teammate'));

ALTER TABLE claire_session_turns
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS tool_calls JSONB;

-- 3. amanda_memory -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amanda_memory (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'commitment', 'open_thread', 'person')),
  content           TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
  community_id      UUID REFERENCES communities(id) ON DELETE SET NULL,
  objective_id      UUID REFERENCES objectives(id) ON DELETE SET NULL,
  source_session_id UUID REFERENCES claire_sessions(id) ON DELETE SET NULL,
  source_channel    TEXT CHECK (source_channel IS NULL OR source_channel IN ('voice', 'text', 'phone', 'email')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'superseded')),
  record_ownership  TEXT NOT NULL DEFAULT 'workpaper' CHECK (record_ownership = 'workpaper'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_amanda_memory_owner_active
  ON amanda_memory (owner_user_id, updated_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_amanda_memory_session ON amanda_memory (source_session_id);
CREATE INDEX IF NOT EXISTS idx_amanda_memory_objective ON amanda_memory (objective_id);
CREATE INDEX IF NOT EXISTS idx_amanda_memory_community ON amanda_memory (community_id);

DROP TRIGGER IF EXISTS trg_amanda_memory_updated ON amanda_memory;
CREATE TRIGGER trg_amanda_memory_updated BEFORE UPDATE ON amanda_memory
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE amanda_memory ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON amanda_memory TO service_role;

-- 4. agent_runs: one usage row per conversation --------------------------------
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_kind_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_kind_check
  CHECK (run_kind IS NULL OR run_kind IN ('trade_tape', 'model_call', 'conversation'));

COMMIT;
