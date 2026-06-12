-- ----------------------------------------------------------------------------
-- Migration 214 — Vendor directory + community pricing intelligence
-- ----------------------------------------------------------------------------
--
-- Foundation for the homeowner-data-only vendor directory described in
-- memory note project_vendor_directory_pricing_intelligence.md.
--
-- Two tables:
--   1. vendor_categories — fixed lookup list (Painting, Roofing, etc.)
--      Seeded with the core categories homeowners hire most.
--   2. vendor_experiences — homeowner-submitted records. Free-text vendor
--      name (we don't pre-curate a vendor list — homeowners type whatever
--      company they actually used). Structured fields for price, would-
--      hire-again, what-they-did-well, what-could-improve, completed-
--      month/year, and community context.
--
-- Stars are intentionally NOT a column. Per strategy: 1–5 stars invite
-- gaming + meaningless without context. We collect would_hire_again as a
-- boolean instead — sharper signal, harder to manipulate.
--
-- Record ownership = mixed (CLAUDE.md taxonomy):
--   - The submission record (data + price) is association_record at the
--     community level (it belongs to the community's vendor intel)
--   - Aggregated portfolio-wide intelligence built from these records is
--     workpaper (Bedrock's analytical layer)
-- See CLAUDE.md "Record ownership" section.
--
-- Record ownership column is intentionally OMITTED for now — every row in
-- this table is association_record by default. When the Bedrock-ops view
-- is built (cross-community analytics), it queries an aggregating view,
-- not these rows directly. Add the column if/when we ever need per-row
-- carve-out.

BEGIN;

-- ----------------------------------------------------------------------------
-- vendor_categories — fixed lookup. Edit by inserting rows + setting
-- active=false on retired categories (don't DELETE — old experiences still
-- reference them).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  display_order INT  NOT NULL DEFAULT 100,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_categories TO service_role;
GRANT SELECT                          ON vendor_categories TO authenticated;

-- Seed the core categories. WHERE NOT EXISTS guards so re-running this
-- migration is idempotent — won't duplicate.
INSERT INTO vendor_categories (slug, label, display_order)
SELECT * FROM (VALUES
  ('painting',           'Painting (interior + exterior)',  10),
  ('landscaping',        'Landscaping & lawn care',          20),
  ('mowing',             'Mowing & yard maintenance',        25),
  ('fence',              'Fence repair / replacement',       30),
  ('roofing',            'Roofing',                          40),
  ('plumbing',           'Plumbing',                         50),
  ('electrical',         'Electrical',                       60),
  ('hvac',               'HVAC (heating + cooling)',         70),
  ('power_washing',      'Power washing',                    80),
  ('pest_control',       'Pest control',                     90),
  ('tree_service',       'Tree service / arborist',         100),
  ('cleaning',           'House cleaning',                  110),
  ('pool_service',       'Pool service',                    120),
  ('concrete',           'Concrete / driveway',             130),
  ('gutter',             'Gutter repair / installation',    140),
  ('handyman',           'General handyman',                150),
  ('garage_door',        'Garage door',                     160),
  ('flooring',           'Flooring',                        170),
  ('window',             'Window repair / replacement',     180),
  ('mildew_mold',        'Mildew / mold remediation',       190),
  ('other',              'Other',                           900)
) AS seed(slug, label, display_order)
WHERE NOT EXISTS (
  SELECT 1 FROM vendor_categories vc WHERE vc.slug = seed.slug
);

-- ----------------------------------------------------------------------------
-- vendor_experiences — the homeowner-submitted records.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_experiences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  portal_user_id      UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  property_id         UUID REFERENCES properties(id) ON DELETE SET NULL,

  vendor_name         TEXT NOT NULL,
  vendor_category_id  UUID NOT NULL REFERENCES vendor_categories(id) ON DELETE RESTRICT,
  project_type        TEXT,                -- free text: "Replaced cedar fence on south side"
  price_paid_cents    INT  CHECK (price_paid_cents IS NULL OR price_paid_cents >= 0),
  would_hire_again    BOOLEAN NOT NULL,    -- the only "rating" signal we collect
  did_well            TEXT,                -- "What they did well"
  could_improve       TEXT,                -- "What could improve"
  completed_month     INT  CHECK (completed_month IS NULL OR completed_month BETWEEN 1 AND 12),
  completed_year      INT  CHECK (completed_year IS NULL OR completed_year BETWEEN 2020 AND 2050),

  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the queries we'll run most:
--   - "show me all experiences for community X in category Y" (display path)
--   - "show me MY submissions" (homeowner reviewing their own history)
--   - "vendor recency" — order by submitted_at DESC for recency weighting
CREATE INDEX IF NOT EXISTS idx_vendor_experiences_community_category
  ON vendor_experiences (community_id, vendor_category_id);
CREATE INDEX IF NOT EXISTS idx_vendor_experiences_user
  ON vendor_experiences (portal_user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_experiences_submitted
  ON vendor_experiences (submitted_at DESC);

-- Trigger to keep updated_at fresh on UPDATEs
DROP TRIGGER IF EXISTS trg_vendor_experiences_updated_at ON vendor_experiences;
CREATE TRIGGER trg_vendor_experiences_updated_at
  BEFORE UPDATE ON vendor_experiences
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_vendor_categories_updated_at ON vendor_categories;
CREATE TRIGGER trg_vendor_categories_updated_at
  BEFORE UPDATE ON vendor_categories
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_experiences TO service_role;
GRANT SELECT                          ON vendor_experiences TO authenticated;

-- ----------------------------------------------------------------------------
-- Portal tile gate — flip vendor_directory to status='live' on every
-- existing community so the tile shows up on the homeowner portal. Mirrors
-- the pattern from migration 213 (arc tile) and the CLAUDE.md scar:
-- "Showing tiles as live without enabling them in the gate" — both the
-- demo default AND per-community config must be set.
-- ----------------------------------------------------------------------------
UPDATE communities
SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
                         || jsonb_build_object('vendor_directory', jsonb_build_object('status', 'live'))
WHERE
  (portal_module_config IS NULL)
  OR NOT (portal_module_config ? 'vendor_directory')
  OR (portal_module_config -> 'vendor_directory' ->> 'status') IS DISTINCT FROM 'live';

COMMIT;
