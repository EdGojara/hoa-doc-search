-- ===========================================================================
-- 317_owner_view_trusted_number.sql
-- ---------------------------------------------------------------------------
-- Surface the trustEd account number (mig 252) on v_current_property_owners so
-- owner-facing search/detail/statement surfaces can MATCH and DISPLAY a
-- homeowner by EITHER the trustEd number or the Vantaca number (Ed 2026-07-19:
-- "match homeowners based on either numbers" until the statement cutover).
--
-- APPENDED as the LAST column so this is a pure CREATE OR REPLACE (no DROP) —
-- existing column positions are unchanged, so GRANTs and any dependent views
-- are preserved (avoids the DROP-VIEW-loses-GRANTs / CASCADE scars).
-- ===========================================================================
BEGIN;

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
  p.vantaca_account_id,
  c.mailing_street  AS owner_mailing_street,
  c.mailing_city    AS owner_mailing_city,
  c.mailing_state   AS owner_mailing_state,
  c.mailing_zip     AS owner_mailing_zip,
  p.trusted_account_number         -- appended last (mig 252 trustEd account #)
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST;

COMMIT;
