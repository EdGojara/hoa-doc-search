-- ============================================================================
-- 574_iremit_account_crosswalk.sql  (Ed 2026-11-23)
-- ----------------------------------------------------------------------------
-- Record ownership: association_record (which lot a bank payment account belongs to).
--
-- NewFirst's lockbox and e-payment files carry the account number the bank holds,
-- usually a number from before Vantaca (C3). A person confirms once, with evidence,
-- which lot it is; the reader (lib/ar/iremit_receipts) uses CONFIRMED rows only.
--   proposed   suggested from a source (e.g. the C3 lot list); never used to match
--   confirmed  a person confirmed it (confirmed_by + confirmed_at required)
--   retired    no longer valid; kept, never deleted (a lot sold, a number reused)
-- One live (proposed or confirmed) row per association code and bank account.
--
-- Additive only: one new, empty table. Nothing posts or changes because of it.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS bank_remittance_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  bank                TEXT NOT NULL DEFAULT 'newfirst' CHECK (bank IN ('newfirst')),
  association_code    TEXT NOT NULL CHECK (association_code ~ '^[0-9]{3,6}$'),
  remittance_account  TEXT NOT NULL CHECK (remittance_account ~ '^[0-9A-Za-z]{1,16}$'),
  vantaca_account_id  TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'retired')),
  evidence            TEXT NOT NULL CHECK (length(btrim(evidence)) >= 10),
  proposed_by         TEXT NOT NULL,
  confirmed_by        TEXT,
  confirmed_at        TIMESTAMPTZ,
  retired_by          TEXT,
  retired_at          TIMESTAMPTZ,
  retired_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_remittance_accounts_confirmed CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CONSTRAINT bank_remittance_accounts_retired CHECK (status <> 'retired' OR (retired_by IS NOT NULL AND retired_at IS NOT NULL AND retired_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_remittance_accounts_live
  ON bank_remittance_accounts (bank, association_code, remittance_account) WHERE status <> 'retired';
CREATE INDEX IF NOT EXISTS idx_bank_remittance_accounts_community ON bank_remittance_accounts (community_id);
CREATE INDEX IF NOT EXISTS idx_bank_remittance_accounts_property ON bank_remittance_accounts (property_id);

CREATE OR REPLACE TRIGGER trg_bank_remittance_accounts_updated BEFORE UPDATE ON bank_remittance_accounts
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE bank_remittance_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bank_remittance_accounts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON bank_remittance_accounts TO service_role;

COMMENT ON TABLE bank_remittance_accounts IS 'association_record. Bank payment-file account number -> lot. Only confirmed rows are used to match a payment; rows are retired, never deleted.';

COMMIT;
