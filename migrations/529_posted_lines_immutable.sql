-- ============================================================================
-- 529_posted_lines_immutable.sql  (Ed 2026-10-15)
-- ----------------------------------------------------------------------------
-- A posted journal entry's lines are permanent, in an open month or a closed
-- one. A wrong posted entry is corrected by a new entry (a reversal and a
-- replacement, lib/accounting/correct_entry.js), never by changing its lines.
--
-- THE SCAR (2026-09-28/29, Lakes of Pine Forest). Re-coding four unpaid Barker
-- Cypress MUD bills ran, in api/ap.js (before PR #102):
--     try { delete journal_entry_lines; delete journal_entries } catch { stop }
-- supabase-js returns { error } instead of throwing. The lines went; the header
-- delete was refused by the foreign key from CONV-LPF-20260731-NEUT-JE-0016x/
-- 0017x (reverses_je_id); nothing noticed. JE-2026-00169..00172 have kept their
-- headers ($6,277.75) with no lines since, and the certified 7/31 AP balance is
-- off by $3,409.50.
--
-- PR #102 (mig 503) removed every application path that did this, and
-- scripts/check_posted_lines_immutable.js fails the build if one comes back.
-- Migration 502 locks lines in a CLOSED month; migration 528 locks the whole
-- ledger of a former client. Neither stops a delete of posted lines in an OPEN
-- month of an active community, which is exactly where the scar happened, and
-- neither covers operator scripts or database functions. This trigger does.
--
-- The rule, on journal_entry_lines (any community, any month):
--   DELETE of a line whose entry is not a draft                 -> refused
--   UPDATE that changes anything on a line of a non-draft entry
--     (or moves a line into a non-draft entry)                  -> refused
--   INSERT                                                       -> unchanged
--     (postJournalEntry and the database posting functions write the header,
--      then its lines; scripts/migrate_community_gl.js writes a posted daily
--      entry's lines in 200-row requests, so a commit-time balance check would
--      break it. A draft's lines stay fully editable, which is
--      editJournalEntry's only line path.)
-- And on journal_entries (status posted / voided / superseded):
--   never turned back into a draft (that would unlock its lines);
--   a void is final (voided -> anything else, or a changed void_reversal_je_id,
--   is refused: the reversal is live, so un-voiding would count it twice);
--   community_id, posting_date, period_id, total_debits_cents,
--   total_credits_cents and reverses_je_id never change.
--   Allowed: description, notes, source document links, needs_review,
--   classification_reason, prior_period_through, last_edited_*, the void flip
--   (posted -> voided with its reversal), the superseded flip and its restore.
--   Every application path that updates a header (lib/accounting/posting.js
--   voidJournalEntry + editJournalEntry, lib/ap/intake.js document links,
--   lib/accounting/record_vendor_payment.js review flag, the 466 / 488 / 498 /
--   501 database functions' void and superseded flips, 509's prior-period flag)
--   writes only allowed columns.
--
-- Coexists with 502 (trg_*_close_guard) and 528 (trg_*_books_closed): separate
-- functions and triggers, each refusing on its own condition. Postgres fires
-- same-event BEFORE row triggers in name order, so the order is fixed:
--   journal_entries:     trg_journal_entries_books_closed (528)
--                        -> trg_journal_entries_close_guard (502)
--                        -> trg_journal_entries_posted_guard (529)
--   journal_entry_lines: trg_journal_entry_lines_books_closed (528)
--                        -> trg_journal_entry_lines_close_guard (502)
--                        -> trg_journal_entry_lines_posted_guard (529)
-- None modifies NEW, so the order only decides which message a doubly
-- refused write shows. Error messages start 'posted_lines_immutable:'.
-- Record ownership: functions and triggers only; no data row changes. Repairs
-- nothing (the LOPF repair is a separate, in-app approved correcting entry).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION journal_entry_lines_posted_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old record;
  v_new record;
BEGIN
  SELECT reference, status INTO v_old FROM journal_entries WHERE id = OLD.journal_entry_id;
  IF TG_OP = 'DELETE' THEN
    IF FOUND AND v_old.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'posted_lines_immutable: the lines of % (%) are permanent and cannot be deleted; post a correcting entry instead', v_old.reference, v_old.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: a no-op write is harmless; any real change to a non-draft entry's line is refused.
  IF ROW(NEW.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
    RETURN NEW;
  END IF;
  IF FOUND AND v_old.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'posted_lines_immutable: the lines of % (%) are permanent and cannot be changed; post a correcting entry instead', v_old.reference, v_old.status
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    SELECT reference, status INTO v_new FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF FOUND AND v_new.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'posted_lines_immutable: a line cannot be moved into % (%); post a correcting entry instead', v_new.reference, v_new.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION journal_entries_posted_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'draft' THEN
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'posted_lines_immutable: % (%) cannot be turned back into a draft; post a correcting entry instead', OLD.reference, OLD.status
        USING ERRCODE = 'P0001';
    END IF;
    -- A void is final: its reversal is live, so un-voiding would count the entry twice.
    IF OLD.status = 'voided' AND (NEW.status IS DISTINCT FROM 'voided' OR NEW.void_reversal_je_id IS DISTINCT FROM OLD.void_reversal_je_id) THEN
      RAISE EXCEPTION 'posted_lines_immutable: % is voided; a void is final (post a new entry instead)', OLD.reference
        USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.community_id, NEW.posting_date, NEW.period_id, NEW.total_debits_cents, NEW.total_credits_cents, NEW.reverses_je_id)
       IS DISTINCT FROM (OLD.community_id, OLD.posting_date, OLD.period_id, OLD.total_debits_cents, OLD.total_credits_cents, OLD.reverses_je_id) THEN
      RAISE EXCEPTION 'posted_lines_immutable: % (%) keeps its community, date, period, amounts and reversal link; post a correcting entry instead', OLD.reference, OLD.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION journal_entry_lines_posted_guard() IS
  'Refuses DELETE, and any UPDATE that changes a line, when the line''s journal entry is not a draft. Posted lines are permanent; correct by a new entry. (mig 529; scar LOPF JE-2026-00169..00172)';
COMMENT ON FUNCTION journal_entries_posted_guard() IS
  'A non-draft journal entry never returns to draft, a void is final, and its community, posting date, period, totals and reverses_je_id never change. Metadata (description, notes, document links, needs_review, classification_reason, prior-period flag), the void flip and the superseded flip / restore are allowed. (mig 529)';

DROP TRIGGER IF EXISTS trg_journal_entry_lines_posted_guard ON journal_entry_lines;
CREATE TRIGGER trg_journal_entry_lines_posted_guard
  BEFORE UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_posted_guard();

DROP TRIGGER IF EXISTS trg_journal_entries_posted_guard ON journal_entries;
CREATE TRIGGER trg_journal_entries_posted_guard
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_posted_guard();

COMMIT;
