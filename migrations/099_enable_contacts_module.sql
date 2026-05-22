-- ============================================================================
-- 099_enable_contacts_module.sql
-- ----------------------------------------------------------------------------
-- Default the new "contacts" portal module to 'live' for every community
-- that has portal_module_config set. Without this, real homeowners would
-- see the new Local Contacts tile as "Coming soon" even though the data
-- is seeded and the page works.
--
-- The JSONB merge uses || (right operand wins) so this only adds the
-- contacts key — doesn't disturb any other modules' status that managers
-- may have already configured.
--
-- Apply after 098. Idempotent (re-running is a no-op).
-- ============================================================================

BEGIN;

-- For communities with an existing portal_module_config: merge in
-- contacts.live if not already set
UPDATE communities
SET portal_module_config = COALESCE(portal_module_config, '{}'::jsonb)
                           || jsonb_build_object('contacts', jsonb_build_object('status', 'live'))
WHERE portal_module_config IS NULL
   OR NOT (portal_module_config ? 'contacts');

COMMIT;
