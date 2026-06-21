-- ============================================================================
-- 242_bank_rec_clearing.sql
-- ----------------------------------------------------------------------------
-- Traditional bank-reconciliation worksheet state. The rec is a clearing
-- register: every GL cash line and every bank line is shown in two columns
-- (GL | Bank); the system pre-populates the matches, and the operator confirms
-- (Accept) or disputes (Reopen) each. Cleared items stay visible but checked;
-- uncleared GL items are the open items (deposits in transit / outstanding
-- checks) that carry forward to the next month until they clear.
--
-- We persist only the operator's DECISIONS as overrides keyed to the underlying
-- row (a journal_entry_lines id or a bank_statement_transactions id). The
-- worksheet itself is computed live from the GL + bank + these overrides, so
-- nothing goes stale and carry-forward is automatic from the dates.
--
--   status  — 'cleared' (matched/confirmed) or 'open' (carry forward)
--   match_group — ties a bank line to the GL line(s) it clears (one bank
--                 payout = many GL owner payments), so a group clears together
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bank_rec_clearing (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id    uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  side            text NOT NULL CHECK (side IN ('gl', 'bank')),
  source_id       text NOT NULL,            -- je_line id or bank_txn id
  status          text NOT NULL CHECK (status IN ('cleared', 'open')),
  match_group     text,                     -- groups a bank line with its GL lines
  note            text,
  updated_by      text,
  updated_at      timestamptz DEFAULT now(),
  UNIQUE (bank_account_id, side, source_id)
);
CREATE INDEX IF NOT EXISTS idx_bank_rec_clearing_lookup
  ON bank_rec_clearing (community_id, bank_account_id, side);

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_rec_clearing TO service_role;

COMMIT;
