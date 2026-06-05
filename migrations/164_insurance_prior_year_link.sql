-- 164: Add explicit prior-year link to insurance_comparisons so the
-- year-over-year analyst view is deterministic, not just "guess by year".
--
-- WHY: Auto-detecting "the prior year's comparison" by sorting
-- (community_id, policy_type, policy_year DESC) fails the moment a
-- community changes policy structure (split package → separate D&O,
-- mid-year carrier swap, gap year, missing record). An explicit FK is
-- the audit-trail-grade answer.
--
-- The column is NULLABLE and SET NULL on parent delete — the prior-year
-- record might genuinely not exist (first year on platform). UI prompts
-- the operator to link or skip; auto-detect via policy_year - 1 stays
-- as a fallback for unlinked rows.
--
-- Record ownership unchanged (mixed).

BEGIN;

ALTER TABLE insurance_comparisons
  ADD COLUMN IF NOT EXISTS prior_year_comparison_id uuid;

ALTER TABLE insurance_comparisons
  DROP CONSTRAINT IF EXISTS insurance_comparisons_prior_year_fk;

ALTER TABLE insurance_comparisons
  ADD CONSTRAINT insurance_comparisons_prior_year_fk
  FOREIGN KEY (prior_year_comparison_id)
  REFERENCES insurance_comparisons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_insurance_comparisons_prior_year
  ON insurance_comparisons(prior_year_comparison_id);

COMMIT;
