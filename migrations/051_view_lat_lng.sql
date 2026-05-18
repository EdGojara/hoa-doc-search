-- ============================================================================
-- Migration 051 — surface lat/lng on v_current_property_owners
-- ----------------------------------------------------------------------------
-- Migration 050 added latitude + longitude + boundary to the properties table
-- (for the DRV/inspection map view + parcel polygon matching) but the view
-- v_current_property_owners (from migration 049) was never updated to include
-- them. The /api/inspections/properties endpoint queries that view selecting
-- latitude/longitude, which errored silently and made the inspect map see "0
-- properties" — geocoder button never appeared.
--
-- Postgres CREATE OR REPLACE VIEW can only ADD columns to the END of the
-- column list (can't reorder existing ones), so latitude/longitude/boundary
-- are appended. Column position doesn't matter for the API — only column
-- names matter to the .select() call.
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
  p.boundary
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST;

GRANT SELECT ON v_current_property_owners TO authenticated;
GRANT SELECT ON v_current_property_owners TO service_role;
