-- ============================================================================
-- 224_atomic_builder_reference_counter.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-13: DRB Group (August Meadows builder) hit
--   "duplicate key value violates unique constraint
--    'builder_applications_reference_number_key'"
-- when submitting an ARC application.
--
-- Root cause: nextBuilderReferenceNumber() in api/builder_applications.js
-- did a non-atomic read-then-write on application_reference_counters:
--
--   1. SELECT counter FROM application_reference_counters WHERE ... (= 5)
--   2. JS computes next = 5 + 1 = 6
--   3. UPSERT counter = 6
--   4. Build reference "AMD-BLD-2026-0006"
--   5. INSERT INTO builder_applications (reference_number = 'AMD-BLD-2026-0006')
--
-- Under two simultaneous submissions, both read counter=5, both compute
-- next=6, both attempt to insert reference_number='AMD-BLD-2026-0006'. The
-- second one hits the UNIQUE constraint and crashes with a raw SQL error
-- in the builder's face.
--
-- The original code comment ACKNOWLEDGED this race but promised "the caller
-- can retry on conflict" — which was never implemented.
--
-- Second failure mode: if the counter ever drifts behind actual reference
-- numbers (test data, manual inserts, deleted rows leaving counter ahead),
-- every new submission collides forever until the counter is manually
-- bumped. The fix below reads MAX(actual reference numbers) and never
-- returns lower than what's already in the table.
--
-- Fix:
--   1. Atomic Postgres function — single statement does INSERT ... ON
--      CONFLICT DO UPDATE RETURNING. Postgres holds a row lock during the
--      update so two concurrent calls serialize cleanly.
--   2. Drift protection — function reads MAX(existing reference suffix) for
--      this (community, year, prefix) and uses GREATEST(counter, max_existing)
--      as the floor. Never returns a number that already exists.
--   3. JS callsite switches to .rpc() instead of read-then-upsert.
--
-- The function is community-aware (filters builder_applications by
-- community_id + prefix + year) so two different communities incrementing
-- in parallel don't interfere with each other's drift check.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION next_builder_application_counter(
  p_community_id UUID,
  p_service_type TEXT,
  p_year         INT,
  p_prefix       TEXT
) RETURNS INT AS $$
DECLARE
  v_max_existing INT;
  v_new_counter  INT;
BEGIN
  -- Drift protection: read the highest numeric suffix from
  -- builder_applications.reference_number for this community/prefix/year.
  -- Format is '<PREFIX>-BLD-<YYYY>-<NNNN>' — extract the trailing digits.
  SELECT COALESCE(MAX(
    NULLIF((regexp_match(reference_number, '(\d+)$'))[1], '')::int
  ), 0)
  INTO v_max_existing
  FROM builder_applications
  WHERE community_id = p_community_id
    AND reference_number LIKE p_prefix || '-BLD-' || p_year::text || '-%';

  -- Atomic increment. UPSERT acquires a row-level lock during the UPDATE
  -- branch so two concurrent calls cannot both read the same value.
  -- GREATEST(...) ensures we never go BELOW the drift floor.
  INSERT INTO application_reference_counters (community_id, service_type, year, counter, updated_at)
  VALUES (p_community_id, p_service_type, p_year, v_max_existing + 1, NOW())
  ON CONFLICT (community_id, service_type, year) DO UPDATE
  SET counter    = GREATEST(application_reference_counters.counter, v_max_existing) + 1,
      updated_at = NOW()
  RETURNING counter INTO v_new_counter;

  RETURN v_new_counter;
END;
$$ LANGUAGE plpgsql;

-- Service role calls this from api/builder_applications.js. Authenticated
-- role might call it later from the staff manual-entry flow. anon never.
GRANT EXECUTE ON FUNCTION next_builder_application_counter(UUID, TEXT, INT, TEXT)
  TO service_role, authenticated;

COMMIT;
