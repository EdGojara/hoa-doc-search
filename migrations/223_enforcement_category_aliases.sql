-- ============================================================================
-- 223_enforcement_category_aliases.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-13: "I need the system's judgment to help with the linkage."
--
-- The scar that drove this: Ronald Duncan at 6234 Clear Canyon Drive has been
-- "Sent to Attorney" in Vantaca for Sod yard + Mildew + Flowerbeds + Trim
-- trees (10/14/2025). trustEd's June 2026 inspection drafted COURTESY_1 for
-- Lawn dead patches at the same property. Why? Because Vantaca's "Sod yard"
-- has a different primary_category_id than trustEd's "lawn_dead_patches" —
-- semantically the same violation, different rows in enforcement_categories.
-- The escalation engine's per-category prior-lookup misses the equivalence
-- and recommends courtesy_1 instead of escalating.
--
-- Fix: a directed alias relationship — "alias_category_id maps to
-- canonical_category_id." When the engine queries priors at category X, it
-- ALSO includes every category whose canonical IS X. Multiple aliases can
-- map to the same canonical (Sod yard, Sod Yard, Grass dead → all alias to
-- lawn_dead_patches).
--
-- Lifecycle:
--   1. AI linker endpoint suggests mappings ('ai_suggested') — operator
--      reviews and either confirms or rejects.
--   2. Confirmed mappings ('confirmed') take effect in prior-lookup.
--   3. ai_suggested rows are visible but don't affect engine math until
--      confirmed, so the operator stays in the loop on enforcement decisions.
--
-- Apply AFTER 222.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS enforcement_category_aliases (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_category_id       UUID NOT NULL REFERENCES enforcement_categories(id) ON DELETE CASCADE,
  canonical_category_id   UUID NOT NULL REFERENCES enforcement_categories(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'ai_suggested'
                            CHECK (status IN ('ai_suggested','confirmed','rejected')),
  reasoning               TEXT NULL,
  ai_confidence           NUMERIC(4, 3) NULL CHECK (ai_confidence BETWEEN 0 AND 1),
  ai_model                TEXT NULL,
  reviewed_by_user_id     UUID NULL,
  reviewed_at             TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT no_self_alias CHECK (alias_category_id <> canonical_category_id),
  -- One alias_category can only have one current ai_suggested OR confirmed
  -- mapping; rejected ones can stack but only one positive per alias.
  CONSTRAINT uq_active_alias UNIQUE (alias_category_id, status)
);

CREATE INDEX IF NOT EXISTS idx_category_aliases_canonical
  ON enforcement_category_aliases (canonical_category_id, status)
  WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_category_aliases_pending
  ON enforcement_category_aliases (status, created_at DESC)
  WHERE status = 'ai_suggested';

GRANT SELECT, INSERT, UPDATE, DELETE ON enforcement_category_aliases TO service_role;
GRANT SELECT                          ON enforcement_category_aliases TO authenticated;

COMMIT;
