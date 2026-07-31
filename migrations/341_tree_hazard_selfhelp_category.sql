-- ============================================================================
-- 341_tree_hazard_selfhelp_category.sql  (Ed 2026-07-31)
-- ----------------------------------------------------------------------------
-- Third self-help remedy: a 10-day certified notice for a dead/failing/hazardous
-- tree at risk of falling. Same track as lawn_force_mow_10day and
-- trash_cleanup_10day — after a 10-day notice the Association may enter and abate
-- at the owner's expense under the Declaration's general self-help authority.
-- The letter renderer (lib/lawn_force_mow_renderer.js) already carries the 'tree'
-- remedy mode; api/enforcement.js routes this slug to it. Lands in the same
-- category group as the other self-help remedies (looked up, not hard-coded, so
-- it's environment-agnostic). Idempotent: slug is UNIQUE (mig 307).
--
-- Record ownership: workpaper (internal enforcement configuration).
-- Already applied live via service-role insert on 2026-07-31; this file makes it
-- reproducible on a fresh database.
-- ============================================================================
BEGIN;

INSERT INTO enforcement_categories (slug, label, description, default_priority_weight, display_order, group_id, recurrence_escalates)
SELECT
  'tree_hazard_10day',
  'Tree - 10-Day Certified Hazard Removal',
  'Dead, failing, or hazardous tree at risk of falling, requiring 10-day certified notice before contractor self-help removal/abatement. Special enforcement track per the Declaration self-help authority + TX Property Code §202.018, not the standard §209 cure progression.',
  'aggressive',
  101,
  (SELECT group_id FROM enforcement_categories WHERE slug = 'lawn_force_mow_10day'),
  false
ON CONFLICT (slug) DO NOTHING;

COMMIT;
