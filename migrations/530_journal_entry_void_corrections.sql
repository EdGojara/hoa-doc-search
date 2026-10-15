-- ============================================================================
-- 530_journal_entry_void_corrections.sql  (Ed 2026-10-15)
-- ----------------------------------------------------------------------------
-- An owner void of a posted journal entry is a correction, so it is recorded in
-- the corrections trail (journal_entry_corrections, migration 503) like every
-- other correction: original entry, correcting entry (the reversal), actor,
-- time, reason. Migration 503 allowed only the three AP workflows as a kind;
-- this adds 'void' (Accounting > Journal Entries > Void entry, owner only).
--
-- preview_hash: the server-issued hash of the exact preview the owner confirmed
-- (entry, reversal date, every reversal line, owner). The void route refuses
-- without it, and a void row must carry it.
--
-- journal_entry_void_audit_ready() lets the void route confirm, BEFORE it posts
-- anything, that the trail can take the record. Without this migration the
-- route refuses the void and nothing is posted.
--
-- Why now: the Lakes of Pine Forest repair (void CONV-LPF-20260731-NEUT- and
-- -REPOST-JE-2026-00169..00172) and the duplicate-payment cleanup are done by
-- Ed in the app, one authenticated void at a time. This migration repairs
-- nothing and changes no row.
-- Record ownership: association_record (part of the association's books).
-- ============================================================================
BEGIN;

ALTER TABLE journal_entry_corrections DROP CONSTRAINT IF EXISTS journal_entry_corrections_kind_check;
ALTER TABLE journal_entry_corrections ADD CONSTRAINT journal_entry_corrections_kind_check
  CHECK (kind IN ('ap_recode', 'ap_line_recode', 'ap_hold_prior_periods', 'void'));

ALTER TABLE journal_entry_corrections ADD COLUMN IF NOT EXISTS preview_hash text;
ALTER TABLE journal_entry_corrections DROP CONSTRAINT IF EXISTS journal_entry_corrections_void_preview_check;
ALTER TABLE journal_entry_corrections ADD CONSTRAINT journal_entry_corrections_void_preview_check
  CHECK (kind <> 'void' OR length(btrim(coalesce(preview_hash, ''))) > 0);

CREATE OR REPLACE FUNCTION journal_entry_void_audit_ready() RETURNS boolean
  LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
COMMENT ON FUNCTION journal_entry_void_audit_ready() IS
  'True once journal_entry_corrections accepts kind ''void'' with its preview_hash (mig 530). The owner void route calls it before posting a reversal.';
GRANT EXECUTE ON FUNCTION journal_entry_void_audit_ready() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
