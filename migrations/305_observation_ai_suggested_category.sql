BEGIN;

-- ============================================================================
-- 305_observation_ai_suggested_category.sql  (Ed 2026-07-17)
-- ----------------------------------------------------------------------------
-- Training-signal capture for the photo-analysis learning loop ("the scorecard").
--
-- property_observations.category_id holds the AI's vision guess, but a human
-- reviewer OVERWRITES it in place when they re-label — so the AI's ORIGINAL
-- category (the exact thing we need to learn from) was being erased. This adds a
-- write-once field that preserves what the AI first suggested, so every human
-- correction becomes a permanent (AI guessed X, human confirmed Y) training pair.
-- The vision path writes it best-effort; the accuracy report + future few-shot
-- retrieval read it. ai_description already preserves the AI's original text.
--
-- Record ownership: workpaper (AI extraction metadata; Bedrock IP). Additive,
-- no backfill — pre-existing observations stay NULL (no signal for old rows).
-- ============================================================================

ALTER TABLE property_observations
  ADD COLUMN IF NOT EXISTS ai_suggested_category_id UUID
    REFERENCES enforcement_categories(id) ON DELETE SET NULL;

-- The accuracy report groups by (community, AI-suggested category) to compute
-- override rate + confusion pairs; index the hot path.
CREATE INDEX IF NOT EXISTS idx_prop_obs_ai_suggested
  ON property_observations (community_id, ai_suggested_category_id)
  WHERE ai_suggested_category_id IS NOT NULL;

COMMIT;
