-- ===========================================================================
-- 323_violation_certified_notice_date.sql   (Ed 2026-07-21)
-- ---------------------------------------------------------------------------
-- The operating model for certified §209 cases: a certified notice is valid for
-- ~180 days (6 months). During that window the Association just OBSERVES on each
-- drive (re-verifies the violation still stands) — no new letter — until it's
-- either cured or referred to the attorney. To run that clock we need the DATE
-- the certified notice actually went out.
--
-- trustEd only has that date for the 2 cases it mailed itself (the §209 letter's
-- postmark). The other ~87 certified cases came over from Vantaca, where the
-- certified date lives — that's the list staff is dating by hand. This adds a
-- dedicated, authoritative field so the 180-day clock is exact (not guessed from
-- the import/restage date), and so staff can enter the Vantaca dates right in the
-- re-verification tool instead of a side spreadsheet.
--
-- Record ownership: association_record (part of the §209 enforcement file).
-- ===========================================================================
BEGIN;

ALTER TABLE violations ADD COLUMN IF NOT EXISTS certified_notice_date DATE;

COMMENT ON COLUMN violations.certified_notice_date IS
  'Date the certified §209 notice was mailed (postmark). Anchors the 180-day observe-until-attorney window. Backfilled from the trustEd §209 letter where mailed here; entered by staff for Vantaca carryovers.';

-- Backfill from the sent §209 letter''s postmark (the real mailing date) where
-- trustEd mailed it. COALESCE postmark_date, else the sent_at day. Only fills
-- rows that don''t already have a date, and only for still-certified cases.
UPDATE violations v
SET certified_notice_date = sub.d
FROM (
  SELECT i.violation_id,
         MAX(COALESCE(i.postmark_date, (i.sent_at AT TIME ZONE 'America/Chicago')::date)) AS d
  FROM interactions i
  WHERE i.type = 'letter_209'
    AND i.sent_at IS NOT NULL
    AND COALESCE(i.quality_status, '') <> 'flagged'   -- a wrong-address letter is not a valid notice date
  GROUP BY i.violation_id
) sub
WHERE v.id = sub.violation_id
  AND v.certified_notice_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_violations_certified_notice_date
  ON violations (community_id, certified_notice_date)
  WHERE current_stage = 'certified_209';

COMMIT;
