-- ============================================================================
-- 528_books_closed_guard.sql  (Ed 2026-10-15)
-- ----------------------------------------------------------------------------
-- Ed: "Implement a general control preventing scheduled agents, AP intake,
-- payment confirmations, bank reconciliation jobs, and other automated
-- accounting workflows from posting to archived or terminated communities.
-- Preserve historical records and audit trails. Do not delete, reverse,
-- reconcile, or modify Eaglewood's accounting records."
--
-- Why a database guard: the application checks (lib/accounting/ownership.js,
-- 2026-10-11) cover AP intake, AP postings and payment confirmations, but
-- journal entries are also written by bank-reconciliation proposals, cutoff and
-- reclassification runs, interest and late fees, assessment billing (direct
-- inserts), homeowner payments, check receipts, Stripe payments and the
-- recognition / proration database functions. Eaglewood took 29 entries
-- ($44,165.29, 7/18 to 9/24/2026) through these paths after its books were
-- declared Vantaca's. One trigger on the ledger tables refuses every path,
-- including ones added later.
--
-- The rule mirrors lib/accounting/ownership.js accountingStatus: the ledger of a
-- community is CLOSED to writes when
--   books_of_record is not 'trusted', or financials_active is false, or
--   management_status is 'archived' / 'terminated', or
--   management_status is 'terminating' and the last day of management has passed, or
--   management_status is 'prospect'.
-- Closed means: no INSERT, UPDATE or DELETE on journal_entries or
-- journal_entry_lines for that community. Existing rows are preserved exactly
-- (no void, reversal, supersede, edit or delete). Reads are unaffected, so
-- history and exports stay available. Every active community is unaffected.
--
-- Changing a community's status back (e.g. reopening it) is itself the owner's
-- decision; this migration adds no override. A controlled owner-only correction path for
-- trustEd-books communities after their last day is proposed separately for Ed's decision.
-- Bulk backfills that update journal_entries / journal_entry_lines across communities must
-- exclude closed communities (community_books_closed_reason(community_id) IS NULL).
-- Record ownership: function and triggers only; no data rows change.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION community_books_closed_reason(p_community uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN c.id IS NULL THEN NULL
    WHEN c.books_of_record IS DISTINCT FROM 'trusted'
      THEN coalesce(c.name, 'This association') || '''s books are kept in ' || coalesce(c.books_of_record, 'another system') || ', not trustEd'
    WHEN c.financials_active IS FALSE
      THEN 'trustEd does not keep the books for ' || coalesce(c.name, 'this association')
    WHEN c.management_status IN ('archived', 'terminated')
      THEN coalesce(c.name, 'This association') || ' is a former client (' || c.management_status || ')'
    WHEN c.management_status = 'terminating' AND c.management_end_date IS NOT NULL
         AND c.management_end_date < (now() AT TIME ZONE 'America/Chicago')::date
      THEN coalesce(c.name, 'This association') || ' is past its last day of management (' || c.management_end_date || ')'
    WHEN c.management_status = 'prospect'
      THEN coalesce(c.name, 'This association') || ' is a prospect'
    ELSE NULL
  END
  FROM communities c
  WHERE c.id = p_community
$$;

COMMENT ON FUNCTION community_books_closed_reason(uuid) IS
  'NULL when trustEd keeps this community''s books; otherwise why its ledger is closed to writes. Mirrors lib/accounting/ownership.js accountingStatus. (mig 528)';

CREATE OR REPLACE FUNCTION journal_entries_books_closed_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_reason text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_reason := community_books_closed_reason(OLD.community_id);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'books_closed: % journal entry % refused: %. Its records are preserved as they are.', lower(TG_OP), OLD.reference, v_reason
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_reason := community_books_closed_reason(NEW.community_id);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'books_closed: posting refused: %.', v_reason USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION journal_entry_lines_books_closed_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_reason text;
  v_je uuid;
BEGIN
  FOREACH v_je IN ARRAY (CASE
      WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.journal_entry_id]
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.journal_entry_id]
      ELSE ARRAY[OLD.journal_entry_id, NEW.journal_entry_id] END) LOOP
    SELECT community_books_closed_reason(je.community_id) INTO v_reason FROM journal_entries je WHERE je.id = v_je;
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION 'books_closed: % journal entry line refused: %. Its records are preserved as they are.', lower(TG_OP), v_reason
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_books_closed ON journal_entries;
CREATE TRIGGER trg_journal_entries_books_closed
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_books_closed_guard();

DROP TRIGGER IF EXISTS trg_journal_entry_lines_books_closed ON journal_entry_lines;
CREATE TRIGGER trg_journal_entry_lines_books_closed
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_books_closed_guard();

REVOKE ALL ON FUNCTION community_books_closed_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION community_books_closed_reason(uuid) TO service_role;

COMMIT;
