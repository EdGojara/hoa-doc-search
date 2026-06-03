-- ============================================================================
-- 153_contacts_structured_mailing.sql
-- ----------------------------------------------------------------------------
-- Adds structured mailing columns to contacts. The Roster Import template
-- (clean once, verify forever) and the bedrock-vote bridge both need
-- the mailing address split into street/city/state/zip — the current
-- single `mailing_address` TEXT column is fragile (parse-required to
-- extract zip for labels, no way to validate components separately).
--
-- This matches the pattern bedrock-vote already adopted in its
-- migration 003: structured fields are canonical, the legacy single
-- field stays for back-compat but is no longer the source of truth.
--
-- COLUMNS:
--   mailing_street  TEXT  — street + unit ("5802 Acacia Rose Court Apt 12B")
--   mailing_city    TEXT
--   mailing_state   TEXT  — 2-letter, defaults TX
--   mailing_zip     TEXT  — 5-digit or 5-digit+4
--
-- BACKFILL:
--   Best-effort parse of the existing mailing_address string. Pattern
--   matched is "STREET, CITY, STATE ZIP" — anything that doesn't match
--   cleanly leaves structured fields NULL. The Roster Import flow then
--   surfaces them as "needs cleanup" rows for operator review. We do
--   NOT touch contacts that already have structured fields populated
--   (idempotent re-run, also lets future imports take precedence over
--   any legacy parsing).
--
-- BACKWARD COMPAT:
--   The original mailing_address column is preserved. Reads that go
--   through PostgREST select('mailing_address') continue to work. New
--   writes should populate BOTH the structured fields and a composed
--   mailing_address ("STREET, CITY, STATE ZIP") so legacy consumers
--   don't break. The Roster Import apply endpoint handles this.
-- ============================================================================

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS mailing_street TEXT,
  ADD COLUMN IF NOT EXISTS mailing_city   TEXT,
  ADD COLUMN IF NOT EXISTS mailing_state  TEXT DEFAULT 'TX',
  ADD COLUMN IF NOT EXISTS mailing_zip    TEXT;

COMMENT ON COLUMN contacts.mailing_street IS 'Canonical mailing line 1 — street + unit. Source of truth for mailing labels.';
COMMENT ON COLUMN contacts.mailing_city   IS 'Canonical mailing city. Used by mailing-label renderers without parsing.';
COMMENT ON COLUMN contacts.mailing_state  IS '2-letter state code (defaults TX).';
COMMENT ON COLUMN contacts.mailing_zip    IS '5-digit ZIP (or 5+4). Required for any mailing where structured fields are set.';

-- Best-effort backfill — only for contacts that have a mailing_address
-- string AND don't yet have structured fields populated. The split
-- assumes the standard "STREET, CITY, STATE ZIP" comma-separated shape.
-- Anything that doesn't parse cleanly leaves the row NULL — visible as
-- a gap on the Roster Import preview so the operator can fix it.
UPDATE contacts
SET
  mailing_street = TRIM(SPLIT_PART(mailing_address, ',', 1)),
  mailing_city   = TRIM(SPLIT_PART(mailing_address, ',', 2)),
  mailing_state  = COALESCE(
    NULLIF(TRIM(SPLIT_PART(TRIM(SPLIT_PART(mailing_address, ',', 3)), ' ', 1)), ''),
    'TX'
  ),
  mailing_zip    = NULLIF(TRIM(SPLIT_PART(TRIM(SPLIT_PART(mailing_address, ',', 3)), ' ', 2)), '')
WHERE mailing_address IS NOT NULL
  AND TRIM(mailing_address) <> ''
  AND mailing_street IS NULL
  AND mailing_address LIKE '%,%,%';

-- Recreate v_current_property_owners to surface the structured fields
-- alongside the legacy mailing_address. CREATE OR REPLACE VIEW only
-- appends columns at the end (Postgres rule), so the prior columns
-- keep their positions; the new fields are added last.
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
  c.mailing_zip     AS owner_mailing_zip
FROM properties p
LEFT JOIN property_ownerships o ON o.property_id = p.id AND o.end_date IS NULL
LEFT JOIN contacts c           ON c.id = o.contact_id
ORDER BY p.id, o.is_primary DESC NULLS LAST, o.start_date ASC NULLS LAST;

GRANT SELECT ON v_current_property_owners TO authenticated;
GRANT SELECT ON v_current_property_owners TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After applying:
--
--   SELECT
--     count(*) AS total_contacts_with_mailing,
--     count(*) FILTER (WHERE mailing_zip IS NOT NULL) AS structured_populated,
--     count(*) FILTER (WHERE mailing_zip IS NULL) AS structured_missing
--   FROM contacts
--   WHERE mailing_address IS NOT NULL AND TRIM(mailing_address) <> '';
--
-- "structured_missing" rows are candidates for the Roster Import
-- "needs cleanup" UI in the next download cycle.
-- ============================================================================
