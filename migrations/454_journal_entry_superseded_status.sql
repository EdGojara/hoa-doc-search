-- ============================================================================
-- 454_journal_entry_superseded_status.sql   -- DRAFT, NOT APPLIED
-- ----------------------------------------------------------------------------
-- Lets a conversion retire PRIOR_SOURCE_IMPORT journal entries (e.g. LOPF's
-- Vantaca-derived daily entries through 7/17 and JE-2026-OPEN) from
-- authoritative balances WITHOUT deleting them:
--
--   status 'superseded'  never counts (lib/accounting/je_status.js countsInGl
--                        and migration 453's v_trial_balance count only
--                        'posted' and 'voided'-with-reversal)
--   superseded_at / superseded_reason / superseded_by_conversion
--                        audit trail; restoring = set status back to 'posted'
--
-- The retirement itself is NOT in this migration. It is a separately reviewed,
-- reversible operation (scripts/conversion/lopf/retire_prior_source_imports.sql)
-- run in the same transaction as the conversion posting.
-- Additive only: no existing row changes.
-- ============================================================================
BEGIN;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'journal_entries'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%draft%posted%voided%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE journal_entries DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_status_check
  CHECK (status IN ('draft', 'posted', 'voided', 'superseded'));

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS superseded_reason TEXT;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS superseded_by_conversion TEXT;

ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_superseded_audit
  CHECK (status <> 'superseded' OR (superseded_at IS NOT NULL AND superseded_reason IS NOT NULL));

COMMIT;
