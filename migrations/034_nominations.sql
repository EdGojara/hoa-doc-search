-- ============================================================================
-- 034_nominations.sql
-- ----------------------------------------------------------------------------
-- Annual meeting nomination cycles and homeowner-submitted nominations.
-- Each community has one open nomination cycle leading up to its annual
-- meeting. Homeowners (or other homeowners on their behalf) submit nominations
-- via a public landing page (same pattern as the ARC application form):
-- nominate themselves or a neighbor, attach a bio statement, e-sign, submit.
--
-- Apply AFTER 033. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS nomination_cycles (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  community_id                UUID NOT NULL,
  community_name              TEXT NOT NULL,
  -- The annual meeting this cycle leads to
  annual_meeting_date         DATE NOT NULL,
  annual_meeting_location     TEXT NULL,
  annual_meeting_time         TEXT NULL,
  -- Nominations window
  nominations_open_at         DATE NOT NULL,
  nominations_close_at        DATE NOT NULL,
  -- How many seats are open this cycle
  seats_open                  INTEGER NOT NULL DEFAULT 1,
  -- Snapshot of current board members (for the call-for-nominations letter)
  -- e.g., [{"name":"Jane Smith","position":"President","term_end":"2026-06"}]
  current_board               JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Optional notes / context for the letter ("we have 2 open seats,
  -- one President seat and one At-Large")
  description                 TEXT NULL,
  -- URL slug used for the public form (defaults to community.slug if blank)
  public_slug                 TEXT NULL,
  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'planned'
                                CHECK (status IN ('planned', 'open', 'closed', 'finalized')),
  -- Branded letter
  letter_pdf_storage_path     TEXT NULL,
  -- Audit
  created_by                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nomination_cycles_community
  ON nomination_cycles (community_id, annual_meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_nomination_cycles_status
  ON nomination_cycles (status, nominations_close_at DESC);
CREATE INDEX IF NOT EXISTS idx_nomination_cycles_slug
  ON nomination_cycles (public_slug)
  WHERE public_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS nominations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id                    UUID NOT NULL REFERENCES nomination_cycles(id) ON DELETE CASCADE,
  -- Nominee — the person being nominated for the board
  nominee_name                TEXT NOT NULL,
  nominee_address             TEXT NOT NULL,
  nominee_email               TEXT NULL,
  nominee_phone               TEXT NULL,
  -- Bio statement / qualifications (the candidate's pitch)
  nominee_bio                 TEXT NULL,
  -- Was the nominee themselves submitting, or was someone else nominating them?
  is_self_nomination          BOOLEAN NOT NULL DEFAULT FALSE,
  -- If not self, who submitted on the nominee's behalf
  nominator_name              TEXT NULL,
  nominator_email             TEXT NULL,
  nominator_address           TEXT NULL,
  -- E-signature (typed full name + agreement)
  signature_name              TEXT NOT NULL,
  signed_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agreed_to_terms             BOOLEAN NOT NULL DEFAULT FALSE,
  -- Audit
  client_ip                   INET NULL,
  user_agent                  TEXT NULL,
  -- Manager review state
  manager_notes               TEXT NULL,
  status                      TEXT NOT NULL DEFAULT 'submitted'
                                CHECK (status IN ('submitted', 'verified', 'on_slate', 'withdrawn', 'rejected')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nominations_cycle
  ON nominations (cycle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nominations_status
  ON nominations (cycle_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON nomination_cycles TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON nominations TO anon, authenticated, service_role;

COMMIT;

-- Verify:
--   SELECT id, community_name, annual_meeting_date, status
--     FROM nomination_cycles ORDER BY created_at DESC LIMIT 5;
