-- ============================================================================
-- 246_inspection_track_points.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-25 — Live drive-coverage tracking. While an inspector is on a
-- drive-by inspection, their device streams GPS breadcrumbs here. A shared
-- coverage map draws each inspector's full path (color-coded) so two people
-- driving the same community don't double-cover the same streets.
--
-- High-volume, append-only: one row per GPS sample (~every 10s / 30m). BIGINT
-- identity PK (not UUID) — these are cheap, sequential, and there can be
-- thousands per drive. ON DELETE CASCADE so points vanish with their inspection.
--
-- Record ownership: WORKPAPER — staff GPS breadcrumbs are internal to Bedrock's
-- production process (how we conduct an inspection), never delivered to a board
-- or homeowner. Not part of the association_record export.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS inspection_track_points (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inspection_id  UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  community_id   UUID NOT NULL REFERENCES communities(id),
  lat            DOUBLE PRECISION NOT NULL,
  lng            DOUBLE PRECISION NOT NULL,
  accuracy_m     REAL,                       -- GPS accuracy radius in meters, if reported
  recorded_at    TIMESTAMPTZ NOT NULL,       -- when the device captured the fix
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Path reconstruction for one inspection (ordered by time).
CREATE INDEX IF NOT EXISTS idx_track_points_inspection
  ON inspection_track_points (inspection_id, recorded_at);
-- "All active drives in this community since T" for the coverage map.
CREATE INDEX IF NOT EXISTS idx_track_points_community_time
  ON inspection_track_points (community_id, recorded_at DESC);

-- Grants — the Node API writes with the service role; never assume defaults
-- propagate (see CLAUDE.md "new tables without service_role GRANTs" scar).
GRANT SELECT, INSERT ON inspection_track_points TO service_role;
GRANT SELECT            ON inspection_track_points TO authenticated;

COMMIT;
