-- ============================================================================
-- 010_invoice_dup_guard.sql
-- ----------------------------------------------------------------------------
-- Real AP workflow gotcha discovered in Push 1 testing: same vendor invoice
-- got uploaded 3x by accident (invoice #1025481 inserted 3 times = lifetime
-- $5,250 of phantom spend). Exactly the leakage the audit substrate is
-- supposed to catch — and it shouldn't be allowed in the first place.
--
-- This migration adds two layers of defense + cleans up a trigger bug.
--
--   1) file_hash column on invoices_received
--      - Pre-parse cheap dedup. If you upload the literal same PDF bytes
--        twice, we 409 before paying for a Claude call.
--   2) Partial unique index on (mgmt_co, vendor_id, invoice_number)
--      - Belt + suspenders. Database-level guarantee that you can't have
--        the same vendor invoice number twice. Partial because invoice_number
--        can be null (some bills don't carry a number); we use a softer
--        date+amount heuristic in code for that case.
--   3) Updated trusted_vendor_invoice_rollup() so DELETE recomputes
--      last_invoice_at from MAX(remaining), instead of leaving it pointing
--      at a deleted row.
--
-- Apply AFTER 009b. Idempotent.
-- ============================================================================

-- ============================================================================
-- 1) file_hash column for byte-level dedup
-- ============================================================================
ALTER TABLE invoices_received
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_inv_recv_file_hash
  ON invoices_received(management_company_id, file_hash)
  WHERE file_hash IS NOT NULL;

-- ============================================================================
-- 2) Partial unique index on (mgmt_co, vendor_id, invoice_number)
--    The hard guarantee: a vendor cannot have the same invoice number twice
--    within a management company. NULL invoice numbers are allowed (different
--    rows even when they collide on other fields), since some bills genuinely
--    don't carry a number — code-level softer dedup handles that.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_recv_vendor_invnum
  ON invoices_received(management_company_id, vendor_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- ============================================================================
-- 3) Update rollup trigger so DELETE properly updates last_invoice_at.
--    Original trigger only adjusted total on DELETE; last_invoice_at would
--    keep pointing at a deleted row. Now we recompute from MAX(remaining).
-- ============================================================================
CREATE OR REPLACE FUNCTION trusted_vendor_invoice_rollup()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE vendors
    SET total_invoiced_lifetime = COALESCE(total_invoiced_lifetime, 0) + COALESCE(NEW.total_amount, 0),
        last_invoice_at = GREATEST(COALESCE(last_invoice_at, '1900-01-01'::timestamptz),
                                   COALESCE(NEW.invoice_date::timestamptz, NEW.created_at))
    WHERE id = NEW.vendor_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE vendors v
    SET total_invoiced_lifetime = GREATEST(0, COALESCE(v.total_invoiced_lifetime, 0) - COALESCE(OLD.total_amount, 0)),
        last_invoice_at = (
          SELECT MAX(COALESCE(ir.invoice_date::timestamptz, ir.created_at))
          FROM invoices_received ir
          WHERE ir.vendor_id = OLD.vendor_id
            AND ir.id <> OLD.id
        )
    WHERE v.id = OLD.vendor_id;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF OLD.total_amount IS DISTINCT FROM NEW.total_amount THEN
      UPDATE vendors
      SET total_invoiced_lifetime = COALESCE(total_invoiced_lifetime, 0) + COALESCE(NEW.total_amount, 0) - COALESCE(OLD.total_amount, 0)
      WHERE id = NEW.vendor_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 4) One-time cleanup helper (commented out — review before running).
--    The existing 4 Highetech rows include 3 dups of #1025481. After this
--    migration is in place, the unique index would block future dups, but
--    historic ones are still there. Run the SELECT first to see what you've
--    got, then DELETE the dups, then the trigger will recompute totals.
-- ----------------------------------------------------------------------------
--   SELECT vendor_id, invoice_number, COUNT(*)
--   FROM invoices_received
--   WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--   GROUP BY vendor_id, invoice_number
--   HAVING COUNT(*) > 1;
--
--   -- Pick which row to keep (the oldest one), delete the rest:
--   DELETE FROM invoices_received
--   WHERE id IN (
--     SELECT id FROM (
--       SELECT id,
--              ROW_NUMBER() OVER (PARTITION BY vendor_id, invoice_number ORDER BY created_at) AS rn
--       FROM invoices_received
--       WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
--         AND invoice_number IS NOT NULL
--     ) ranked
--     WHERE rn > 1
--   );
-- ============================================================================
