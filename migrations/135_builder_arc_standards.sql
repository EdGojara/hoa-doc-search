-- ============================================================================
-- 135_builder_arc_standards.sql
-- ----------------------------------------------------------------------------
-- Adds structured per-community builder ARC standards. Closes the gap where
-- objective specifications (min sqft, roof pitches, masonry %, allowed
-- materials) ONLY lived inside the Design Guidelines PDF — forcing the AI
-- review pipeline to re-discover them on every submission.
--
-- With this column, the AI review checks against the structured rules FIRST
-- (fast, deterministic) and falls back to the Design Guidelines PDF for
-- nuance + conditions (slower, generative). Staff edits the rules through
-- Community Profile without touching PDFs.
--
-- Expected keys (all optional — communities populate what's relevant):
--   min_square_footage             — int, e.g., 1500
--   max_square_footage             — int (optional ceiling)
--   roof_pitch_sides_min           — text, e.g., "8:12"
--   roof_pitch_porches_min         — text, e.g., "6:12"
--   masonry_front_elevation_min_pct — int, e.g., 35
--   masonry_wrap_distance_feet     — numeric, e.g., 2
--   single_material_max_pct        — int, e.g., 75 (no single material on >75% of front)
--   brick_spec                     — text, e.g., "ASTM C216-87"
--   brick_allowed_types            — array, e.g., ["king","queen"]
--   brick_prohibited_types         — array, e.g., ["jumbo","stucco_brick"]
--   brick_color_palette            — text, e.g., "earth tones"
--   mortar_joint_style             — text, e.g., "tooled (no slump)"
--   prohibited_materials           — array, e.g., ["Dryvit","EIFS"]
--   approved_paint_palette         — array of color names/codes
--   approved_paint_palette_doc_id  — uuid FK to library_documents holding the palette
--   adjacency_color_palette_prohibited — bool
--   notes                          — free-form catch-all for standards we
--                                    haven't structured yet
--
-- Schema decision: JSONB instead of separate columns because the standards
-- vary substantially between communities (Eaglewood's brick rules ≠ August
-- Meadows' brick rules ≠ Quail Ridge's brick rules). A JSONB document gives
-- per-community flexibility without 30+ nullable columns on communities.
-- The keys above are the canonical shape; future fields just extend the
-- JSONB without migrations.
--
-- Record ownership: 'workpaper' bucket — internal config that drives how
-- Bedrock evaluates submissions. Not delivered to the HOA on termination.
--
-- Apply after 134. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS builder_arc_standards JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN communities.builder_arc_standards IS
  'Structured ARC review standards (min sqft, roof pitches, masonry %, brick spec, prohibited materials, etc.). Read by /builder-arc-review.html''s AI assessment pipeline BEFORE falling back to the Design Guidelines PDF. Edit via Community Profile UI; no migration needed to add a new standards key. Per-community because no two HOA Design Guidelines are identical.';

-- Index for community lookups that filter on a specific standard
-- (e.g., "show me communities where min_square_footage > 2000"). Not common
-- but cheap to add a GIN index for ad-hoc queries.
CREATE INDEX IF NOT EXISTS idx_communities_builder_arc_standards
  ON communities USING GIN (builder_arc_standards);

COMMIT;
