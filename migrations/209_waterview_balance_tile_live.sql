-- ============================================================================
-- 209_waterview_balance_tile_live.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 — Flip the Account Balance tile from "coming_soon" to "live"
-- for Waterview Estates only. Ed populated AR transactions for Waterview
-- (homeowner_transactions has data; v_homeowner_current_balance returns
-- real numbers); now homeowners (and Ed's testing in manager view) can
-- drill into the Balance card and see aging buckets, snapshot history,
-- payment plan card, etc.
--
-- All other communities remain "coming_soon" until their AR data is
-- imported and Ed confirms readiness. Targeted, idempotent.
-- ============================================================================

BEGIN;

UPDATE communities
SET portal_module_config =
  COALESCE(portal_module_config, '{}'::jsonb)
  || jsonb_build_object('balance', jsonb_build_object('status', 'live'))
WHERE slug = 'waterview'
  AND (
    portal_module_config IS NULL
    OR NOT (portal_module_config->'balance'->>'status' = 'live')
  );

COMMIT;
