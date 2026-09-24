-- ============================================================================
-- 451_spine_updated_at_triggers.sql
-- ----------------------------------------------------------------------------
-- The property/owner spine (049) created updated_at columns with DEFAULT NOW()
-- but never attached the standard trusted_set_updated_at() trigger that 146
-- other tables use. Result: an UPDATE left updated_at frozen at insert time
-- unless the caller remembered to set it, and most callers do not. Found during
-- batch LOPF-MAIL-2026-09-24: 61 mailing updates and 6 seller end-dates
-- showed no updated_at change, so "changed since" audits cannot see them.
--
-- This attaches the existing convention (001_foundation.sql) to the four spine
-- tables that lack it. INSERT behaviour is unchanged (column defaults already
-- set created_at/updated_at = NOW()). created_at is never touched.
--
-- Forward-only: no historical timestamp is rewritten. No data changes.
-- Idempotent (DROP TRIGGER IF EXISTS / CREATE TRIGGER), matching 001.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON contacts;
CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_property_ownerships_updated_at ON property_ownerships;
CREATE TRIGGER trg_property_ownerships_updated_at
  BEFORE UPDATE ON property_ownerships
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_property_residencies_updated_at ON property_residencies;
CREATE TRIGGER trg_property_residencies_updated_at
  BEFORE UPDATE ON property_residencies
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- Verify:
--   SELECT tgrelid::regclass, tgname FROM pg_trigger
--    WHERE tgname LIKE 'trg_%_updated_at'
--      AND tgrelid::regclass::text IN ('contacts','property_ownerships','property_residencies','properties');
