-- ============================================================================
-- Migration 058 — per-community per-category fine schedule + master toggle
-- ----------------------------------------------------------------------------
-- Two real-world patterns this needs to handle:
--   1. Communities WITH a fine schedule in their CC&Rs but whose board has
--      historically chosen NOT to fine. Most Texas HOAs Bedrock manages.
--      → master toggle communities.fines_enabled = FALSE by default.
--   2. Communities that fine for some categories but not others (e.g. fine
--      for boats in driveway, courtesy-only for trash bins).
--      → per-category override row with fines_enabled flag.
--
-- Engine behavior:
--   - When certified_209 cure period expires:
--       fines_enabled AND active schedule for category → auto-create
--         fine_assessed violation + fine_posting_queue entry at schedule amount
--       fines_enabled but NO schedule for category → STAY at certified_209
--         (no auto-fine; staff can manually assess if board approves)
--       fines_enabled = FALSE → STAY at certified_209 (board has paused fines)
--   - Manual fine assessment always available (with board_resolution_ref).
-- ============================================================================

-- Master toggle on communities. Defaults to FALSE so no community gets
-- auto-fines until a board explicitly turns it on (and records the date /
-- minutes reference).
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS fines_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fines_enabled_set_by_board_date DATE,
  ADD COLUMN IF NOT EXISTS fines_enabled_board_minutes_ref TEXT,
  ADD COLUMN IF NOT EXISTS fines_disabled_reason TEXT;

-- Per-(community, category) schedule + per-category enable flag
CREATE TABLE IF NOT EXISTS community_category_fine_schedule (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id),
  -- NULL category_id = the COMMUNITY-WIDE DEFAULT row. Applies to any
  -- category that doesn't have its own row. Engine resolves
  -- per-category → per-community default → no auto-fine.
  category_id              UUID NULL REFERENCES enforcement_categories(id),
  fines_enabled            BOOLEAN NOT NULL DEFAULT TRUE,  -- per-category off-switch
  -- The schedule. NULL amount = no fine at that offense step.
  first_offense_amount     NUMERIC(10, 2),   -- $25
  second_offense_amount    NUMERIC(10, 2),   -- $50
  third_offense_amount     NUMERIC(10, 2),   -- $100
  recurring_offense_amount NUMERIC(10, 2),   -- amount for 4th+ offense (caps)
  -- Provenance
  set_by_board_vote_date   DATE,
  board_meeting_minutes_ref TEXT,
  set_by_user_id           UUID,
  notes                    TEXT,
  -- Time-bounded so schedule changes preserve history (board re-votes →
  -- end-date the old row, insert a new one)
  effective_start_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_end_date       DATE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly one ACTIVE row per (community, category). The COALESCE trick
-- folds NULL category_id (community-default) into the same uniqueness
-- check. A constant UUID is fine here since real category UUIDs never
-- collide with the all-zeros sentinel.
CREATE UNIQUE INDEX IF NOT EXISTS ux_fine_schedule_one_active
  ON community_category_fine_schedule (
    community_id,
    COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE effective_end_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_fine_schedule_lookup
  ON community_category_fine_schedule (community_id, category_id, effective_end_date NULLS FIRST);

GRANT SELECT, INSERT, UPDATE, DELETE ON community_category_fine_schedule
  TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Convenience view: resolved per-(community × category) schedule
-- Returns the effective schedule for every (community × category) pair —
-- per-category row if present, else the community default, else nothing.
-- Used by the engine + Fine Schedule UI to show what would actually fire.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_resolved_fine_schedule AS
SELECT
  c.id   AS community_id,
  c.name AS community_name,
  c.fines_enabled AS community_fines_enabled,
  ec.id  AS category_id,
  ec.slug AS category_slug,
  ec.label AS category_label,
  COALESCE(cat_sched.fines_enabled, default_sched.fines_enabled, false)
    AS effective_fines_enabled,
  COALESCE(cat_sched.first_offense_amount,    default_sched.first_offense_amount)
    AS first_offense_amount,
  COALESCE(cat_sched.second_offense_amount,   default_sched.second_offense_amount)
    AS second_offense_amount,
  COALESCE(cat_sched.third_offense_amount,    default_sched.third_offense_amount)
    AS third_offense_amount,
  COALESCE(cat_sched.recurring_offense_amount, default_sched.recurring_offense_amount)
    AS recurring_offense_amount,
  CASE
    WHEN cat_sched.id IS NOT NULL THEN 'category_specific'
    WHEN default_sched.id IS NOT NULL THEN 'community_default'
    ELSE 'no_schedule'
  END AS source_row
FROM communities c
CROSS JOIN enforcement_categories ec
LEFT JOIN community_category_fine_schedule cat_sched
  ON cat_sched.community_id = c.id
  AND cat_sched.category_id = ec.id
  AND cat_sched.effective_end_date IS NULL
LEFT JOIN community_category_fine_schedule default_sched
  ON default_sched.community_id = c.id
  AND default_sched.category_id IS NULL
  AND default_sched.effective_end_date IS NULL
WHERE c.active = TRUE;

GRANT SELECT ON v_resolved_fine_schedule TO authenticated, service_role;
