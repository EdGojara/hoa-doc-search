-- ============================================================================
-- 098_community_contacts_dedupe.sql
-- ----------------------------------------------------------------------------
-- Fix: migration 096's seed used `ON CONFLICT DO NOTHING` without a unique
-- constraint to conflict against, so re-running the migration silently
-- created duplicate rows. Adds the missing UNIQUE constraint and dedupes
-- existing rows by (community_id, name), keeping the earliest created_at.
--
-- After this runs, re-running 096 / 097 is safe.
--
-- Apply after 097. Idempotent.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Dedupe — for each (community_id, name) collision, keep the earliest row
-- ----------------------------------------------------------------------------
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY community_id, name
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM community_contacts
)
DELETE FROM community_contacts
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ----------------------------------------------------------------------------
-- 2) Add the UNIQUE constraint so future seeds can use ON CONFLICT properly
-- ----------------------------------------------------------------------------
ALTER TABLE community_contacts
  DROP CONSTRAINT IF EXISTS uq_community_contacts_community_name;
ALTER TABLE community_contacts
  ADD CONSTRAINT uq_community_contacts_community_name UNIQUE (community_id, name);

COMMIT;
