-- ============================================================================
-- Migration 057 — violation quality tags + corrections audit trail
-- ----------------------------------------------------------------------------
-- The escalation engine (lib/enforcement/escalation.js) decides courtesy_1 vs
-- courtesy_2 vs certified §209 based on prior violations in the last 12mo.
-- That logic assumes every prior is real and correctly classified. In reality:
--   - Vantaca's historical data has errors (wrong property, wrong category, etc.)
--   - Operators occasionally mis-attribute photos
--   - Owners sometimes successfully dispute records
--   - Predecessor management companies left messy data behind
--
-- The pattern (borrowed from FCRA / medical records / audit practice):
--   1. NEVER delete a violation row — audit-trail integrity matters in
--      potential §209 litigation.
--   2. Tag each violation with quality_status + confidence_weight.
--   3. Engine sums confidence_weight (not raw count) when deciding escalation.
--   4. Corrections are SEPARATE rows pointing to the original — preserves
--      both the original record AND the correction history.
-- ============================================================================

-- ---- Quality fields on violations ------------------------------------------
ALTER TABLE violations
  ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (quality_status IN (
      'verified',           -- staff confirmed accurate; weight = 1.0
      'unreviewed',         -- new row, no one has looked; default weight by source
      'disputed_by_owner',  -- owner has challenged; under review; weight unchanged until resolved
      'flagged_internal',   -- staff suspects error; weight unchanged until resolved
      'superseded'          -- has been corrected via violation_corrections; weight = 0 for escalation
    )),
  ADD COLUMN IF NOT EXISTS confidence_weight NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (confidence_weight >= 0 AND confidence_weight <= 1),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'trustEd_native'
    CHECK (source IN (
      'trustEd_native',     -- system created it via inspection+AI; default weight 1.0
      'manual_entry',       -- staff typed it in; default weight 0.8
      'vantaca_import',     -- migrated from Vantaca; default weight 0.5
      'predecessor_import', -- from prior mgmt company; default weight 0.3
      'legacy_unknown'      -- unclear origin; default weight 0.4
    )),
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- Index for the engine's weighted-history query
CREATE INDEX IF NOT EXISTS idx_violations_quality_active
  ON violations (property_id, primary_category_id, opened_at)
  WHERE quality_status NOT IN ('superseded');

-- ---- Corrections (append-only audit) ---------------------------------------
CREATE TABLE IF NOT EXISTS violation_corrections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_violation_id    UUID NOT NULL REFERENCES violations(id) ON DELETE RESTRICT,
  correction_type          TEXT NOT NULL CHECK (correction_type IN (
                             'voided',                  -- record was wrong entirely
                             'reclassified',            -- wrong category — replacement row exists
                             'wrong_property',          -- attributed to wrong house
                             'duplicate',               -- already on file
                             'resolved_at_inspection',  -- owner had cured before letter sent
                             'reissued',                -- sent in error; corrected version issued
                             'merged_into',             -- merged with another violation
                             'split_from'               -- split out of another violation
                           )),
  replacement_violation_id UUID REFERENCES violations(id),  -- when reclassified / merged / split
  reason                   TEXT NOT NULL,                    -- required: why are we correcting?
  corrected_by_user_id     UUID,
  corrected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  original_state           JSONB,                            -- snapshot at time of correction
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corrections_original
  ON violation_corrections (original_violation_id, corrected_at);
CREATE INDEX IF NOT EXISTS idx_corrections_replacement
  ON violation_corrections (replacement_violation_id)
  WHERE replacement_violation_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON violation_corrections TO authenticated, service_role;

-- ---- Helper view: weighted prior-violation history per property+category ---
-- Used by the escalation engine + the property detail panel. Excludes
-- superseded rows. Returns sum_weight, count, max_stage_reached, etc.
CREATE OR REPLACE VIEW v_property_category_violation_history AS
SELECT
  v.property_id,
  v.primary_category_id,
  v.community_id,
  COUNT(*) FILTER (WHERE v.opened_at >= NOW() - INTERVAL '12 months')
    AS count_12mo,
  SUM(v.confidence_weight) FILTER (WHERE v.opened_at >= NOW() - INTERVAL '12 months')
    AS weighted_count_12mo,
  COUNT(*) AS count_lifetime,
  SUM(v.confidence_weight) AS weighted_count_lifetime,
  COUNT(*) FILTER (WHERE v.current_stage = 'certified_209' AND v.opened_at >= NOW() - INTERVAL '12 months')
    AS certified_count_12mo,
  COUNT(*) FILTER (WHERE v.quality_status = 'verified')
    AS verified_count,
  COUNT(*) FILTER (WHERE v.source = 'vantaca_import')
    AS vantaca_import_count,
  MAX(v.opened_at) AS most_recent_opened_at
FROM violations v
WHERE v.quality_status NOT IN ('superseded')
GROUP BY v.property_id, v.primary_category_id, v.community_id;

GRANT SELECT ON v_property_category_violation_history TO authenticated, service_role;
