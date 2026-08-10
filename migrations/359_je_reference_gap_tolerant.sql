-- ============================================================================
-- 359_je_reference_gap_tolerant.sql
-- ----------------------------------------------------------------------------
-- Harden next_je_reference so a deleted journal entry can never wedge posting.
--
-- Scar (Ed 2026-08-10): the generator (migration 170) numbered entries by
-- COUNT(*) + 1 per community/year. That is fine only while references are a
-- perfectly contiguous 1..COUNT run. The moment ANY journal entry is hard
-- deleted, COUNT drops below the highest existing number, so COUNT+1 lands on a
-- reference that already exists -> the UNIQUE(community_id, reference) constraint
-- rejects the next post and that community can no longer post a journal entry.
-- Hit live on Lakes of Pine Forest after an erroneous AP accrual was removed.
-- (Normal operation VOIDS entries rather than deleting them, and a void adds a
-- reversal so the count only grows -- but nothing should be one delete away from
-- a wedged ledger.)
--
-- Fix: number from MAX(existing suffix) + 1 over the 'JE-<year>-NNNNN'
-- references, which tolerates gaps, and serialize concurrent callers per
-- (community, year) with a transaction-scoped advisory lock so two simultaneous
-- posts can't read the same MAX and collide. The old COUNT+1 was labelled
-- "race-safe" but was not -- two concurrent posts got the same count.
--
-- Record ownership: DDL only (a function). No data rows. association_record N/A.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION next_je_reference(p_community_id UUID, p_fiscal_year INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_next INTEGER;
BEGIN
  -- Serialize callers for this community/year so concurrent posts can't grab the
  -- same number between the SELECT and the caller's INSERT. Transaction-scoped:
  -- released automatically at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_community_id::text || ':' || p_fiscal_year::text, 0)
  );

  -- Highest number already used for this community/year, gap-tolerant.
  SELECT COALESCE(
           MAX((substring(reference FROM ('^JE-' || p_fiscal_year || '-(\d{5})$')))::INTEGER),
           0
         ) + 1
    INTO v_next
  FROM journal_entries
  WHERE community_id = p_community_id
    AND reference ~ ('^JE-' || p_fiscal_year || '-\d{5}$');

  RETURN 'JE-' || p_fiscal_year || '-' || lpad(v_next::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;

COMMIT;
