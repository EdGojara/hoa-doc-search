-- ============================================================================
-- 364_vendor_deposits.sql
-- ----------------------------------------------------------------------------
-- Prepaid-deposit SUBLEDGER. When a vendor bills a deposit (50% up front on a
-- capital project), we book it to Prepaid Vendor Deposits (asset) — but the GL
-- balance alone doesn't say WHICH project it's for or that a completion invoice
-- is still coming. This subledger records the vendor + deposit invoice + amount
-- + project so that when the SAME vendor's completion invoice arrives, Emma
-- knows to apply the deposit (relieve the prepaid into the project) instead of
-- double-paying. (Ed 2026-08-12: AAA Awning #83793 — record it so the balance
-- invoice nets the deposit.)
--
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vendor_deposits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id           UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  vendor_id              UUID REFERENCES vendors(id),
  deposit_invoice_id     UUID REFERENCES ap_invoices(id) ON DELETE SET NULL,
  gl_account_id          UUID,                                   -- the prepaid deposits account (e.g. 1430)
  project_description    TEXT,                                   -- what the deposit is for (service address / scope)
  deposit_amount_cents   BIGINT NOT NULL DEFAULT 0,
  remaining_balance_cents BIGINT,                                -- expected completion amount, if the bill stated it
  status                 TEXT NOT NULL DEFAULT 'outstanding'
                           CHECK (status IN ('outstanding', 'applied', 'canceled')),
  applied_invoice_id     UUID REFERENCES ap_invoices(id) ON DELETE SET NULL,   -- the completion invoice it was applied to
  applied_at             TIMESTAMPTZ,
  notes                  TEXT,
  record_ownership       TEXT NOT NULL DEFAULT 'association_record',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_deposits_open
  ON vendor_deposits (community_id, vendor_id) WHERE status = 'outstanding';

DROP TRIGGER IF EXISTS trg_vendor_deposits_updated_at ON vendor_deposits;
CREATE TRIGGER trg_vendor_deposits_updated_at
  BEFORE UPDATE ON vendor_deposits
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_deposits TO service_role;
GRANT SELECT                          ON vendor_deposits TO authenticated;

COMMIT;
