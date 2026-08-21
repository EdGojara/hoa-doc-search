-- ============================================================================
-- 378_vendor_categories_simplify.sql  (Ed 2026-08-20)
-- ----------------------------------------------------------------------------
-- Twenty-one vendor categories become eight.
--
-- Ed: "i don't think we need a bunch of categories, its a home, maybe
-- landscaping, home exterior, home interior, electrical plumbing... i am
-- thinking functional things."
--
-- The old list had grown rather than been designed. "Landscaping & lawn care"
-- and "Mowing & yard maintenance" were both in it, which is the same thing
-- twice, and twenty-one chips is unscannable on the phone most homeowners will
-- read this on.
--
-- WHY EIGHT AND NOT FIVE. Heating & Cooling is split out because in Texas it is
-- one of the most-hired trades and burying it inside "interior" means nobody
-- finds it. Pool and Pest Control stand alone because they are RECURRING
-- services: a homeowner shopping for a pool company is in a different frame
-- from one whose water heater just failed.
--
-- WHY COARSE IS SAFE. Categories only have to be browse buckets. The search box
-- added alongside this does the specific work (fence, hail, water heater,
-- Carlos), and every submission still carries its own free-text project_type
-- for the detail. Without search you would need all twenty-one.
--
-- TIMING. vendor_experiences has ZERO rows, so this is a rename-and-replace
-- with nothing to migrate. The same change after launch means re-bucketing
-- every review a homeowner wrote. Done now precisely because it is free now.
--
-- The old rows are DEACTIVATED rather than deleted: vendor_category_id is a
-- RESTRICT foreign key, and deleting a category some future row points at would
-- fail. Inactive keeps the history honest and out of the picker.
--
-- IDEMPOTENT.
-- ============================================================================

BEGIN;

-- 1) Retire everything currently on the list.
UPDATE vendor_categories SET active = false, updated_at = NOW();

-- 2) The eight, in the order a homeowner thinks about their house: what is
--    outside it, what is inside it, then the systems that run it.
INSERT INTO vendor_categories (slug, label, display_order, active)
VALUES
  ('lawn_landscaping', 'Lawn & Landscaping', 10, true),
  ('home_exterior',    'Home Exterior',      20, true),
  ('home_interior',    'Home Interior',      30, true),
  ('plumbing',         'Plumbing',           40, true),
  ('electrical',       'Electrical',         50, true),
  ('heating_cooling',  'Heating & Cooling',  60, true),
  ('pool',             'Pool',               70, true),
  ('pest_control',     'Pest Control',       80, true),
  ('other',            'Other',              90, true)
ON CONFLICT (slug) DO UPDATE
  SET label = EXCLUDED.label,
      display_order = EXCLUDED.display_order,
      active = true,
      updated_at = NOW();

-- What each bucket is understood to cover, so the picker's help text and
-- anyone reading this later agree:
--   Lawn & Landscaping  mowing, beds, trees, irrigation, sprinklers
--   Home Exterior       roof, gutters, fence, siding, exterior paint,
--                       power washing, windows, driveway, concrete
--   Home Interior       flooring, interior paint, handyman, house cleaning
--   Plumbing            .
--   Electrical          .
--   Heating & Cooling   .
--   Pool                .
--   Pest Control        .

COMMIT;

-- Verify:
--   SELECT label, display_order FROM vendor_categories
--    WHERE active ORDER BY display_order;
