-- ============================================================================
-- 234_former_owner_balances.sql
-- ----------------------------------------------------------------------------
-- Residual balances belonging to FORMER owners — people who sold/left but whose
-- account still carries money. Two flavors:
--   - HOA owes THEM (a refund: they overpaid before leaving) -> negative balance
--   - THEY owe the HOA (uncollected before they left)        -> positive balance
--
-- These can't live in ar_charges / ar_payments (those require a current
-- property_id), and they're a distinct liability/exposure from current-owner
-- AR. This table is their home, and it surfaces in the AR aging so a former
-- owner's stranded balance can't hide (e.g. Quail Ridge: $707.19 owed to Joe
-- Lukose, sitting in GL 2400 for who knows how long).
--
-- Record ownership: association_record (the HOA's collection/refund records).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS former_owner_balances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  vantaca_account_id  TEXT,
  owner_name          TEXT,
  property_address    TEXT,                       -- the lot they were on (may be a placeholder)
  balance_cents       BIGINT NOT NULL,            -- signed: + they owe HOA, - HOA owes them
  kind                TEXT NOT NULL DEFAULT 'refund_owed'
                        CHECK (kind IN ('refund_owed', 'uncollected_balance', 'other')),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'refunded', 'escheated', 'written_off', 'transferred')),
  gl_account_number   TEXT,                        -- where it currently sits in the GL (e.g. '2400')
  notes               TEXT,
  record_ownership    TEXT NOT NULL DEFAULT 'association_record',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, vantaca_account_id)
);

CREATE INDEX IF NOT EXISTS idx_former_owner_balances_community
  ON former_owner_balances (community_id) WHERE status = 'open';

DROP TRIGGER IF EXISTS trg_former_owner_balances_updated ON former_owner_balances;
CREATE TRIGGER trg_former_owner_balances_updated BEFORE UPDATE ON former_owner_balances
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON former_owner_balances TO service_role;
GRANT SELECT                          ON former_owner_balances TO authenticated;

COMMIT;
