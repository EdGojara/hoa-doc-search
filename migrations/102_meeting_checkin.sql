-- ============================================================================
-- 102_meeting_checkin.sql
-- ----------------------------------------------------------------------------
-- In-person annual-meeting sign-in / attendance tracking for HOA elections.
--
-- Built for Canyon Gate's 2026-05-27 annual meeting (first instance) and
-- designed to generalize to every Bedrock community's annual meeting.
-- ----------------------------------------------------------------------------
-- ARCHITECTURE — read-only on the voting app, writes only here
--
-- Bedrock's voting platform lives in a SEPARATE Supabase project at
-- VOTING_SUPABASE_URL (set in Render env). The trustEd backend reads
-- voter rosters + ballot statuses from there via the publishable
-- (read-only) key. trustEd NEVER writes to the voting database. All
-- attendance + meeting-settings data lives in THIS Supabase, in the
-- two tables below. The external_election_id and external_voter_id
-- columns are loose references (text-typed UUIDs) — no FK to voting
-- DB because we're cross-database.
--
-- This isolation is the safety property Ed asked for ("don't touch
-- the voting module"). The voting app continues working unmodified;
-- the sign-in app is a strictly additive layer.
-- ----------------------------------------------------------------------------
-- RECORD OWNERSHIP — per CLAUDE.md three-bucket discipline
--
-- meeting_attendance: association_record
--   Sign-in evidence for an annual meeting is part of the Association's
--   quorum-evidence + member-participation records. Required to be
--   handed over on contract termination.
--
-- meeting_election_settings: association_record
--   Meeting metadata (quorum threshold, secretary name, etc.) belongs to
--   the Association.
--
-- The voting app's data (voters, ballots, candidates, elections) is also
-- association_record but lives in a separate database not governed by
-- this migration.
-- ----------------------------------------------------------------------------
-- Apply after 101. Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING
-- on seeds).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- meeting_election_settings — per-election meeting metadata
-- ----------------------------------------------------------------------------
-- One row per (community, voting-app election). Created by Bedrock staff
-- before the meeting via /meeting-checkin-setup.html. Holds the quorum
-- threshold, secretary name, meeting location, etc. — everything that's
-- needed for the quorum-evidence PDF but doesn't live in the voting DB.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_election_settings (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  external_election_id        TEXT NOT NULL,           -- election UUID from voting app
  community_name              TEXT,                    -- denormalized snapshot
  election_name               TEXT,                    -- denormalized snapshot
  meeting_date                DATE,
  meeting_time                TEXT,
  meeting_location            TEXT,
  -- Quorum math configuration
  total_voting_units          INTEGER,                 -- total sum(vote_weight) from voting app at setup time
  quorum_basis                TEXT NOT NULL DEFAULT 'all_voters'
                              CHECK (quorum_basis IN ('all_voters','membership','votes_cast','units_present')),
  quorum_threshold_percent    NUMERIC(5,2),            -- e.g. 10.00 for 10%
  quorum_threshold_units      INTEGER,                 -- denormalized: total * pct / 100, rounded up
  quorum_clause_text          TEXT,                    -- exact wording from Bylaws (for PDF footer)
  -- Meeting officials
  secretary_name              TEXT,
  president_name              TEXT,
  parliamentarian_name        TEXT,
  -- Auditing
  created_by_staff            TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meeting_election_settings_unique_election
    UNIQUE (community_id, external_election_id)
);

CREATE INDEX IF NOT EXISTS idx_mes_community
  ON meeting_election_settings(community_id);
CREATE INDEX IF NOT EXISTS idx_mes_external_election
  ON meeting_election_settings(external_election_id);

DROP TRIGGER IF EXISTS trg_mes_updated_at ON meeting_election_settings;
CREATE TRIGGER trg_mes_updated_at
  BEFORE UPDATE ON meeting_election_settings
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();


-- ----------------------------------------------------------------------------
-- meeting_attendance — per-person in-person sign-in record
-- ----------------------------------------------------------------------------
-- One row per check-in event. Captures the voter's state-at-checkin
-- (denormalized — voting app's data might change after we read it).
-- Walk-in ballot status is tracked separately so staff can mark
-- "needed → entered" without affecting the attendance record itself.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_attendance (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  external_election_id        TEXT NOT NULL,
  external_voter_id           TEXT,                    -- voter UUID from voting app (nullable for write-ins)
  -- Snapshot at check-in (denormalized for resilience + audit)
  owner_name                  TEXT NOT NULL,
  lot_number                  TEXT,
  mailing_address             TEXT,
  vote_weight                 INTEGER NOT NULL DEFAULT 1,
  -- Vote status snapshot at the moment of check-in
  vote_status_at_checkin      TEXT NOT NULL
                              CHECK (vote_status_at_checkin IN ('voted_online','voted_mail','voted_walkin','not_voted','unknown')),
  vote_method_at_checkin      TEXT,                    -- raw vote_method from voters table
  ballot_cast_at              TIMESTAMPTZ,             -- if voted, when
  -- Attendance event
  checked_in_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_in_by_staff         TEXT,                    -- who at Bedrock checked them in
  attendance_note             TEXT,                    -- free-form
  -- Walk-in ballot lifecycle (if they didn't vote online/mail)
  walk_in_ballot_status       TEXT NOT NULL DEFAULT 'not_applicable'
                              CHECK (walk_in_ballot_status IN ('not_applicable','needed','entered','declined_to_vote')),
  walk_in_ballot_entered_at   TIMESTAMPTZ,
  walk_in_ballot_entered_by   TEXT,
  -- Auditing
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Prevent double-checkin for the same voter at the same election
  CONSTRAINT meeting_attendance_no_double_checkin
    UNIQUE (external_election_id, external_voter_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_election
  ON meeting_attendance(external_election_id);
CREATE INDEX IF NOT EXISTS idx_attendance_community
  ON meeting_attendance(community_id);
CREATE INDEX IF NOT EXISTS idx_attendance_voter
  ON meeting_attendance(external_voter_id);
CREATE INDEX IF NOT EXISTS idx_attendance_checked_in_at
  ON meeting_attendance(checked_in_at);
CREATE INDEX IF NOT EXISTS idx_attendance_walkin_status
  ON meeting_attendance(walk_in_ballot_status)
  WHERE walk_in_ballot_status IN ('needed','entered');

DROP TRIGGER IF EXISTS trg_attendance_updated_at ON meeting_attendance;
CREATE TRIGGER trg_attendance_updated_at
  BEFORE UPDATE ON meeting_attendance
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();


-- ----------------------------------------------------------------------------
-- Grants — anon + authenticated + service_role
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON meeting_election_settings
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON meeting_attendance
  TO authenticated, service_role;
GRANT SELECT ON meeting_election_settings TO anon;
GRANT SELECT ON meeting_attendance TO anon;

COMMIT;

-- ----------------------------------------------------------------------------
-- Post-apply verification (run separately, not part of the BEGIN/COMMIT)
-- ----------------------------------------------------------------------------
-- SELECT table_name FROM information_schema.tables
--  WHERE table_name IN ('meeting_attendance','meeting_election_settings');
