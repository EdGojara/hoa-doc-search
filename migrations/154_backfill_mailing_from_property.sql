-- ============================================================================
-- 154_backfill_mailing_from_property.sql
-- ----------------------------------------------------------------------------
-- Migration 153 added structured mailing columns to contacts and did a
-- best-effort parse of the legacy mailing_address string. But rows where
-- mailing_address was NULL (or empty) — which the old convention meant
-- "mailing = property address" — were left with NULL structured fields.
-- That's the implicit fallback rule we're trying to retire.
--
-- This migration makes the rule EXPLICIT: for every contact that:
--   - has NULL/empty structured mailing fields after mig 153, AND
--   - has exactly one active property ownership
-- we copy the property's street + unit + city + state + zip into the
-- contact's mailing columns. After this runs, every contact in the
-- spine carries a fully-populated mailing block; downstream label
-- printers + the bedrock-vote bridge can read mailing_* directly
-- with no conditional "if blank, fall back to property" logic.
--
-- DEFENSIVE SCOPE:
--   - Only touches contacts where mailing_street IS NULL (idempotent
--     re-run; never overwrites operator-set values)
--   - Skips contacts with multiple active ownerships (ambiguous which
--     property's address to use; operator handles via Roster Import)
--   - Also writes the composed mailing_address string back for
--     back-compat readers
--
-- DOES NOT TOUCH:
--   - data_verified_at — backfill is a default-population pass, not
--     an operator verification. Roster Import is still required to
--     stamp these rows as verified (the next operator pass will).
-- ============================================================================

BEGIN;

WITH single_property_owners AS (
  SELECT
    o.contact_id,
    p.street_address,
    p.unit,
    p.city,
    p.state,
    p.zip,
    COUNT(*) OVER (PARTITION BY o.contact_id) AS ownership_count
  FROM property_ownerships o
  JOIN properties p ON p.id = o.property_id
  WHERE o.end_date IS NULL
)
UPDATE contacts c
SET
  mailing_street  = TRIM(
                      CONCAT(spo.street_address, CASE WHEN spo.unit IS NOT NULL AND TRIM(spo.unit) <> '' THEN ' ' || spo.unit ELSE '' END)
                    ),
  mailing_city    = spo.city,
  mailing_state   = COALESCE(spo.state, 'TX'),
  mailing_zip     = spo.zip,
  mailing_address = TRIM(
                      CONCAT(spo.street_address, CASE WHEN spo.unit IS NOT NULL AND TRIM(spo.unit) <> '' THEN ' ' || spo.unit ELSE '' END,
                             ', ', spo.city, ', ', COALESCE(spo.state, 'TX'), ' ', spo.zip)
                    )
FROM single_property_owners spo
WHERE c.id = spo.contact_id
  AND spo.ownership_count = 1
  AND (c.mailing_street IS NULL OR TRIM(c.mailing_street) = '');

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After applying:
--
--   -- Count of contacts with fully-populated mailing block:
--   SELECT count(*) AS contacts_with_mailing
--   FROM contacts
--   WHERE mailing_street IS NOT NULL
--     AND mailing_city IS NOT NULL
--     AND mailing_zip IS NOT NULL;
--
--   -- Count of contacts STILL missing mailing (multi-property owners
--   -- or contacts without active ownership — operator handles via
--   -- Roster Import per community):
--   SELECT count(*) AS contacts_still_missing
--   FROM contacts c
--   WHERE c.mailing_street IS NULL;
-- ============================================================================
