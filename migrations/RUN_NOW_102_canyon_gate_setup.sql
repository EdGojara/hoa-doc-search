-- ============================================================================
-- RUN_NOW_102_canyon_gate_setup.sql
-- ----------------------------------------------------------------------------
-- Single SQL paste for Canyon Gate's 2026-05-27 annual meeting prep.
--
-- This file is a copy of migration 102_meeting_checkin.sql followed by a
-- pre-seeded meeting_election_settings row for Canyon Gate so Ed doesn't
-- have to step through /meeting-checkin-setup.html manually for the bits
-- we already know (community_id, election_id, quorum %, Bylaws clause).
--
-- Paste this whole file into Supabase → SQL Editor → New Query → Run.
-- Safe to re-run: every statement is idempotent.
--
-- After this runs, Ed still needs to fill in (via the setup UI or another
-- UPDATE statement): meeting_time, meeting_location, secretary_name,
-- president_name. Those are operational details I don't have.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- meeting_election_settings — per-election meeting metadata
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_election_settings (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  external_election_id        TEXT NOT NULL,
  community_name              TEXT,
  election_name               TEXT,
  meeting_date                DATE,
  meeting_time                TEXT,
  meeting_location            TEXT,
  total_voting_units          INTEGER,
  quorum_basis                TEXT NOT NULL DEFAULT 'all_voters'
                              CHECK (quorum_basis IN ('all_voters','membership','votes_cast','units_present')),
  quorum_threshold_percent    NUMERIC(5,2),
  quorum_threshold_units      INTEGER,
  quorum_clause_text          TEXT,
  secretary_name              TEXT,
  president_name              TEXT,
  parliamentarian_name        TEXT,
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
CREATE TABLE IF NOT EXISTS meeting_attendance (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  community_id                UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  external_election_id        TEXT NOT NULL,
  external_voter_id           TEXT,
  owner_name                  TEXT NOT NULL,
  lot_number                  TEXT,
  mailing_address             TEXT,
  vote_weight                 INTEGER NOT NULL DEFAULT 1,
  vote_status_at_checkin      TEXT NOT NULL
                              CHECK (vote_status_at_checkin IN ('voted_online','voted_mail','voted_walkin','not_voted','unknown')),
  vote_method_at_checkin      TEXT,
  ballot_cast_at              TIMESTAMPTZ,
  checked_in_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_in_by_staff         TEXT,
  attendance_note             TEXT,
  walk_in_ballot_status       TEXT NOT NULL DEFAULT 'not_applicable'
                              CHECK (walk_in_ballot_status IN ('not_applicable','needed','entered','declined_to_vote')),
  walk_in_ballot_entered_at   TIMESTAMPTZ,
  walk_in_ballot_entered_by   TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
-- Grants
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON meeting_election_settings
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON meeting_attendance
  TO authenticated, service_role;
GRANT SELECT ON meeting_election_settings TO anon;
GRANT SELECT ON meeting_attendance TO anon;

-- ----------------------------------------------------------------------------
-- SEED: Canyon Gate 2026-05-27 annual meeting config
-- ----------------------------------------------------------------------------
-- Pre-fills everything we know from the voting platform + the 2020 Bylaws
-- Amendment we located in the document library. Ed still needs to set
-- meeting_time / meeting_location / secretary_name / president_name via
-- the setup UI before generating the quorum-evidence PDF.
--
-- Quorum source: "Amendment to Bylaws Regarding Quorum" recorded with
-- Fort Bend County Clerk's File 2020104400, August 11, 2020.
-- Quorum math: 25% of 721 voting units = ⌈180.25⌉ = 181 units required.
-- ----------------------------------------------------------------------------
INSERT INTO meeting_election_settings (
  community_id,
  external_election_id,
  community_name,
  election_name,
  meeting_date,
  total_voting_units,
  quorum_basis,
  quorum_threshold_percent,
  quorum_threshold_units,
  quorum_clause_text,
  created_by_staff
) VALUES (
  'a0000000-0000-4000-8000-000000000003',
  '46f098e9-057a-464a-9ac9-3ae07c47977a',
  'Canyon Gate at Cinco Ranch',
  '2026 Annual Meeting and Board Election',
  '2026-05-27',
  721,
  'all_voters',
  25.00,
  181,
  '3.4 QUORUM. The presence (in person, by proxy, or by absentee ballot) of twenty-five percent (25%) of the Members shall constitute a quorum for any purpose or action except as otherwise provided in these Bylaws, the Articles of Incorporation, of the Declaration. If a quorum is not present or represented, the Members at the meeting may adjourn and reconvene the meeting from time to time without notice except announcement at the meeting, and at each reconvened meeting, the quorum shall be one-half (½) of the quorum at the previously adjourned meeting, until a quorum is present and represented.

(Recorded as "Amendment to Bylaws Regarding Quorum," Fort Bend County Clerk''s File 2020104400, August 11, 2020.)',
  'Ed Gojara (pre-seed)'
) ON CONFLICT (community_id, external_election_id) DO UPDATE SET
  -- If somehow already exists (e.g., re-running this file after partial
  -- manual setup), update the auto-fillable bits without clobbering any
  -- meeting_time/meeting_location/secretary_name Ed may have entered.
  total_voting_units = EXCLUDED.total_voting_units,
  quorum_threshold_percent = EXCLUDED.quorum_threshold_percent,
  quorum_threshold_units = EXCLUDED.quorum_threshold_units,
  quorum_clause_text = EXCLUDED.quorum_clause_text,
  updated_at = NOW();

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification (run after COMMIT — outside the transaction)
-- ----------------------------------------------------------------------------
-- Confirm tables exist + seed row landed:
SELECT
  community_name,
  election_name,
  meeting_date,
  total_voting_units,
  quorum_threshold_percent || '%' AS quorum_pct,
  quorum_threshold_units || ' units' AS quorum_units,
  meeting_time,
  meeting_location,
  secretary_name
FROM meeting_election_settings
WHERE external_election_id = '46f098e9-057a-464a-9ac9-3ae07c47977a';

SELECT count(*) AS attendance_rows_so_far FROM meeting_attendance
WHERE external_election_id = '46f098e9-057a-464a-9ac9-3ae07c47977a';
