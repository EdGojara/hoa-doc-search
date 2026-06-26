-- ============================================================================
-- 247_violation_cure_days_override.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-26 — Per-violation operator override for the cure-window length.
-- When set, violation letters use this many days instead of the per-community
-- stage default (letter_cure_days_*). Used to grant EXTRA grace (e.g. 30 days
-- instead of 20) when sending late or as a courtesy. The cure period still runs
-- from the postmark date (§209.006) — this only changes the NUMBER of days, so
-- a longer window stays defensible (more cure time never harms the owner).
--
-- Read by every render path (drafts bundle render, single generate-letter, and
-- the mail-queue lock-and-batch re-render at postmark) so the override survives
-- mailing.
-- ============================================================================

BEGIN;

ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS cure_days_override INTEGER
    CHECK (cure_days_override IS NULL OR (cure_days_override >= 1 AND cure_days_override <= 180));

COMMENT ON COLUMN violations.cure_days_override IS
  'Operator override for the cure-window length in days. NULL = use the per-community stage default. Cure still runs from the postmark date; this only lengthens/shortens the window count.';

COMMIT;
