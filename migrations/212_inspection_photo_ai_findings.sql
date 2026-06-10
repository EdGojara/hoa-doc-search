-- ============================================================================
-- 212_inspection_photo_ai_findings.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-10 — Field test surfaced that photos without polygon_match_
-- property_id can't get observation rows (schema constraint requires
-- property_id OR common_area_id). 97 photos from one drive failed re-analysis
-- for this reason.
--
-- Fix: store the AI's findings directly on inspection_photos so the audit
-- view can show what AI thinks even when the photo isn't yet linked to a
-- property. Observations remain the authoritative source for "this is a
-- violation we're acting on" — these new columns are the "what AI saw"
-- record that doesn't need a property attached yet.
--
-- When the operator later links the photo to a property (existing
-- /photos-needing-link flow), an observation row can be created from these
-- findings.
-- ============================================================================

BEGIN;

ALTER TABLE inspection_photos
  ADD COLUMN IF NOT EXISTS ai_findings      JSONB,
  ADD COLUMN IF NOT EXISTS ai_is_clean      BOOLEAN,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_findings_count INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN ai_findings IS NULL THEN NULL
      WHEN jsonb_typeof(ai_findings) = 'array' THEN jsonb_array_length(ai_findings)
      ELSE 0
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_inspection_photos_ai_analyzed
  ON inspection_photos(inspection_id, ai_analyzed_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_inspection_photos_ai_clean
  ON inspection_photos(inspection_id, ai_is_clean)
  WHERE ai_is_clean IS NOT NULL;

COMMENT ON COLUMN inspection_photos.ai_findings IS
  'JSONB array of findings from categorizePhoto (lib/enforcement/ai_vision.js). Each: {category_slug, severity, description, recommended_action, confidence, notes}. Populated by /api/inspections/:id/analyze. Stored on the photo so unmatched-to-property photos still record what AI saw.';

COMMIT;
