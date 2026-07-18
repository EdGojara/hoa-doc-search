BEGIN;

-- ============================================================================
-- 306_photo_analysis_corrections.sql  (Ed 2026-07-17)
-- ----------------------------------------------------------------------------
-- The training ledger for photo analysis. Every time a human corrects the AI's
-- read of an inspection photo (today: the drafts "reclassify" — change the
-- violation's category/description during review), we record a permanent,
-- STRUCTURED (AI said X → human said Y) row here, with the photo, BEFORE the
-- correction overwrites the observation. This is the clean signal that powers:
--   1. the accuracy report (override rate + confusion pairs)
--   2. few-shot retrieval (feed past corrected photos+labels back at inference)
--
-- Complements migration 305 (ai_suggested_category_id = the AI's guess captured
-- at analysis time, for cold accuracy on NEW photos). This table captures
-- corrections made during REVIEW — which is what today's Still Creek letter run
-- generates.
--
-- Record ownership: workpaper (AI training data; Bedrock IP — never handed over
-- on termination). Single-class table; no per-row record_ownership column.
-- ============================================================================

CREATE TABLE IF NOT EXISTS photo_analysis_corrections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id            UUID REFERENCES communities(id) ON DELETE CASCADE,
  property_id             UUID REFERENCES properties(id) ON DELETE SET NULL,
  observation_id          UUID REFERENCES property_observations(id) ON DELETE SET NULL,
  violation_id            UUID REFERENCES violations(id) ON DELETE SET NULL,
  inspection_photo_id     UUID,                 -- the photo the AI read (for few-shot)
  photo_storage_path      TEXT,                 -- denormalized so training reads need no join
  ai_category_id          UUID REFERENCES enforcement_categories(id) ON DELETE SET NULL,   -- what the AI/prior read said
  corrected_category_id   UUID REFERENCES enforcement_categories(id) ON DELETE SET NULL,   -- what the human set
  category_changed        BOOLEAN NOT NULL DEFAULT FALSE,
  ai_description          TEXT,                 -- the AI/prior description
  corrected_description   TEXT,                 -- the human description
  description_changed     BOOLEAN NOT NULL DEFAULT FALSE,
  source                  TEXT NOT NULL DEFAULT 'reclassify'
                            CHECK (source IN ('reclassify','review','manual','other')),
  corrected_by_user_id    UUID,
  corrected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_photo_corr_community_cat
  ON photo_analysis_corrections (community_id, corrected_category_id);
CREATE INDEX IF NOT EXISTS idx_photo_corr_confusion
  ON photo_analysis_corrections (ai_category_id, corrected_category_id)
  WHERE category_changed;

GRANT SELECT, INSERT, UPDATE, DELETE ON photo_analysis_corrections TO service_role;
GRANT SELECT                          ON photo_analysis_corrections TO authenticated;

COMMIT;
