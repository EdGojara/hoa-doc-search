-- ===========================================================================
-- 322_violation_field_checks.sql
-- ---------------------------------------------------------------------------
-- Field re-verification of certified / pending-hearing §209 violations. The
-- certified list carried over from Vantaca was never re-inspected, so nobody
-- knew which were still real. This records a drive-by check per violation:
-- "still not cured as of <date>" (with an updated photo as evidence) or
-- "cured" (which closes the case). The not-cured checks feed a BOARD-ONLY
-- "not cured as of" letter — never sent to the homeowner. (Ed 2026-07-20.)
--
-- Record ownership: association_record — it's evidence of the association's
-- enforcement, part of the §209 file.
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS violation_field_checks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  violation_id         uuid NOT NULL REFERENCES violations(id) ON DELETE CASCADE,
  community_id         uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id          uuid REFERENCES properties(id) ON DELETE SET NULL,
  result               text NOT NULL CHECK (result IN ('not_cured', 'cured')),
  checked_at           date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Chicago')::date,
  photo_storage_path   text,               -- updated drive-by photo (evidence)
  notes                text,
  checked_by           text,
  record_ownership     text NOT NULL DEFAULT 'association_record',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vfc_violation ON violation_field_checks(violation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vfc_community ON violation_field_checks(community_id, result, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON violation_field_checks TO service_role;
GRANT SELECT                          ON violation_field_checks TO authenticated;

COMMIT;
