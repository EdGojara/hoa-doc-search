-- ============================================================================
-- 188_drama_creek_violations_seed.sql
-- ----------------------------------------------------------------------------
-- Drama Creek demo — DRV cycle seed. Adds violations for the personas
-- whose archetype implies an active enforcement situation:
--
--   Jennifer Lateleaves — one open landscape courtesy notice
--                         (her AR has the $75 fee from migration 187)
--   Greg Yardgone        — multi-stage escalation history culminating in
--                         a current fine_assessed stage (matches his
--                         at-legal AR status from migration 187)
--
-- Other personas stay clean — Bob, Margaret, Patricia, the board members
-- all show "in good standing" compliance status in the portal.
--
-- DEPENDENCIES:
--   - community_enforcement_priorities row for Drama Creek × every
--     enforcement category. Migration 050 seeded this for every community
--     that existed AT THAT TIME. Drama Creek arrived in migration 184
--     AFTER 050 ran — so we backfill the priorities first.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Backfill community_enforcement_priorities for Drama Creek.
--    Without this, the violations insert below fails FK lookup on the
--    priority weight resolution. Cross-join the global category table
--    with just Drama Creek and default everything to 'standard'.
-- ----------------------------------------------------------------------------
INSERT INTO community_enforcement_priorities
  (community_id, category_id, priority_weight, notes)
SELECT
  'dc100000-0000-4000-a000-000000000000'::uuid,
  ec.id,
  'standard',
  'Demo seed via migration 188'
FROM enforcement_categories ec
WHERE NOT EXISTS (
  SELECT 1 FROM community_enforcement_priorities cep
   WHERE cep.community_id = 'dc100000-0000-4000-a000-000000000000'::uuid
     AND cep.category_id  = ec.id
     AND cep.end_date IS NULL
);

-- ----------------------------------------------------------------------------
-- 2) Jennifer Lateleaves — ONE open landscape courtesy notice.
--    Opened 12 days ago, current_stage='courtesy_1', cure period running.
--    This matches her demo profile: "active enforcement scenario."
-- ----------------------------------------------------------------------------
INSERT INTO violations (
  id, property_id, community_id, primary_category_id,
  board_priority_at_open, current_stage, current_stage_started_at,
  cure_period_ends_at, opened_at
)
SELECT
  'dc170001-0000-4000-a000-000000000000'::uuid,
  'dc110011-0000-4000-a000-000000000000'::uuid,                       -- Jennifer's property: 102 Serenity Court
  'dc100000-0000-4000-a000-000000000000'::uuid,
  ec.id,
  'standard',
  'courtesy_1',
  NOW() - INTERVAL '12 days',
  NOW() + INTERVAL '18 days',                                          -- 30-day cure period from open
  NOW() - INTERVAL '12 days'
FROM enforcement_categories ec WHERE ec.slug = 'landscaping_overgrown'
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3) Greg Yardgone — multi-violation escalation history.
--    His at-legal AR ($4,800) from migration 187 implies long-running
--    enforcement issues. Seed THREE violations across categories — two
--    at fine_assessed (max stage), one at certified_209 (one step before).
--    All consistent with the "yard gone" archetype: lawn dead, weeds
--    everywhere, fence falling apart.
-- ----------------------------------------------------------------------------

-- Greg's violation #1: lawn dead patches, escalated to fine
INSERT INTO violations (
  id, property_id, community_id, primary_category_id,
  board_priority_at_open, current_stage, current_stage_started_at,
  cure_period_ends_at, opened_at
)
SELECT
  'dc170002-0000-4000-a000-000000000000'::uuid,
  'dc110041-0000-4000-a000-000000000000'::uuid,                       -- Greg's property: 301 Calm Waters Way
  'dc100000-0000-4000-a000-000000000000'::uuid,
  ec.id,
  'elevated',                                                          -- board prioritized lawn issues
  'fine_assessed',
  NOW() - INTERVAL '45 days',
  NOW() - INTERVAL '15 days',                                          -- cure expired, fine assessed
  NOW() - INTERVAL '120 days'
FROM enforcement_categories ec WHERE ec.slug = 'lawn_dead_patches'
ON CONFLICT (id) DO NOTHING;

-- Greg's violation #2: weeds, also at fine
INSERT INTO violations (
  id, property_id, community_id, primary_category_id,
  board_priority_at_open, current_stage, current_stage_started_at,
  cure_period_ends_at, opened_at
)
SELECT
  'dc170003-0000-4000-a000-000000000000'::uuid,
  'dc110041-0000-4000-a000-000000000000'::uuid,
  'dc100000-0000-4000-a000-000000000000'::uuid,
  ec.id,
  'standard',
  'fine_assessed',
  NOW() - INTERVAL '30 days',
  NOW() - INTERVAL '10 days',
  NOW() - INTERVAL '95 days'
FROM enforcement_categories ec WHERE ec.slug = 'weeds'
ON CONFLICT (id) DO NOTHING;

-- Greg's violation #3: fence damage, at certified mail (TX §209 step)
INSERT INTO violations (
  id, property_id, community_id, primary_category_id,
  board_priority_at_open, current_stage, current_stage_started_at,
  cure_period_ends_at, opened_at
)
SELECT
  'dc170004-0000-4000-a000-000000000000'::uuid,
  'dc110041-0000-4000-a000-000000000000'::uuid,
  'dc100000-0000-4000-a000-000000000000'::uuid,
  ec.id,
  'standard',
  'certified_209',
  NOW() - INTERVAL '20 days',
  NOW() + INTERVAL '10 days',                                          -- 30-day cure from certified
  NOW() - INTERVAL '60 days'
FROM enforcement_categories ec WHERE ec.slug = 'fence_damage'
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--
--   SELECT v.current_stage, ec.label, p.street_address
--   FROM violations v
--   JOIN enforcement_categories ec ON ec.id = v.primary_category_id
--   JOIN properties p ON p.id = v.property_id
--   WHERE v.community_id = 'dc100000-0000-4000-a000-000000000000'
--   ORDER BY v.opened_at DESC;
--   -- Expected: 4 rows
--   --   certified_209 · Fence damage · 301 Calm Waters Way
--   --   courtesy_1    · Landscaping overgrown · 102 Serenity Court
--   --   fine_assessed · Weeds · 301 Calm Waters Way
--   --   fine_assessed · Lawn dead patches · 301 Calm Waters Way
-- ============================================================================
