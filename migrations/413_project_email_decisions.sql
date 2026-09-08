-- ============================================================================
-- 413_project_email_decisions.sql  (Ed 2026-09-08)
-- ----------------------------------------------------------------------------
-- The projects that run a community are decided in STAFF email (the community
-- manager, the team), not in a form — so the project tracker drifts from reality
-- and the newsletter printed "Board Deciding" for work already approved. This
-- table is the REVIEW QUEUE + reconciled record for project/vendor decisions the
-- platform extracts from staff correspondence (lib/events/project_decisions.js).
--
-- Extraction PROPOSES (review_status='pending'); a human confirms before anything
-- resident-facing (the newsletter's Project Watch) reads it. Every row carries the
-- SOURCE email so an "Approved" is always verifiable.
--
-- Record ownership: 'mixed'. A CONFIRMED decision that reaches a board member or
-- the newsletter is an association record; the raw extraction/proposal is Bedrock
-- workpaper. Splits at export time on review_status + what was delivered.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS project_email_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  project         text NOT NULL,
  status          text NOT NULL CHECK (status IN ('approved','declined','deferred','in_progress','completed','proposed')),
  amount_cents    bigint,
  vendor          text,
  decided_by      text,
  decided_on      date,
  quote           text,
  source          jsonb,                       -- { from, subject, received_at, graph_id }
  -- normalized (community + project) key so a re-scan updates a pending row in
  -- place instead of piling up duplicates.
  dedup_key       text NOT NULL,
  review_status   text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','confirmed','dismissed')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  record_ownership text NOT NULL DEFAULT 'mixed',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ped_community_dedup
  ON project_email_decisions (community_id, dedup_key);
CREATE INDEX IF NOT EXISTS ix_ped_community_review
  ON project_email_decisions (community_id, review_status);

DROP TRIGGER IF EXISTS trg_ped_updated_at ON project_email_decisions;
CREATE TRIGGER trg_ped_updated_at BEFORE UPDATE ON project_email_decisions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON project_email_decisions TO service_role;
GRANT SELECT                          ON project_email_decisions TO authenticated;

COMMIT;
