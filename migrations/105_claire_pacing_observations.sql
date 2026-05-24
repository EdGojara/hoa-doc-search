-- ============================================================================
-- 105_claire_pacing_observations.sql
-- ----------------------------------------------------------------------------
-- Post-call structured findings about Claire's pacing behavior. After every
-- inbound call ends, lib/voice/post_call_review.js runs a Haiku review of the
-- transcript and writes a row per pacing failure it detects (interruption,
-- awkward silence, misread intent, didn't surface exception, etc.). Ed
-- reviews periodically and decides which patterns to encode into the system
-- prompt or per-community config.
--
-- This is the "Claire learns" capability — without this, the same pacing
-- mistakes happen on every call indefinitely because nothing reviews them.
-- With this, patterns accumulate, get reviewed, get encoded — same loop Ed
-- used over 15 years of HOA management, just instrumented and structured.
--
-- Record-ownership bucket: workpaper. These are Bedrock's internal quality
-- observations about its own AI assistant, never delivered to a board or
-- homeowner. Not part of the association record.
--
-- Apply after migration 104. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS claire_pacing_observations (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id               UUID REFERENCES homeowner_calls(id) ON DELETE CASCADE,
  -- Categorical bucket so we can roll up patterns over time. Values are open
  -- to expansion; CHECK keeps the existing categories explicit.
  observation_type      TEXT NOT NULL
                        CHECK (observation_type IN (
                          'interrupted_caller',         -- Claire spoke while caller was mid-thought
                          'awkward_silence',            -- dead air 3+ seconds where backchannel/response was expected
                          'misread_intent',             -- caller asked X, Claire responded to Y
                          'missed_exception',           -- gave a general rule when an exception/carve-out existed in docs
                          'over_long_response',         -- Claire monologued, should have been more concise
                          'under_responsive',           -- caller asked complex question, got terse non-answer
                          'wrong_handoff_decision',     -- offered/didn't offer warm-transfer when opposite was right
                          'wrong_tone',                 -- formality/register mismatch with caller
                          'other'                       -- catch-all; reasoning field has detail
                        )),
  description           TEXT NOT NULL,                  -- one-sentence summary of what went wrong
  example_text          TEXT,                           -- relevant snippet of transcript (Claire's + caller's lines)
  severity              TEXT NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('low','medium','high')),
  -- Human-review state. Ed periodically sweeps these.
  reviewed_by_ed        BOOLEAN NOT NULL DEFAULT FALSE,
  reviewer_notes        TEXT,                           -- Ed's notes when reviewing
  -- Promotion to behavior change. Tracks the "encoded → shipped" lifecycle.
  encoded_to_prompt     BOOLEAN NOT NULL DEFAULT FALSE,
  encoded_at            TIMESTAMPTZ,
  encoded_notes         TEXT,                           -- which prompt section / config got changed
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot indexes — reviewing recent unreviewed, rolling up by type for patterns.
CREATE INDEX IF NOT EXISTS idx_claire_pacing_obs_unreviewed
  ON claire_pacing_observations(created_at DESC)
  WHERE reviewed_by_ed = FALSE;
CREATE INDEX IF NOT EXISTS idx_claire_pacing_obs_by_type
  ON claire_pacing_observations(observation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claire_pacing_obs_by_call
  ON claire_pacing_observations(call_id);

-- Standard grants per repo convention (004_grants.sql pattern + 103 voice).
GRANT SELECT, INSERT, UPDATE ON claire_pacing_observations TO authenticated, service_role;

COMMIT;

-- Verification: confirm table + grants landed.
--   SELECT COUNT(*) FROM claire_pacing_observations;     -- 0 rows initially, no error means table exists
--   SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_name = 'claire_pacing_observations';
