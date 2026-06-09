-- ============================================================================
-- 210_arc_workflow_v2.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-09 — ARC/ACC workflow upgrade.
--
-- Closes the gap where staff finalized decisions but homeowners never
-- received the decision letter. Adds:
--   - completeness check fields (separate from full AI assessment)
--   - SLA timestamps for Texas §209 30-day defense
--   - decision letter draft + sent fields (the renderer was built but
--     never wired — see lib/decision_letter.js)
--   - per-community arc_approval_workflow column (defaults bedrock_only
--     so existing communities behave identically; flips to acc_majority
--     or acc_unanimous to opt into committee review)
--   - Phase-2 ACC committee scaffolding: community_arc_committee +
--     application_committee_votes tables (created idle; the multi-
--     reviewer flow plugs in next commit)
--
-- DESIGN BOUNDARIES (per Ed 2026-06-09):
--   - Reviewers see ONLY the application package (homeowner's form +
--     photos) and the proposed decision letter (what would be sent).
--   - Reviewers do NOT see internal AI multi-persona analysis,
--     Bedrock staff notes, or any internal IP.
--   - Letter signature is uniform "ARC of [Community] — administered by
--     Bedrock" regardless of which staff/reviewer signed off internally.
--     Internal audit tracks who; homeowner never sees individual names.
--
-- RECORD-OWNERSHIP CLASSIFICATION (per CLAUDE.md):
--   - community_applications: mixed
--       sent letter = association_record; AI assessments + drafts = workpaper
--   - community_arc_committee: association_record (board governance)
--   - application_committee_votes: mixed
--       vote results = association_record; voter comments = workpaper
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Per-community workflow setting
-- ----------------------------------------------------------------------------
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS arc_approval_workflow TEXT NOT NULL DEFAULT 'bedrock_only'
    CHECK (arc_approval_workflow IN ('bedrock_only', 'acc_majority', 'acc_unanimous'));

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS arc_acc_min_approvals INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN communities.arc_approval_workflow IS
  'Who finalizes ARC decisions. bedrock_only=staff finalizes alone (default, no breaking change). acc_majority=committee majority must approve before letter sends. acc_unanimous=all committee members must approve.';

-- ----------------------------------------------------------------------------
-- 2) Completeness check fields on community_applications
--    Separate from the full assessment_* fields — completeness is a
--    fast, synchronous "did they give us everything we need?" check
--    surfaced to the HOMEOWNER. assessment_* fields stay internal.
-- ----------------------------------------------------------------------------
ALTER TABLE community_applications
  ADD COLUMN IF NOT EXISTS completeness_passed       BOOLEAN,
  ADD COLUMN IF NOT EXISTS completeness_checked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completeness_issues       JSONB,
  ADD COLUMN IF NOT EXISTS completeness_message      TEXT;  -- the user-friendly summary shown to homeowner

-- SLA timestamps for the §209 30-day window defense
ALTER TABLE community_applications
  ADD COLUMN IF NOT EXISTS staff_first_viewed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS forwarded_to_committee_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_letter_sent_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_letter_recipient     TEXT;  -- email actually delivered to

-- Decision letter draft (rendered by renderDecisionLetterHTML, edited by
-- staff before send). The final sent version is also archived here.
ALTER TABLE community_applications
  ADD COLUMN IF NOT EXISTS decision_letter_html          TEXT,
  ADD COLUMN IF NOT EXISTS decision_letter_subject       TEXT,
  ADD COLUMN IF NOT EXISTS decision_letter_pdf_path      TEXT;

-- New final_status values to support the staged workflow
ALTER TABLE community_applications
  DROP CONSTRAINT IF EXISTS community_applications_final_status_check;

ALTER TABLE community_applications
  ADD CONSTRAINT community_applications_final_status_check CHECK (final_status IN (
    'draft',                     -- being typed (apply.html save mid-flow)
    'incomplete',                -- AI completeness check failed; homeowner needs to add items
    'pending_review',            -- complete; in staff queue
    'pending_committee_review',  -- staff prepared; awaiting ACC votes
    'pending_send',              -- staff approved letter draft; awaiting send click
    'approved',
    'denied',
    'withdrawn',
    'closed'
  ));

COMMENT ON COLUMN community_applications.decision_letter_html IS
  'Bedrock-rendered decision letter. Staff can edit before send. Once sent, this is the archived sent version. Schema status = workpaper while in draft, association_record once sent.';

-- ----------------------------------------------------------------------------
-- 3) Audit log — every state transition is captured for §209 defense
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_state_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id       UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  from_status          TEXT,
  to_status            TEXT NOT NULL,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('homeowner','system','staff','committee_member')),
  actor_id             TEXT,            -- email for staff, contact_id for committee, NULL for system
  actor_display_name   TEXT,
  reason               TEXT,
  metadata             JSONB,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_state_log_app
  ON application_state_log(application_id, occurred_at DESC);

GRANT SELECT, INSERT ON application_state_log TO service_role;
GRANT SELECT ON application_state_log TO authenticated;

-- ----------------------------------------------------------------------------
-- 4) Phase-2 ACC committee roster (per-community)
--    Created idle; Phase 2 commit wires the reviewer flow on top.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_arc_committee (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  position_title       TEXT,                          -- 'Chair', 'Member', etc.
  is_chair             BOOLEAN NOT NULL DEFAULT FALSE,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  term_starts_at       DATE,
  term_ends_at         DATE,
  added_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by             TEXT,
  removed_at           TIMESTAMPTZ,
  removed_by           TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_arc_committee_active
  ON community_arc_committee(community_id, is_active);

COMMENT ON TABLE community_arc_committee IS
  'Per-community ACC committee roster. association_record (board governance). Phase 1: created idle. Phase 2: drives reviewer portal + quorum logic.';

GRANT SELECT, INSERT, UPDATE, DELETE ON community_arc_committee TO service_role;
GRANT SELECT ON community_arc_committee TO authenticated;

-- ----------------------------------------------------------------------------
-- 5) Phase-2 committee votes (per-application)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_committee_votes (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              UUID NOT NULL REFERENCES community_applications(id) ON DELETE CASCADE,
  committee_member_contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  vote                        TEXT NOT NULL CHECK (vote IN ('approve','deny','request_more_info','abstain')),
  comments                    TEXT,            -- workpaper — visible to staff + other committee members, NEVER homeowner
  voted_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vote_source                 TEXT NOT NULL DEFAULT 'portal' CHECK (vote_source IN ('portal','email','staff_recorded')),
  ip_address                  INET,
  UNIQUE (application_id, committee_member_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_committee_votes_app
  ON application_committee_votes(application_id);
CREATE INDEX IF NOT EXISTS idx_committee_votes_member
  ON application_committee_votes(committee_member_contact_id, voted_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON application_committee_votes TO service_role;
GRANT SELECT ON application_committee_votes TO authenticated;

COMMIT;
