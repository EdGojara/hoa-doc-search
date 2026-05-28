-- ============================================================================
-- 124_dedup_property_ownerships.sql
-- ----------------------------------------------------------------------------
-- Cleans up duplicate active-ownership rows that appeared in the Vantaca
-- import for Eaglewood / Still Creek Ranch / Waterview Estates / August
-- Meadows. The import pipeline ran twice on these communities, creating
-- a second identical property_ownerships row per (property_id, contact_id)
-- pair. Diagnostic on 2026-05-28 confirmed every duplicated row appears
-- exactly twice — clean 2x duplication, not random data corruption.
--
-- Why this is safe:
--   - `properties` table is unaffected (one row per address — confirmed
--     by the 'distinct_addresses = total_rows' diagnostic).
--   - Duplicate rows are EXACT matches: same property_id, contact_id,
--     start_date, end_date. Deleting the later-created copy preserves
--     all factual ownership information.
--   - No table FKs to property_ownerships.id (it's a relationship row,
--     not a parent of anything else). Safe to DELETE.
--
-- What it does:
--   For every (property_id, contact_id, start_date, end_date) group of
--   2+ rows, keeps the earliest by (created_at, id) and deletes the rest.
--
-- Apply AFTER 123. Idempotent — re-running on cleaned data finds 0
-- duplicates and deletes 0 rows.
-- ============================================================================

BEGIN;

-- Compute the deletion count up front for the audit trail. Bedrock log-of-
-- record can show "removed N duplicate ownership records on YYYY-MM-DD"
-- without grepping migration files later.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT property_id, contact_id, start_date, end_date, COUNT(*) AS rows
    FROM property_ownerships
    GROUP BY property_id, contact_id, start_date, end_date
    HAVING COUNT(*) > 1
  ) AS dups;
  RAISE NOTICE '[124_dedup_property_ownerships] found % (property_id, contact_id, start_date, end_date) groups with duplicate rows', dup_count;
END $$;

-- Rank rows within each duplicate group, keep rn=1 (earliest), delete the rest.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY property_id, contact_id, start_date, end_date
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM property_ownerships
)
DELETE FROM property_ownerships po
USING ranked r
WHERE po.id = r.id
  AND r.rn > 1;

-- Sanity check after delete — should report 0
DO $$
DECLARE
  remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM (
    SELECT property_id, contact_id, start_date, end_date
    FROM property_ownerships
    GROUP BY property_id, contact_id, start_date, end_date
    HAVING COUNT(*) > 1
  ) AS dups;
  IF remaining > 0 THEN
    RAISE WARNING '[124_dedup_property_ownerships] STILL % duplicate groups after cleanup — investigate', remaining;
  ELSE
    RAISE NOTICE '[124_dedup_property_ownerships] verified: 0 duplicate groups remaining';
  END IF;
END $$;

COMMIT;
