-- 329_vendor_mud_convenience_fee.sql
-- ---------------------------------------------------------------------------
-- Per-vendor convenience fee. MUD (water district) invoices carry a flat $1
-- convenience fee on every bill, for every community — Martha has been asking
-- Emma to "add $1 to each invoice" by hand in the email body, which Emma never
-- acted on (the body is only an ACH hint, never an amount). This makes the fee
-- a property of the VENDOR: flag a MUD vendor once, and Emma auto-adds the fee
-- line on every invoice from that vendor so the recorded total matches what the
-- bank auto-drafts. (Ed 2026-07-23.)
--
-- `is_mud`               — the operator-set flag ("this vendor is a MUD").
-- `convenience_fee_cents`— the amount added per invoice (0 = none). Kept as its
--                          own column so the fee isn't hardcoded to $1 and a
--                          future non-MUD convenience fee can reuse the same
--                          mechanic.
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS is_mud boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS convenience_fee_cents integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN vendors.is_mud IS 'Operator flag: vendor is a MUD / water district. Drives the per-invoice convenience fee.';
COMMENT ON COLUMN vendors.convenience_fee_cents IS 'Flat fee auto-added as a line to every invoice from this vendor (0 = none). MUD vendors default to 100 ($1).';

COMMIT;
