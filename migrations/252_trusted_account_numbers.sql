-- ============================================================================
-- 252_trusted_account_numbers.sql
-- ----------------------------------------------------------------------------
-- trustEd-native account numbers (Ed 2026-06-30). The homeowner AR subledger
-- (homeowner_transactions) was built entirely around Vantaca account numbers
-- (vantaca_account_id NOT NULL) — which blocks AR for NATIVE communities that
-- never came from Vantaca (August Meadows is the first). This adds a discreet
-- trustEd account number as the going-forward AR key, with the Vantaca number
-- kept only as an internal cross-reference.
--
-- FORMAT (confidentiality by design): 10 digits = [4-digit community code]
-- + [6-digit random]. The random suffix means an account number CANNOT be
-- reverse-engineered to a property/owner without the internal mapping — safe
-- to print on collections letters / third-party disclosures. The 4-digit
-- prefix is VISIBLE and identifies the community (Ed's requirement). 10 digits
-- is permanently outside Vantaca's 7–8 digit range (max 10,516,948), so the
-- two number spaces can never collide.
--
-- PHASED ROLLOUT (this migration is additive + behavior-neutral):
--   * Phase 1 (light): number August Meadows' 42 native lots + post its
--     builder assessments keyed on trusted_account_number. Existing Vantaca
--     communities are untouched (their AR still keys on vantaca_account_id).
--   * Phase 2 (when the DB is healthy, off Nano): backfill a trustEd number
--     onto all ~3,748 existing properties + stamp it on all ~21,975
--     homeowner_transactions rows, then repoint the AR code to key on the
--     trustEd number everywhere (Vantaca becomes cross-reference only).
--
-- Additive columns on existing tables the service role already owns — no new
-- grants needed.
-- ============================================================================

BEGIN;

-- 4-digit visible community code (the account-number prefix).
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS account_code TEXT;

-- The trustEd account number on the property (the canonical mapping).
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS trusted_account_number TEXT;

-- Unique across the system (an account number identifies exactly one property).
CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_trusted_account_number
  ON properties (trusted_account_number) WHERE trusted_account_number IS NOT NULL;

-- Carry the trustEd number onto every AR transaction, and allow native
-- (non-Vantaca) AR by dropping the NOT NULL on the legacy Vantaca key.
ALTER TABLE homeowner_transactions
  ADD COLUMN IF NOT EXISTS trusted_account_number TEXT;

ALTER TABLE homeowner_transactions
  ALTER COLUMN vantaca_account_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ht_trusted_account_number
  ON homeowner_transactions (trusted_account_number) WHERE trusted_account_number IS NOT NULL;

COMMIT;
