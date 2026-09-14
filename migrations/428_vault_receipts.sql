-- ============================================================================
-- 428_vault_receipts.sql  (Ed 2026-09-14)
-- ----------------------------------------------------------------------------
-- Receipt capture for the Owner Vault (Bedrock's own books + Ed's entities).
-- Ed photographs a receipt on his phone; Claude extracts vendor/date/total/tax;
-- it's stored as SUPPORT and reconciled against the credit-card charge
-- (vault_transactions). This is the documentation layer behind the card bills
-- as we rebuild Bedrock's GL and financial statements.
--
-- Owner-private (WORKPAPER — Bedrock/Ed's own records, never an HOA record).
-- service_role ONLY, like every vault table (deliberately no `authenticated`).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vault_receipts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id              uuid NOT NULL REFERENCES vault_entities(id) ON DELETE CASCADE,
  bank_account_id        uuid REFERENCES vault_bank_accounts(id) ON DELETE SET NULL,   -- which card, if known
  storage_path           text NOT NULL,        -- receipt image in the private 'documents' bucket
  content_type           text,
  vendor_name            text,
  receipt_date           date,
  total_cents            bigint,               -- receipt total (positive)
  tax_cents              bigint,
  currency               text NOT NULL DEFAULT 'USD',
  category_account_id    uuid REFERENCES vault_accounts(id) ON DELETE SET NULL,        -- GL category
  card_last4             text,
  notes                  text,
  matched_transaction_id uuid REFERENCES vault_transactions(id) ON DELETE SET NULL,    -- the card charge it supports
  status                 text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','reviewed')),
  raw_extracted          jsonb,                -- model output before post-processing (debug)
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_receipts_entity_status ON vault_receipts (entity_id, status);
CREATE INDEX IF NOT EXISTS idx_vault_receipts_matched      ON vault_receipts (matched_transaction_id);

DROP TRIGGER IF EXISTS trg_vault_receipts_updated ON vault_receipts;
CREATE TRIGGER trg_vault_receipts_updated BEFORE UPDATE ON vault_receipts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON vault_receipts TO service_role;

COMMIT;
