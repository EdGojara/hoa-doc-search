-- ============================================================================
-- 236_homeowner_ledger.sql
-- ----------------------------------------------------------------------------
-- Per-homeowner transaction ledger — the statement-ready history (prior balance
-- -> charges -> payments -> running balance) that a homeowner account/statement
-- shows. Separate from the live AR subledger (ar_charges = current open balances
-- for aging + GL tie-out); this is the chronological transaction log a statement
-- is rendered from. Loaded from Vantaca's Transaction History export for the
-- migrated period; trustEd appends its own entries going forward.
--
-- Record ownership: association_record (the HOA's books / what the owner is sent).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS homeowner_ledger_entries (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  property_id              UUID NOT NULL REFERENCES properties(id)  ON DELETE CASCADE,
  entry_date               DATE NOT NULL,
  description              TEXT,
  charge_cents             BIGINT NOT NULL DEFAULT 0,             -- increases the owner's balance
  payment_cents            BIGINT NOT NULL DEFAULT 0,             -- decreases the owner's balance
  running_balance_cents    BIGINT,                                -- balance after this entry
  entry_type               TEXT NOT NULL DEFAULT 'charge'
                             CHECK (entry_type IN ('prior_balance', 'charge', 'payment', 'adjustment', 'void')),
  source                   TEXT NOT NULL DEFAULT 'vantaca_history',
  sort_seq                 INTEGER NOT NULL DEFAULT 0,            -- order within a day
  record_ownership         TEXT NOT NULL DEFAULT 'association_record',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hoa_ledger_property ON homeowner_ledger_entries (community_id, property_id, entry_date, sort_seq);

DROP TRIGGER IF EXISTS trg_hoa_ledger_updated ON homeowner_ledger_entries;
CREATE TRIGGER trg_hoa_ledger_updated BEFORE UPDATE ON homeowner_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON homeowner_ledger_entries TO service_role;
GRANT SELECT                          ON homeowner_ledger_entries TO authenticated;

COMMIT;
