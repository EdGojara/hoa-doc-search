-- ============================================================================
-- 352_board_motions.sql
-- ----------------------------------------------------------------------------
-- Board motions + voting (Ed 2026-08-09). Fiduciary board decisions recorded
-- and voted on IN the board portal: a motion ("approve the Versatex sidewalk
-- estimate"), each active board member's vote (for / against / abstain), and
-- the computed result with quorum. Answers a board's core question — "what did
-- we decide, who voted how, did it pass" — with a permanent, per-member record.
--
-- This is DISTINCT from the homeowner election app (bedrock-vote): that runs
-- community-wide statutory elections; this is internal board approvals. No
-- shared tables, no shared code — see memory feedback_voting_app.
--
-- Motions are the raw material of minutes, so a motion can optionally link to
-- the meeting where it was decided (meeting_minutes) and to the project it
-- authorizes (vendor_projects).
--
-- Record ownership: association_record — board votes ARE the HOA's record and
-- must be handed over on termination (they belong in the minutes).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS board_motions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id uuid NOT NULL,
  community_id          uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  description           text,
  motion_type           text NOT NULL DEFAULT 'general'
                          CHECK (motion_type IN ('general','project','vendor','budget','arc','policy','contract','other')),
  related_project_id    uuid REFERENCES vendor_projects(id) ON DELETE SET NULL,
  meeting_minutes_id    uuid REFERENCES meeting_minutes(id) ON DELETE SET NULL,
  threshold             text NOT NULL DEFAULT 'simple_majority'
                          CHECK (threshold IN ('simple_majority','two_thirds','unanimous')),
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','passed','failed','withdrawn','tabled')),
  seats_at_open         int,                       -- active board size at open (quorum math)
  voting_deadline       timestamptz,
  created_via           text NOT NULL DEFAULT 'portal'
                          CHECK (created_via IN ('portal','staff_recorded')),
  created_by_email      text,
  created_by_name       text,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  closed_by             text,
  outcome_note          text,
  record_ownership      text NOT NULL DEFAULT 'association_record',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_board_motions_community
  ON board_motions(community_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_motions_open
  ON board_motions(community_id, status) WHERE status = 'open';

-- One row per board member per motion (a member may change their vote before
-- the motion closes → UPDATE the same row, enforced by the unique constraint).
CREATE TABLE IF NOT EXISTS board_motion_votes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  motion_id         uuid NOT NULL REFERENCES board_motions(id) ON DELETE CASCADE,
  voter_email       text NOT NULL,
  voter_name        text,
  vote              text NOT NULL CHECK (vote IN ('for','against','abstain')),
  comment           text,
  recorded_by_email text,                          -- set when staff records on behalf
  voted_at          timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (motion_id, voter_email)
);

CREATE INDEX IF NOT EXISTS idx_board_motion_votes_motion
  ON board_motion_votes(motion_id);

DROP TRIGGER IF EXISTS trg_board_motions_updated_at ON board_motions;
CREATE TRIGGER trg_board_motions_updated_at
  BEFORE UPDATE ON board_motions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_board_motion_votes_updated_at ON board_motion_votes;
CREATE TRIGGER trg_board_motion_votes_updated_at
  BEFORE UPDATE ON board_motion_votes
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON board_motions      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON board_motion_votes TO service_role;
GRANT SELECT                          ON board_motions      TO authenticated;
GRANT SELECT                          ON board_motion_votes TO authenticated;

COMMIT;
