-- ============================================================================
-- 290_vendor_community_accounts.sql  (Ed 2026-07-12)
-- ----------------------------------------------------------------------------
-- The learning map that lets the system record vendor bills / payments on its
-- own. Each row says: "this vendor (and/or this service account number, and/or
-- this service address) belongs to THIS community and codes to THIS GL account."
--
-- It is TAUGHT, not seeded: every time Ed records a vendor item to the GL or
-- files it to Payables and picks a community + account, we upsert the mapping
-- here. The next bill with the same account number resolves itself — community,
-- GL account, all of it — and can post automatically (flagged for review).
-- This is the single-teacher / encode-Ed loop applied to accounting: code the
-- exception once, the system executes it forever after.
--
-- Record ownership: workpaper (Bedrock's operating knowledge).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vendor_community_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             UUID,                         -- vendors.id when known (no hard FK: emails often name a vendor we haven't rowed yet)
  vendor_name_norm      TEXT,                         -- normalized vendor name, fallback match key
  community_id          UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  account_number        TEXT,                         -- the service/account number (strongest match key)
  service_address       TEXT,                         -- alternative match key
  default_gl_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
  times_recorded        INTEGER NOT NULL DEFAULT 0,
  last_recorded_at      TIMESTAMPTZ,
  taught_by_user_id     UUID,
  taught_by_name        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Account number is the primary key of a service line — unique across the book.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vca_account
  ON vendor_community_accounts (lower(account_number))
  WHERE account_number IS NOT NULL AND account_number <> '';
-- One vendor -> community row when there's no account number to key on.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vca_vendor_comm
  ON vendor_community_accounts (coalesce(vendor_id::text, vendor_name_norm), community_id)
  WHERE (account_number IS NULL OR account_number = '');
CREATE INDEX IF NOT EXISTS idx_vca_vendor ON vendor_community_accounts (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vca_community ON vendor_community_accounts (community_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_community_accounts TO service_role;
GRANT SELECT                          ON vendor_community_accounts TO authenticated;

COMMIT;
