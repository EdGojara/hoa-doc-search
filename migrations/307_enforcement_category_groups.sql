BEGIN;

-- ============================================================================
-- 307_enforcement_category_groups.sql  (Ed 2026-07-17)
-- ----------------------------------------------------------------------------
-- Two-layer taxonomy, step 1 (structure only — non-destructive, reversible, and
-- it does NOT change any letter output).
--
-- WHY: today "category" fuses two things — the SPECIFIC violation (what the
-- photo shows / the letter describes) and the AUTHORITATIVE GUIDANCE (the CC&R
-- provision the letter cites). Fusing them forced staff to mint one-off
-- "sentence categories" just to say something specific, and scattered one legal
-- basis across many near-duplicate categories.
--
-- This adds a GROUP layer:
--   enforcement_category_groups  — the guidance bucket that holds the shared
--                                  citation (resolved per community). The legal layer.
--   enforcement_categories.group_id — each specific category (subject+condition)
--                                  points to its group. The wording layer.
--
-- Enforceability stays per-community via community_enforcement_priorities
-- (priority='disabled' = that community doesn't cite it) — e.g. basketball goals
-- are allowed in most communities, but "in disrepair" cites the maintenance group.
--
-- This migration only creates the group table, adds group_id, seeds the groups,
-- and maps existing categories onto them. Letter citation-via-group + the
-- merge/child consolidation are SEPARATE later steps, reviewed before they ship.
--
-- Record ownership: reference (taxonomy config; Bedrock IP / workpaper).
-- ============================================================================

CREATE TABLE IF NOT EXISTS enforcement_category_groups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL,
  description    TEXT,
  display_order  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON enforcement_category_groups TO service_role;
GRANT SELECT                          ON enforcement_category_groups TO authenticated;

ALTER TABLE enforcement_categories
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES enforcement_category_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_enforcement_categories_group ON enforcement_categories (group_id);

-- ---- Seed the groups (the ~13 families) ------------------------------------
INSERT INTO enforcement_category_groups (slug, label, display_order) VALUES
  ('lawn',                 'Lawn',                          10),
  ('beds_borders_sod',     'Beds, Borders & Sod',           20),
  ('trees',                'Trees',                         30),
  ('trash_debris',         'Trash & Debris',                40),
  ('storage_unapproved',   'Storage of Unapproved Items',   50),
  ('vehicles_parking',     'Vehicles & Parking',            60),
  ('fences',               'Fences',                        70),
  ('exterior_maintenance', 'Structure & Exterior Repair',   80),
  ('appearance_mildew',    'Mildew / Appearance',           90),
  ('seasonal',             'Seasonal',                     100),
  ('recreation_equipment', 'Play & Recreation Equipment',  110),
  ('arc_modifications',    'ARC / Unapproved Modifications',120),
  ('conduct_use',          'Conduct & Use',                130)
ON CONFLICT (slug) DO NOTHING;

-- ---- Map existing categories onto groups (reversible; group_id only) --------
-- Prefix patterns cover the truncated one-off "sentence" slugs too. Specific
-- exceptions handled explicitly to avoid cross-mapping.
UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='lawn'
  AND (c.slug LIKE 'lawn%' OR c.slug IN ('weeds','mow_and_edge','grass_in_the_expansion_joints','property_maintenance_-_excessive_watering'));

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='beds_borders_sod'
  AND (c.slug LIKE 'landscaping%' OR c.slug LIKE 'sod%' OR c.slug LIKE 'dead_shrubs%');

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='trees'
  AND (c.slug LIKE 'tree%' OR c.slug IN ('stump','prune_trees'));

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='trash_debris'
  AND (c.slug LIKE 'trash%' OR c.slug LIKE '%heavy_trash%');

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='storage_unapproved'
  AND c.slug LIKE 'storage_of_unapproved%';

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='vehicles_parking'
  AND (c.slug LIKE 'vehicle%' OR c.slug LIKE 'parking%' OR c.slug LIKE 'atv%' OR c.slug LIKE 'trailer%'
       OR c.slug IN ('recreational_vehicle','stored_vehicle'));

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='fences'
  AND c.slug LIKE 'fence%';

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='exterior_maintenance'
  AND (c.slug LIKE 'driveway%' OR c.slug LIKE 'garage%' OR c.slug LIKE 'powerwash%' OR c.slug LIKE 'gutters%'
       OR c.slug LIKE 'paint%' OR c.slug LIKE 'siding%' OR c.slug LIKE 'roof%' OR c.slug LIKE 'window%'
       OR c.slug LIKE 'repair_replace%' OR c.slug LIKE 'exterior_lighting%'
       OR c.slug IN ('shutters','address_numbers','mailbox_damage','property_maintenance'));

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='appearance_mildew'
  AND c.slug LIKE 'mildew%';

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='seasonal'
  AND c.slug LIKE 'holiday%';

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='recreation_equipment'
  AND (c.slug LIKE 'portable_basketball%' OR c.slug LIKE 'play_equipment%');

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='arc_modifications'
  AND (c.slug LIKE 'no_arc%' OR c.slug LIKE 'shed_outbuilding%' OR c.slug LIKE 'arc_approved%'
       OR c.slug='unauthorized_modification');

UPDATE enforcement_categories c SET group_id = g.id
  FROM enforcement_category_groups g WHERE g.slug='conduct_use'
  AND (c.slug LIKE 'running_a_business%' OR c.slug LIKE 'flags%' OR c.slug IN ('pet_violation','fishing_violation'));

COMMIT;
