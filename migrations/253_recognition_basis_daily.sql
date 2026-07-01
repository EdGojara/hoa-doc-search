-- ============================================================================
-- 253_recognition_basis_daily.sql
-- ----------------------------------------------------------------------------
-- Straight-line DAILY revenue recognition (Ed 2026-06-30). The recognition
-- engine (migration 235) recognizes deferred revenue in EQUAL monthly slices —
-- which can't honor a partial first/last month. For prorated assessments (a
-- builder take-down mid-May, a homeowner closing mid-month) the earned amount
-- should track ACTUAL elapsed days and still tie to the full amount by the
-- period end.
--
-- Adds recognition_basis to recognition_schedules:
--   'monthly' (DEFAULT — existing behavior, untouched)
--   'daily'   — each month recognizes its share of days within
--               [period_start, period_end]; cumulative always ties to
--               recognize_amount_cents (the engine computes each month as the
--               difference of cumulative-day roundings, so there's no drift).
--
-- Purely additive + opt-in. Every existing schedule stays 'monthly' and behaves
-- exactly as before; only schedules explicitly set to 'daily' use the new path.
-- ============================================================================

BEGIN;

ALTER TABLE recognition_schedules
  ADD COLUMN IF NOT EXISTS recognition_basis TEXT NOT NULL DEFAULT 'monthly'
    CHECK (recognition_basis IN ('monthly', 'daily'));

COMMIT;
