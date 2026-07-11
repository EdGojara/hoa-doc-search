-- ============================================================================
-- 280_gl_entry_edit_and_docs.sql  (Ed 2026-07-11)
-- ----------------------------------------------------------------------------
-- Phase 1 of the "AI-CPA ledger": let staff EDIT trustEd's auto-posted GL
-- entries in place during month-end review (while the period is OPEN), instead
-- of hand-crafting an adjusting journal entry — WITHOUT losing the audit trail.
--
--   * journal_entries gains a supporting-document link + a plain-language
--     "why this account" classification reason + a needs_review flag + last-
--     edited stamps.
--   * journal_entry_edits is an append-only change log: every in-place edit
--     writes a before/after snapshot (who, when, why). The GL stays auditable
--     even though the entry itself changed.
--
-- Record ownership: journal_entries = association_record (the HOA's books);
-- journal_entry_edits = association_record (part of the audit trail).
-- Edits are only permitted while the entry's period is OPEN (enforced in
-- lib/accounting/posting.js editJournalEntry); closed periods are immutable and
-- corrections there are a new JE.
-- ============================================================================
BEGIN;

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES library_documents(id) ON DELETE SET NULL;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS source_document_path TEXT;         -- storage path when the doc isn't a library_documents row (e.g. a scan)
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS classification_reason TEXT;        -- "why this account" — the CPA rationale, human- or AI-written
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;  -- off-budget / low-confidence / unusual account
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS last_edited_by_user_id UUID;

CREATE INDEX IF NOT EXISTS idx_journal_entries_needs_review
  ON journal_entries (community_id, period_id) WHERE needs_review;

CREATE TABLE IF NOT EXISTS journal_entry_edits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id     UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  edited_by_user_id    UUID,
  edited_by_name       TEXT,
  reason               TEXT,
  changes              JSONB NOT NULL,     -- { field: {before, after}, lines: {before:[...], after:[...]} }
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_edits_je ON journal_entry_edits (journal_entry_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON journal_entry_edits TO service_role;
GRANT SELECT                          ON journal_entry_edits TO authenticated;

COMMIT;
