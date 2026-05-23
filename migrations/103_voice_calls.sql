-- ============================================================================
-- 103_voice_calls.sql
-- ----------------------------------------------------------------------------
-- Claire — voice persona infrastructure. Two tables:
--
--   voice_phone_routes  — maps an inbound Twilio phone number to a Bedrock
--                         community + handoff (human) phone number. One row
--                         per community Claire serves.
--
--   homeowner_calls     — per-call log: full transcript, Stage-1 brief
--                         extracted async, handoff status, duration. Tagged
--                         `record_ownership = association_record` per the
--                         CLAUDE.md three-bucket discipline — these are
--                         records of inbound homeowner communication on
--                         behalf of the Association, must transfer on
--                         contract termination.
-- ----------------------------------------------------------------------------
-- See:
--   lib/voice/README.md             — architecture + setup checklist
--   lib/voice/persona.js            — Claire's name, voice config, openers
--   templates/responder-engine.spec.md §5 — persona + handoff design
-- ----------------------------------------------------------------------------
-- Apply after migration 102. Idempotent (IF NOT EXISTS + safe re-runs).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- voice_phone_routes — one row per Bedrock-managed community
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_phone_routes (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  -- The Twilio phone number callers dial (E.164 format, e.g. +18325551234)
  inbound_phone_number     TEXT NOT NULL UNIQUE,
  -- The human (community manager's) phone number Claire warm-transfers to
  -- when handoff is required (E.164 format)
  handoff_phone_number     TEXT,
  -- Display name read aloud in the Claire opener
  community_display_name   TEXT,
  -- Off-hours behavior — when staff isn't available, what does Claire say?
  -- Options: 'voicemail' (record + log), 'after_hours_message' (read a
  -- canned closing), 'emergency_only' (escalate everything to on-call)
  off_hours_behavior       TEXT NOT NULL DEFAULT 'voicemail'
                           CHECK (off_hours_behavior IN ('voicemail','after_hours_message','emergency_only')),
  -- Business hours, stored as text JSON for now ("Mon-Fri 8a-5p" style)
  business_hours_json      JSONB,
  -- Whether Claire is enabled at all for this community — kill switch
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  -- Auditing
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_routes_community ON voice_phone_routes(community_id);
CREATE INDEX IF NOT EXISTS idx_voice_routes_enabled ON voice_phone_routes(enabled) WHERE enabled = TRUE;

DROP TRIGGER IF EXISTS trg_voice_routes_updated_at ON voice_phone_routes;
CREATE TRIGGER trg_voice_routes_updated_at
  BEFORE UPDATE ON voice_phone_routes
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();


-- ----------------------------------------------------------------------------
-- homeowner_calls — per-call record
-- ----------------------------------------------------------------------------
-- One row per inbound call to a Claire-routed number. The call_sid is
-- Twilio's unique identifier; we use it as the natural key for upserts
-- during the call lifecycle.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS homeowner_calls (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  voice_route_id           UUID REFERENCES voice_phone_routes(id) ON DELETE SET NULL,
  -- Twilio call SID — globally unique for the call. Used as natural key.
  call_sid                 TEXT NOT NULL UNIQUE,
  -- Caller phone (E.164) — may match a known homeowner via contacts table
  caller_phone             TEXT,
  caller_homeowner_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Lifecycle status — updated as the call progresses
  status                   TEXT NOT NULL DEFAULT 'ringing'
                           CHECK (status IN ('ringing','in_progress','handed_off','completed','dropped','failed')),
  -- Timing
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at              TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  duration_seconds         INTEGER,
  -- Conversation content
  full_transcript          TEXT,                 -- raw alternating "User:" / "Claire:" lines
  turn_count               INTEGER DEFAULT 0,    -- # of homeowner turns (heuristic for engagement)
  -- Post-call Stage-1 brief — extracted async after the call ends. JSONB
  -- matching the schema in templates/responder-engine.spec.md §3:
  --   { concern, answer_or_status, next_step, owner, specific_detail,
  --     channel='voice', category, escalate, escalate_reason, compliance_flag }
  brief                    JSONB,
  brief_extracted_at       TIMESTAMPTZ,
  -- Handoff (warm transfer to a human)
  handoff_offered          BOOLEAN NOT NULL DEFAULT FALSE,
  handoff_accepted         BOOLEAN,
  handoff_reason           TEXT,                 -- 'caller_requested' | 'unresolvable' | 'compliance' | 'distressed'
  handoff_at               TIMESTAMPTZ,
  -- Compliance flag — set if any turn hit §209 / enforcement / fines /
  -- waivers / etc. When TRUE, the call must be reviewed by staff and may
  -- not be considered fully resolved without that review.
  compliance_flag          BOOLEAN NOT NULL DEFAULT FALSE,
  compliance_reason        TEXT,
  -- Audit / debug
  raw_provider_metadata    JSONB,                -- Twilio + Deepgram + ElevenLabs metadata for debugging
  -- Auditing
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_community ON homeowner_calls(community_id);
CREATE INDEX IF NOT EXISTS idx_calls_caller_phone ON homeowner_calls(caller_phone);
CREATE INDEX IF NOT EXISTS idx_calls_caller_homeowner ON homeowner_calls(caller_homeowner_id) WHERE caller_homeowner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON homeowner_calls(started_at);
CREATE INDEX IF NOT EXISTS idx_calls_status ON homeowner_calls(status) WHERE status IN ('in_progress','handed_off');
CREATE INDEX IF NOT EXISTS idx_calls_compliance ON homeowner_calls(compliance_flag) WHERE compliance_flag = TRUE;

DROP TRIGGER IF EXISTS trg_calls_updated_at ON homeowner_calls;
CREATE TRIGGER trg_calls_updated_at
  BEFORE UPDATE ON homeowner_calls
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();


-- ----------------------------------------------------------------------------
-- Grants — anon read, authenticated/service_role full
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON voice_phone_routes TO authenticated, service_role;
GRANT SELECT ON voice_phone_routes TO anon;
GRANT SELECT, INSERT, UPDATE ON homeowner_calls TO authenticated, service_role;
GRANT SELECT ON homeowner_calls TO anon;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification (run outside the transaction)
-- ----------------------------------------------------------------------------
-- SELECT table_name FROM information_schema.tables
--  WHERE table_name IN ('voice_phone_routes','homeowner_calls');
