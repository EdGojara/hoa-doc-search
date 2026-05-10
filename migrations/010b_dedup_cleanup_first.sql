-- ============================================================================
-- 010b_dedup_cleanup_first.sql
-- ----------------------------------------------------------------------------
-- migrations/010 failed because the partial unique index on
-- (mgmt_co, vendor_id, invoice_number) couldn't build — there are already
-- 3 duplicate rows for invoice #1025481 sitting in invoices_received from
-- Push 1's first live test. The DB refuses to create the constraint when
-- existing data immediately violates it.
--
-- Right order:
--   1) Identify dups
--   2) Delete the dups (keep the oldest row of each group)
--      The rollup trigger automatically recomputes vendors.total_invoiced_lifetime
--      and vendors.last_invoice_at as each row is deleted.
--   3) THEN add the column / index / unique index / updated trigger
--
-- Safe to run multiple times. Apply this in Supabase SQL editor in place
-- of (or after) 010.
-- ============================================================================

-- ============================================================================
-- 1) Show what's about to be cleaned (informational — read this row count
--    before the DELETE runs in step 2)
-- ============================================================================
-- We can't return result rows in the middle of DDL, but RAISE NOTICE prints
-- to the SQL editor's notice channel.
DO $$
DECLARE
  dup_groups INT;
  dup_rows   INT;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(c) - COUNT(*), 0)
    INTO dup_groups, dup_rows
  FROM (
    SELECT vendor_id, invoice_number, COUNT(*) AS c
    FROM invoices_received
    WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
      AND invoice_number IS NOT NULL
    GROUP BY vendor_id, invoice_number
    HAVING COUNT(*) > 1
  ) sub;
  RAISE NOTICE '[010b] dup groups: %, extra rows to delete: %', dup_groups, dup_rows;
END$$;

-- ============================================================================
-- 2) Delete the dup rows (keep oldest of each group). The rollup trigger
--    on invoices_received will adjust vendors.total_invoiced_lifetime and
--    last_invoice_at automatically.
-- ============================================================================
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY vendor_id, invoice_number ORDER BY created_at) AS rn
  FROM invoices_received
  WHERE management_company_id = '00000000-0000-0000-0000-000000000001'
    AND invoice_number IS NOT NULL
)
DELETE FROM invoices_received ir
USING ranked
WHERE ir.id = ranked.id
  AND ranked.rn > 1;

-- ============================================================================
-- 3) Add file_hash column (idempotent)
-- ============================================================================
ALTER TABLE invoices_received
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_inv_recv_file_hash
  ON invoices_received(management_company_id, file_hash)
  WHERE file_hash IS NOT NULL;

-- ============================================================================
-- 4) NOW the partial unique index will succeed (dups are gone)
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_recv_vendor_invnum
  ON invoices_received(management_company_id, vendor_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- ============================================================================
-- 5) Update rollup trigger so DELETE recomputes last_invoice_at properly
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
-- 6) Reconcile vendor totals to ground truth (paranoid step)
--    The trigger should have kept totals correct, but if any row was inserted
--    while the trigger wasn't installed, this brings vendors back in line
--    with reality.
-- ============================================================================
UPDATE vendors v
SET total_invoiced_lifetime = COALESCE(sub.total_sum, 0),
    last_invoice_at = sub.max_date
FROM (
  SELECT vendor_id,
         SUM(total_amount) AS total_sum,
         MAX(COALESCE(invoice_date::timestamptz, created_at)) AS max_date
  FROM invoices_received
  GROUP BY vendor_id
) sub
WHERE v.id = sub.vendor_id;

-- Vendors with zero invoices need their totals zeroed too:
UPDATE vendors
SET total_invoiced_lifetime = 0,
    last_invoice_at = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM invoices_received ir WHERE ir.vendor_id = vendors.id
);

-- ============================================================================
-- Verify with:
--   SELECT vendor_id, invoice_number, COUNT(*)
--   FROM invoices_received
--   GROUP BY vendor_id, invoice_number
--   HAVING COUNT(*) > 1;
--   -- expect: 0 rows (no dups remain)
--
--   SELECT name, total_invoiced_lifetime, last_invoice_at
--   FROM vendors
--   WHERE total_invoiced_lifetime > 0;
--   -- expect: Highetech rolled up to (count of unique remaining) × $1,750
-- ============================================================================
