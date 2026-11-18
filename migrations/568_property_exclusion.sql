-- ============================================================================
-- 568_property_exclusion.sql
-- ----------------------------------------------------------------------------
-- A property row that is not a real lot (Ed 2026-11-18). Lakes of Pine Forest
-- has 542 homes (Harris County: 542 residential parcels, Sections 1-6) but
-- trustEd held 543 properties: 17914 Windy Orchard Lane (Vantaca 2012694) has
-- no county parcel. It was imported as a second Vantaca account for the owner
-- of 17914 Old Forest Lane (2012698); $0 balance, no activity.
--
-- Ownership tenures are permanent (456), so the row cannot be deleted. Instead
-- a property can be EXCLUDED: excluded_at + excluded_reason, both or neither.
-- An excluded property keeps its import history but is left out of
-- v_current_property_owners (mailings, statements, owner lists), the annual
-- assessment run and home counts (lib + api filter excluded_at IS NULL).
--
-- Record ownership: association_record (property spine). No rows deleted.
-- Row change: exactly one property (the LOPF phantom), guarded by id, address,
-- account and community.
-- ============================================================================
BEGIN;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS excluded_at timestamptz;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS excluded_reason text;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_exclusion_pair') THEN
    ALTER TABLE properties ADD CONSTRAINT properties_exclusion_pair
      CHECK ((excluded_at IS NULL) = (excluded_reason IS NULL) AND (excluded_reason IS NULL OR length(trim(excluded_reason)) >= 10));
  END IF;
END $c$;
CREATE INDEX IF NOT EXISTS idx_properties_community_included ON properties (community_id) WHERE excluded_at IS NULL;

-- Same columns as 549; only the WHERE is new, so CREATE OR REPLACE is safe and grants are kept.
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
  p.trusted_account_number,
  t.id              AS tenure_id,
  c.mailing_unit    AS owner_mailing_unit,
  c.mailing_country AS owner_mailing_country,
  c.mailing_address_source AS owner_mailing_source,
  c.mailing_address_updated_at AS owner_mailing_updated_at
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
LEFT JOIN ownership_tenures t  ON t.property_id = p.id AND t.kind = 'owner' AND t.end_date IS NULL
WHERE p.excluded_at IS NULL
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST, o.created_at ASC NULLS LAST, o.id ASC;

UPDATE properties
   SET excluded_at = '2026-11-18T12:00:00-06:00',
       excluded_reason = 'Not a lot: no Harris County parcel at this address (Lakes of Pine Forest has 542 residential parcels, all matched to other properties). Second Vantaca account (2012694) for the owner of 17914 Old Forest Lane (2012698). Excluded per Ed 2026-11-18.'
 WHERE id = 'abc07cff-0578-4fd2-a2fb-3781bbc1b9a5'
   AND community_id = 'a0000000-0000-4000-8000-000000000002'
   AND street_address = '17914 Windy Orchard Lane'
   AND vantaca_account_id = '2012694'
   AND excluded_at IS NULL;

COMMIT;
