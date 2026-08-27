-- ============================================================================
-- 392 — Enable the homeowner "Property Compliance" tile for live communities.
-- ----------------------------------------------------------------------------
-- Ed 2026-08-27. The tile + its page (portal-compliance.html) + endpoint
-- (GET /api/portal/compliance) were fully built but never enabled for real
-- communities, so every homeowner saw "COMING SOON". Demo mode already had it
-- live (defaultDemoModuleConfig).
--
-- Two-step-enable discipline (CLAUDE.md scar "tiles as live without enabling in
-- the gate"): the demo default is set in page code; this migration flips the
-- per-community portal_module_config for existing communities.
--
-- SAFE TO ENABLE NOW because the endpoint was hardened the same day:
--   1. Fixed a broken SELECT (voided_at / severity / governing_doc_reference_id
--      columns don't exist — PostgREST was failing the whole query, so the tile
--      500'd for every real property and only demo ever rendered).
--   2. Added the accuracy gate: a homeowner sees ONLY notices we ACTUALLY
--      MAILED them (>=1 outbound letter with sent_at). The raw violations table
--      is ~76% phantom/unreviewed opens (AI + Vantaca imports with no letter);
--      the gate makes the tile show exactly what we sent, nothing we didn't.
--      Under-reporting is the safe direction; a phantom certified-209 shown to a
--      homeowner is not.
--
-- Renters never see it (RENTER_HIDDEN_TILES + endpoint assertOwnerLikeRole).
--
-- Record ownership: config on communities (association_record).
-- ============================================================================
BEGIN;

UPDATE communities
SET portal_module_config =
  COALESCE(portal_module_config, '{}'::jsonb)
  || jsonb_build_object('compliance', jsonb_build_object('status', 'live'))
WHERE COALESCE(portal_module_config -> 'compliance' ->> 'status', '') IS DISTINCT FROM 'live';

COMMIT;
