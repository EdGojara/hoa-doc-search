-- ============================================================================
-- 379 — application_reference_counters.service_type: allow every value a caller
--       can actually pass.
-- ----------------------------------------------------------------------------
-- Record ownership: workpaper. This table is an internal counter used to mint
-- reference numbers; the resulting references live on association records, the
-- counter itself does not.
--
-- Found 2026-08-21 while walking the clubhouse reservation flow for Ed. Step one
-- failed outright:
--
--   reference number allocation failed: new row for relation
--   "application_reference_counters" violates check constraint
--   "application_reference_counters_service_type_check"
--
-- Migration 218 REPLACED this constraint (DROP then ADD) with the list its own
-- feature needed:
--
--   CHECK (service_type IN ('builder_arc','master_plan_submission',
--                           'resident_acc','estoppel','other'))
--
-- It is a SHARED counter, and the callers were not audited. Three application
-- types have been unable to mint a reference number ever since:
--
--   api/amenities.js            'amenity_rental'   -> every clubhouse booking
--   api/applications.js:1138    community_services.service_type
--                               -> live data holds 7 'arc' and 3 'pool_amenity'
--
-- So clubhouse reservations, ARC applications routed through community_services,
-- and pool amenity applications all died at the first step. Nothing partially
-- worked and no bad data was written, which is the one mercy here: the insert
-- was rejected outright rather than silently mis-recorded.
--
-- Why the static checker missed it: scripts/check_constraint_values.js
-- cross-references `.from('t').insert({col:'literal'})` against migration CHECK
-- lists. These callers reach the table through the next_application_counter()
-- RPC, so there is no literal insert in the JS for it to see. A constraint
-- reachable only through a function is invisible to it.
--
-- The union below is every value a caller can legitimately pass today:
--   * 218's five
--   * amenity_rental                                       (api/amenities.js)
--   * the community_services.service_type set from 021     (api/applications.js)
--
-- If you add a service type anywhere, add it here in the same migration. Better
-- still: widen, never replace, a constraint on a shared table.
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'application_reference_counters'
      AND constraint_name LIKE 'application_reference_counters_service_type%'
  ) THEN
    ALTER TABLE application_reference_counters
      DROP CONSTRAINT IF EXISTS application_reference_counters_service_type_check;
  END IF;

  ALTER TABLE application_reference_counters
    ADD CONSTRAINT application_reference_counters_service_type_check
    CHECK (service_type IN (
      -- from 218
      'builder_arc',
      'master_plan_submission',
      'resident_acc',
      'estoppel',
      'other',
      -- api/amenities.js — clubhouse and other rentable amenities
      'amenity_rental',
      -- community_services.service_type (migration 021), via api/applications.js
      'arc',
      'pool_amenity',
      'gate_vehicle',
      'gym_access',
      'pet',
      'general'
    ));
END $$;

COMMIT;
