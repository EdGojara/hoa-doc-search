-- ============================================================================
-- 082_portal_module_config.sql
-- ----------------------------------------------------------------------------
-- Per-community config for which homeowner portal modules show as live vs
-- "coming soon" vs hidden. Default: every module coming_soon until explicitly
-- enabled per community.
--
-- See project_homeowner_portal_as_showcase.md — the "framework first, fill
-- modules incrementally" architecture. Every tile renders for every community;
-- the JSONB controls the per-community status of each one.
--
-- Module keys (these match what the /portal page renders):
--   property_summary  -- live for all communities by default once enabled
--   balance           -- live when owner_ar_snapshots populated
--   arc               -- live where ACC form is configured
--   compliance        -- coming soon (DRV viewer)
--   key_fob           -- live where fob_request configured
--   clubhouse         -- live where amenities + Stripe Connect configured
--   payments          -- coming soon (Vantaca portal link + Stripe history)
--   documents         -- live when community has docs published
--   meetings          -- coming soon (calendar + agenda + minutes)
--   map               -- coming soon (Leaflet + amenity pins)
--
-- Status enum: 'live' | 'coming_soon' | 'maintenance' | 'hidden'
-- Default for any module not in the JSONB: 'coming_soon'.
--
-- Apply after 081. Idempotent.
-- ============================================================================

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS portal_module_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS portal_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS portal_welcome_message TEXT;

COMMENT ON COLUMN communities.portal_module_config IS
  'Per-community status of each portal module. JSONB shape: {"module_key": {"status": "live|coming_soon|maintenance|hidden", "link"?: "absolute or relative URL", "notes"?: "..."}}. Modules not in the object default to coming_soon. portal_active is the master kill switch — must be TRUE for any homeowner to see the portal at all.';
COMMENT ON COLUMN communities.portal_active IS
  'Master kill switch for the homeowner portal at this community. FALSE by default — homeowners see "portal not yet available" until the community board approves rollout.';
COMMENT ON COLUMN communities.portal_welcome_message IS
  'Optional community-specific welcome line shown at the top of the portal. e.g., "Welcome to Waterview Estates. Pool opens May 1st." Renders below the property card.';
