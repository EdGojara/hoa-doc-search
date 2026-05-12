-- ============================================================================
-- 025_email_intake_and_recaps.sql
-- ----------------------------------------------------------------------------
-- Email Intelligence module — the encode-Ed thesis closing the loop.
--
-- Today: institutional knowledge dies in inboxes. Pool company says hours
--        change → buried in a thread → six months later nobody can find it.
-- Now:   Paste the thread → Claude extracts structured facts/decisions/
--        contacts → review → click Approve → it flows into the Community
--        Facts library. Then periodic recaps roll it all up for board vs
--        internal audiences, with manager-controlled filtering.
--
-- Three tables:
--   email_intake        raw email thread + Claude's structured extraction
--   community_decisions discrete decisions (board approved X on Y date)
--                       with board_visible toggle for recap filtering
--   community_recaps    generated periodic summaries by audience
--
-- Linked to existing community_facts table from migration 023:
--   approved intake → upserts community_facts rows → AskEd reads them
--   automatically on every question for that community.
--
-- Apply AFTER 024. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. email_intake — captured threads + extraction
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_intake (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id       UUID NOT NULL REFERENCES management_companies(id),
  community_id                UUID REFERENCES communities(id) ON DELETE SET NULL,

  -- Source content
  subject                     TEXT,
  raw_content                 TEXT NOT NULL,                       -- the pasted/forwarded email body
  source                      TEXT NOT NULL DEFAULT 'manual_paste'
                                CHECK (source IN ('manual_paste', 'email_forward', 'upload')),
  sender_hint                 TEXT,                                -- "Mike from Houston Pool Co" — free-form

  -- Extraction state
  extraction_status           TEXT NOT NULL DEFAULT 'pending'
                                CHECK (extraction_status IN ('pending', 'extracted', 'approved', 'rejected', 'error')),
  extracted_summary           TEXT,                                -- one-line summary
  extracted_data              JSONB,                               -- full Claude output (vendors, facts, decisions, actions)
  extraction_confidence       TEXT
                                CHECK (extraction_confidence IS NULL OR extraction_confidence IN ('high', 'medium', 'low')),
  extraction_error            TEXT,
  extraction_model            TEXT,

  -- Routing
  board_relevant              BOOLEAN NOT NULL DEFAULT FALSE,      -- Claude's call; manager can override
  urgency                     TEXT
                                CHECK (urgency IS NULL OR urgency IN ('high', 'medium', 'low')),

  -- Audit
  ingested_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by                 UUID,
  extracted_at                TIMESTAMPTZ,
  approved_at                 TIMESTAMPTZ,
  approved_by                 UUID,
  promoted_fact_ids           JSONB,                               -- array of community_facts ids created on approval
  promoted_decision_ids       JSONB,                               -- array of community_decisions ids created on approval

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_intake_community
  ON email_intake(management_company_id, community_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_intake_status
  ON email_intake(management_company_id, extraction_status, ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_intake_urgency
  ON email_intake(urgency) WHERE urgency = 'high';

DROP TRIGGER IF EXISTS trg_email_intake_updated_at ON email_intake;
CREATE TRIGGER trg_email_intake_updated_at
  BEFORE UPDATE ON email_intake
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. community_decisions — discrete decisions (with board_visible filter)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS community_decisions (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id       UUID NOT NULL REFERENCES management_companies(id),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  -- What was decided
  decision_summary            TEXT NOT NULL,                       -- "Board approved 8pm pool closing for August"
  decision_detail             TEXT,                                -- longer narrative if needed
  category                    TEXT,                                -- 'pool' | 'vendor' | 'governance' | 'amenities' | ...
  decided_at                  TIMESTAMPTZ,
  decided_by                  TEXT,                                -- 'board' | 'manager' | 'vendor' | "Ed Gojara"

  -- Source / provenance
  source_email_intake_id      UUID REFERENCES email_intake(id) ON DELETE SET NULL,
  promoted_to_fact_id         UUID REFERENCES community_facts(id) ON DELETE SET NULL,

  -- Recap filtering — manager controls what the board sees
  board_visible               BOOLEAN NOT NULL DEFAULT FALSE,
  internal_visible            BOOLEAN NOT NULL DEFAULT TRUE,
  community_visible           BOOLEAN NOT NULL DEFAULT FALSE,      -- public-facing recap (later)

  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_decisions_community
  ON community_decisions(community_id, decided_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_community_decisions_board_visible
  ON community_decisions(community_id, board_visible, decided_at DESC) WHERE board_visible;

DROP TRIGGER IF EXISTS trg_community_decisions_updated_at ON community_decisions;
CREATE TRIGGER trg_community_decisions_updated_at
  BEFORE UPDATE ON community_decisions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. community_recaps — generated periodic summaries
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS community_recaps (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id       UUID NOT NULL REFERENCES management_companies(id),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,

  audience                    TEXT NOT NULL
                                CHECK (audience IN ('board', 'internal', 'community')),
  period_start                DATE NOT NULL,
  period_end                  DATE NOT NULL,

  -- Generated content
  title                       TEXT,
  summary_markdown            TEXT NOT NULL,
  included_decision_ids       JSONB,                               -- array of UUIDs
  included_fact_ids           JSONB,
  included_event_ids          JSONB,
  included_intake_ids         JSONB,
  generation_model            TEXT,

  -- Workflow
  status                      TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'sent', 'archived')),
  generated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by                UUID,
  sent_at                     TIMESTAMPTZ,
  sent_to                     TEXT,                                -- comma-separated email list

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_recaps_community
  ON community_recaps(community_id, audience, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_community_recaps_status
  ON community_recaps(management_company_id, status, generated_at DESC);

DROP TRIGGER IF EXISTS trg_community_recaps_updated_at ON community_recaps;
CREATE TRIGGER trg_community_recaps_updated_at
  BEFORE UPDATE ON community_recaps
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

COMMIT;

-- ----------------------------------------------------------------------------
-- Verify:
--   SELECT extraction_status, COUNT(*) FROM email_intake GROUP BY extraction_status;
--   SELECT decision_summary, decided_at, board_visible FROM community_decisions ORDER BY decided_at DESC LIMIT 5;
--   SELECT audience, period_start, period_end, status FROM community_recaps ORDER BY generated_at DESC LIMIT 5;
-- ----------------------------------------------------------------------------
