-- ============================================================================
-- 366_claire_visits.sql  (Ed 2026-08-16)
-- ----------------------------------------------------------------------------
-- VIRTUAL CLAIRE — the embodied face of the platform. One Claire, three doors:
-- homeowners, board members, and staff each start a "visit" (a teledoc-style
-- live video conversation) or watch her present in the Chamber.
--
-- This table is NOT a new AI silo. Claire's reasoning stays in lib/voice/reason
-- (the SAME brain that answers the phone); her retrieval stays in the unified
-- `documents` corpus. What lives here is the VISIT: who came to the door, what
-- scope they were granted, what was said, how long the avatar ran, and whether
-- it ended in a human handoff.
--
-- Two reasons this table has to exist rather than being fire-and-forget:
--   1) COST. A streaming photoreal avatar is metered per minute. Minutes that
--      aren't logged are a bill nobody can explain. avatar_seconds is written
--      on every session end and is the cost ledger.
--   2) RECORD. A conversation between a member and the association's own agent
--      is association correspondence. It is discoverable, and the member is
--      entitled to it. Hence record_ownership = 'association_record' and a hard
--      community FK so a termination export can hand it over.
--
-- Record ownership: association_record (member correspondence).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS claire_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id      UUID REFERENCES communities(id) ON DELETE CASCADE,

  -- Who is at the door. Exactly one identity column is set, matching `role`.
  role              TEXT NOT NULL
                      CHECK (role IN ('homeowner', 'board', 'staff')),
  portal_user_id    UUID,                     -- homeowner (portal cookie)
  board_email       TEXT,                     -- board member (magic-link viewer)
  staff_user_id     UUID,                     -- staff (trustEd login)
  visitor_name      TEXT,
  visitor_email     TEXT,
  property_id       UUID REFERENCES properties(id) ON DELETE SET NULL,

  -- Where the visit happened.
  --   visit   — one-to-one teledoc-style room (the default door)
  --   chamber — Claire presenting inside a meeting_broadcast
  --   kiosk   — unattended/lobby surface (future)
  surface           TEXT NOT NULL DEFAULT 'visit'
                      CHECK (surface IN ('visit', 'chamber', 'kiosk')),
  broadcast_id      UUID REFERENCES meeting_broadcasts(id) ON DELETE SET NULL,
  language          TEXT NOT NULL DEFAULT 'en'
                      CHECK (language IN ('en', 'es')),

  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'ended', 'handoff', 'expired', 'error')),

  -- The avatar. Provider-agnostic; we host no video and render no faces.
  avatar_provider   TEXT DEFAULT 'heygen'
                      CHECK (avatar_provider IN ('heygen', 'none', 'other')),
  avatar_id         TEXT,                     -- the locked Claire face
  avatar_session_id TEXT,                     -- provider's streaming session

  -- The cost ledger. seconds_cap is the kill switch: the server refuses to keep
  -- a session alive past it, so a forgotten open tab can never run up a bill.
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  avatar_seconds    INTEGER NOT NULL DEFAULT 0,
  seconds_cap       INTEGER NOT NULL DEFAULT 900,
  est_cost_cents    INTEGER NOT NULL DEFAULT 0,

  -- Outcome.
  handoff_requested BOOLEAN NOT NULL DEFAULT FALSE,
  handoff_reason    TEXT,
  summary           TEXT,                     -- post-visit recap (AI, reviewed)
  end_reason        TEXT,

  record_ownership  TEXT NOT NULL DEFAULT 'association_record',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claire_sessions_community ON claire_sessions(community_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_claire_sessions_active ON claire_sessions(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_claire_sessions_portal_user ON claire_sessions(portal_user_id);

-- The transcript. Every turn, including the ones the guardrail REFUSED — a
-- refusal that isn't recorded is indistinguishable from a question never asked,
-- and "what did the association's AI tell my client" is exactly the question an
-- attorney will ask. blocked_reason names which rule fired.
CREATE TABLE IF NOT EXISTS claire_session_turns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES claire_sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  speaker       TEXT NOT NULL CHECK (speaker IN ('visitor', 'claire', 'system')),
  text          TEXT,
  blocked_reason TEXT,
  citations     JSONB,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_claire_turns_session ON claire_session_turns(session_id, seq);

-- Pre-rendered explainers (the 45-second ARC video, EN + ES). Distinct from a
-- live visit: rendered once, served many times, costs nothing to replay. Keyed
-- by topic+language so a surface asks for "arc/es" and gets the current cut.
CREATE TABLE IF NOT EXISTS claire_explainers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  title         TEXT NOT NULL,
  script        TEXT NOT NULL,
  community_id  UUID REFERENCES communities(id) ON DELETE CASCADE,   -- NULL = portfolio-wide
  avatar_id     TEXT,
  provider_video_id TEXT,
  video_url     TEXT,
  duration_seconds INTEGER,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'rendering', 'ready', 'failed', 'retired')),
  render_error  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claire_explainer_topic_lang
  ON claire_explainers(topic, language, COALESCE(community_id, '00000000-0000-0000-0000-000000000000'::uuid));

DROP TRIGGER IF EXISTS trg_claire_sessions_updated ON claire_sessions;
CREATE TRIGGER trg_claire_sessions_updated BEFORE UPDATE ON claire_sessions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();
DROP TRIGGER IF EXISTS trg_claire_explainers_updated ON claire_explainers;
CREATE TRIGGER trg_claire_explainers_updated BEFORE UPDATE ON claire_explainers
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Grants: the API uses the service key. No `authenticated` write path — every
-- read is mediated by an endpoint that re-checks who the visitor is.
-- (Scar: new tables are silently unwritable without an explicit service_role grant.)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  claire_sessions, claire_session_turns, claire_explainers
  TO service_role;

COMMIT;
