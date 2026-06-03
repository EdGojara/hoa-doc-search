-- ============================================================================
-- Migration 152 — surface vantaca_account_id on v_current_property_owners
-- ----------------------------------------------------------------------------
-- The roster_import "Download with current data" endpoint queries
-- v_current_property_owners selecting vantaca_account_id (the match
-- key for re-uploads — that's how trustEd correlates a cleaned CSV row
-- back to its original property record). The view from migration 049 +
-- 051 doesn't expose it, so the download fails with:
--   "column v_current_property_owners.vantaca_account_id does not exist"
--
-- Same fix pattern as mig 051: CREATE OR REPLACE VIEW, append the
-- column at the end of the projection list. Column-position doesn't
-- matter to the API caller, only the name.
-- ============================================================================

CREATE OR REPLACE VIEW v_current_property_owners AS
SELECT DISTINCT ON (p.id)
  p.id              AS property_id,
  p.community_id,
  p.street_address,
  p.unit,
  p.city,
  p.state,
  p.zip,
  p.property_type,
  p.lot_number,
  c.id              AS owner_contact_id,
  c.full_name       AS owner_name,
  c.primary_email   AS owner_email,
  c.primary_phone   AS owner_phone,
  c.mailing_address AS owner_mailing_address,
  o.start_date      AS owned_since,
  o.vesting,
  o.is_primary,
  p.latitude,
  p.longitude,
  p.boundary,
  p.vantaca_account_id
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST;

GRANT SELECT ON v_current_property_owners TO authenticated;
GRANT SELECT ON v_current_property_owners TO service_role;
