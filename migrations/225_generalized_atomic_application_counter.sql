-- ============================================================================
-- 225_generalized_atomic_application_counter.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-13: post-DRB-collision audit found the SAME read-then-write
-- race condition that bit builder_applications also exists in:
--
--   1. api/amenities.js                 — POST /amenities/:id/rentals (PUBLIC)
--   2. api/applications.js              — POST /applications/public/:slug/submit (PUBLIC)
--   3. api/applications.js              — POST fob request (PUBLIC)
--   4. api/master_plan_submissions.js   — POST /master-plan-submissions/public (PUBLIC)
--
-- All four do select counter → JS +1 → upsert → INSERT into a UNIQUE
-- reference_number column. All four can crash a real client with a raw
-- "duplicate key value violates unique constraint" the moment two
-- concurrent submissions arrive.
--
-- Migration 224 fixed JUST builder_applications with a per-table function.
-- This migration GENERALIZES the fix so every callsite can converge on a
-- single atomic primitive. The new function accepts an `infix` parameter
-- so it handles every reference shape:
--   -BLD-   builder ARC applications
--   -ARC-   resident ARC applications
--   -CLB-   amenity rentals (clubhouse / pool / etc.)
--   -MPS-   master plan submissions
--   -FOB-   gate/access fob requests
--
-- Drift protection works the same way: read MAX existing reference suffix
-- for this (community, year, infix) and use GREATEST(counter, max_existing)
-- as the floor. The infix is what scopes the LIKE filter so the drift
-- check is per-service-type, never bleeds between them.
--
-- Migration 224's function (next_builder_application_counter) is left in
-- place for backward compat but is now dead code. Drop in a later migration
-- once the deploy has settled and no callers reference it.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION next_application_counter(
  p_community_id UUID,
  p_service_type TEXT,
  p_year         INT,
  p_prefix       TEXT,
  p_infix        TEXT    -- e.g. '-BLD-', '-ARC-', '-CLB-', '-MPS-', '-FOB-'
) RETURNS INT AS $$
DECLARE
  v_max_existing INT;
  v_new_counter  INT;
  v_pattern      TEXT;
BEGIN
  -- Build the LIKE pattern: '<PREFIX><INFIX><YEAR>-%'
  -- e.g. 'AMD-BLD-2026-%' for builder, 'WVE-CLB-2026-%' for amenity, etc.
  v_pattern := p_prefix || p_infix || p_year::text || '-%';

  -- Drift protection: find the highest numeric suffix already in use for
  -- this (community, prefix, infix, year). The function searches all four
  -- tables that use application_reference_counters as their generator —
  -- belt-and-suspenders against the rare case where the counter table
  -- has been corrupted but the destination table still has live rows.
  --
  -- We UNION ALL across the tables that have a reference_number column.
  -- Postgres only evaluates branches whose table exists; LIKE excludes
  -- mismatched infixes so the unrelated tables contribute 0 to MAX.
  SELECT COALESCE(MAX(suffix), 0) INTO v_max_existing FROM (
    SELECT NULLIF((regexp_match(reference_number, '(\d+)$'))[1], '')::int AS suffix
      FROM builder_applications
      WHERE community_id = p_community_id AND reference_number LIKE v_pattern
    UNION ALL
    SELECT NULLIF((regexp_match(reference_number, '(\d+)$'))[1], '')::int AS suffix
      FROM community_applications
      WHERE community_id = p_community_id AND reference_number LIKE v_pattern
    UNION ALL
    SELECT NULLIF((regexp_match(reference_number, '(\d+)$'))[1], '')::int AS suffix
      FROM amenity_rentals
      WHERE community_id = p_community_id AND reference_number LIKE v_pattern
    UNION ALL
    SELECT NULLIF((regexp_match(reference_number, '(\d+)$'))[1], '')::int AS suffix
      FROM master_plan_submissions
      WHERE community_id = p_community_id AND reference_number LIKE v_pattern
  ) AS all_refs;

  -- Atomic increment via UPSERT. Postgres holds a row lock during UPDATE
  -- so two concurrent calls serialize cleanly. GREATEST(...) ensures we
  -- never go BELOW the drift floor.
  INSERT INTO application_reference_counters (community_id, service_type, year, counter, updated_at)
  VALUES (p_community_id, p_service_type, p_year, v_max_existing + 1, NOW())
  ON CONFLICT (community_id, service_type, year) DO UPDATE
  SET counter    = GREATEST(application_reference_counters.counter, v_max_existing) + 1,
      updated_at = NOW()
  RETURNING counter INTO v_new_counter;

  RETURN v_new_counter;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION next_application_counter(UUID, TEXT, INT, TEXT, TEXT)
  TO service_role, authenticated;

COMMIT;
