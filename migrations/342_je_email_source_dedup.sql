-- ===========================================================================
-- 342_je_email_source_dedup.sql
-- ---------------------------------------------------------------------------
-- Make it STRUCTURALLY impossible to record the same email-sourced bill to the
-- GL twice. recordVendorPaymentToGL already guards with a check-then-act lookup
-- on (community_id, source_reference), but that is not atomic: two concurrent
-- posts (a double-click on "Post to GL", or two routing paths firing at once)
-- both pass the SELECT and both INSERT, double-counting the expense. This is the
-- exact "ON CONFLICT / dedup without a unique constraint" scar class in
-- CLAUDE.md — the fix is a DB constraint that fails the second insert, not more
-- application prose.
--
-- Scope: only email-sourced entries (source_reference LIKE 'email:%'), which is
-- the entire email -> GL path (Emma's "Record to GL" button + the auto-record at
-- ingest, both source_module='manual', source_reference='email:<graphId>').
-- NOT scoped broadly, so Vantaca replay / bank-rec / assessment postings that
-- legitimately share a source_reference shape are untouched.
--
-- Void-safe: voidJournalEntry posts its reversal with source_module='reversal'
-- and source_reference=<original JE uuid> (NOT an 'email:%' value), so a void
-- never collides with this index. The voided original keeps its 'email:%' ref,
-- which is correct — re-recording from the same email stays blocked (same
-- behavior the app-layer guard already enforced).
--
-- Verified before shipping: 18 live email-sourced JEs, 0 duplicate
-- (community_id, source_reference) groups — the index builds clean.
--
-- Record ownership unchanged (journal_entries = association_record).
-- Grants unchanged: this only adds an index.
-- ===========================================================================
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_je_email_source_ref
  ON journal_entries (community_id, source_reference)
  WHERE source_reference LIKE 'email:%';

COMMIT;
