-- ============================================================================
-- 211_inspection_pause_segments.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-09 (after first field test) — operators need to pause a drive
-- for weather, lunch, half-day shifts, etc. without ending it. Plus Ed wants
-- accurate time-on-drive metrics that don't count paused intervals.
--
-- Pattern: a child table of pause segments per inspection. Each segment has
-- a paused_at + (optional) resumed_at. Open segment = inspection is
-- currently paused. Sum of (resumed_at - paused_at) = total paused time.
-- Active drive time = (ended_at OR NOW) - started_at - sum(pause durations).
--
-- Also adds 'paused' to the inspections.status CHECK so a quick status read
-- says "yes this is paused" without joining the pause table.
-- ============================================================================

BEGIN;

ALTER TABLE inspections
  DROP CONSTRAINT IF EXISTS inspections_status_check;

ALTER TABLE inspections
  ADD CONSTRAINT inspections_status_check CHECK (status IN (
    'in_progress',
    'paused',         -- NEW
    'captured',
    'ai_analyzed',
    'reviewed',
    'closed',
    'voided'
  ));

CREATE TABLE IF NOT EXISTS inspection_pause_segments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id   UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  paused_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumed_at      TIMESTAMPTZ,
  reason          TEXT,                       -- 'weather', 'lunch', 'end_of_half_day', etc.
  paused_by       TEXT,                       -- operator email (best-effort)
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pause_seg_inspection
  ON inspection_pause_segments(inspection_id, paused_at DESC);

-- Partial unique index — at most ONE open (unresumed) pause segment per
-- inspection at a time. Prevents double-pausing.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pause_seg_open
  ON inspection_pause_segments(inspection_id)
  WHERE resumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_pause_segments TO service_role;
GRANT SELECT ON inspection_pause_segments TO authenticated;

COMMENT ON TABLE inspection_pause_segments IS
  'Child table of pauses per inspection. Used to compute true time-on-drive metrics (subtract paused time from total elapsed).';

COMMIT;
