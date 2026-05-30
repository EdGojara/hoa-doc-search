-- ============================================================================
-- 133_bundle_certified_separately.sql
-- ----------------------------------------------------------------------------
-- Per-community toggle: when TRUE, the auto-bundle pass skips letter_209
-- type drafts (covers both certified_209 and fine_assessed). Each §209
-- violation generates a separate letter + separate envelope.
--
-- WHY THIS MATTERS:
--   Texas §209 procedural requirements:
--     • Each violation needs its own §209.0064 cure-rights statement
--     • Each violation needs its own §209.007 hearing-rights statement
--     • Each violation needs its own §209.006 notice of intent
--
--   A bundled letter CAN technically include all required citations per
--   violation, but a defending attorney can argue the bundle "obscures"
--   per-violation cure rights — which gives the homeowner a procedural
--   defense at the §209 hearing.
--
--   Professional management posture: combine at courtesy stages (homeowner-
--   friendly, less paper), separate at §209 certified (legal defensibility).
--   This toggle lets each community pick its posture without forcing one
--   default across the portfolio.
--
-- DEFAULT IS FALSE to preserve existing behavior for every community that
-- already exists. Operators opt-in per community via Community Profile →
-- Letter & enforcement settings.
--
-- RECORD OWNERSHIP: 'mixed' — the row controls how Bedrock generates the
-- delivered notice (workpaper-side decision) BUT the resulting notice format
-- is what the homeowner receives (association_record).
--
-- Apply after 132. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS bundle_certified_letters_separately BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN communities.bundle_certified_letters_separately IS
  'When TRUE, auto-bundle skips letter_209 type drafts (certified_209 + fine_assessed). Each §209 violation gets its own letter + envelope for procedural defensibility. Courtesy stages still combine. DEFAULT FALSE preserves existing combined behavior; flip ON for communities where the board / counsel wants per-violation §209 letters.';

COMMIT;
