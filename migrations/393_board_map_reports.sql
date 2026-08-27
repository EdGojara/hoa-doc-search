-- ============================================================================
-- 393 — board_map_reports: field reports submitted from the Community Map.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-27. The board community map lets a board member (or, later, a
-- resident) who is walking/driving the neighborhood tap a house, see whether an
-- issue is already being handled, and — if not — report it with a photo instead
-- of emailing the manager. "Instant feedback." Those reports land here.
--
-- Why its own table (not property_observations): an observation in the DRV
-- pipeline requires an inspection_id (a real drive/route). A map field report
-- has no drive behind it — it is a citizen/board tip. This table is the intake;
-- staff triage a report and, when warranted, open a real observation/violation
-- from it. Keeping it separate avoids faking an inspection row and keeps the
-- DRV pipeline's provenance honest.
--
-- Record ownership: association_record (a report about a property in the
-- association, submitted by a board member/resident on the association's behalf).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS board_map_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id       UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id        UUID NULL REFERENCES properties(id) ON DELETE SET NULL,

  -- Who reported it (a board magic-link viewer or staff). No FK — a board
  -- member is a portal_users identity, staff is a user_profiles identity; we
  -- store the display name + email + role captured at submit time.
  reported_by_name   TEXT NULL,
  reported_by_email  TEXT NULL,
  reporter_role      TEXT NOT NULL DEFAULT 'board_member'
                     CHECK (reporter_role IN ('board_member','staff','resident')),

  description        TEXT NULL,
  photo_path         TEXT NULL,          -- Supabase storage path in the 'documents' bucket
  photo_bucket       TEXT NULL DEFAULT 'documents',

  status             TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','reviewing','actioned','dismissed')),
  triaged_by_user_id UUID NULL REFERENCES user_profiles(id) ON DELETE SET NULL,
  triaged_at         TIMESTAMPTZ NULL,
  triage_notes       TEXT NULL,
  -- If a report becomes a real case, link it (provenance, no silo).
  linked_violation_id UUID NULL REFERENCES violations(id) ON DELETE SET NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_map_reports_community_status
  ON board_map_reports (community_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_map_reports_property
  ON board_map_reports (property_id, created_at DESC);

-- API writes with the service role; staff triage surfaces read with either.
GRANT SELECT, INSERT, UPDATE, DELETE ON board_map_reports TO service_role;
GRANT SELECT                          ON board_map_reports TO authenticated;

COMMENT ON TABLE board_map_reports IS
  'association_record. Field reports submitted from the Community Map (board member/resident taps a house, reports an issue + photo). Staff triage; a report can promote to a real observation/violation via linked_violation_id.';

COMMIT;
