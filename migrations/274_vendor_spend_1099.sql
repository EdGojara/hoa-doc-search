-- ============================================================================
-- 274_vendor_spend_1099.sql  (Ed 2026-07-10)
-- ----------------------------------------------------------------------------
-- Vendor annual spend by community + 1099 reporting, from ONE spend picture
-- built out of the two rails we already have (no new silo):
--
--   1. HISTORICAL — invoices paid OUTSIDE the system, uploaded to the Vendor
--      tab for the record only (never for payment; payment goes to Emma). These
--      already land in invoices_received (mig 009). We add paid_date here so the
--      spend/1099 year is CASH-BASIS (when it was paid), per Ed — not the
--      invoice date.
--   2. CURRENT — money actually disbursed through the system. The canonical
--      record is ap_payments (mig 175), written by lib/accounting/record_payment
--      on every check/ACH; payment_date is already the cash-basis date.
--
-- 1099 is per FILER: each association is its own EIN, so the $600 threshold is
-- per (vendor x community x year), not portfolio-wide. The views keep the
-- community dimension. The two rails are parallel intakes (invoices_received is
-- the old vendor-master audit table; ap_payments comes from the Emma AP queue),
-- so they do not double-count by process — the report also shows each rail
-- separately so any overlap is visible, never silently merged.
--
-- The vendors table already carries the 1099 fields (mig 175): is_1099_vendor,
-- w9_on_file, w9_received_date, tax_id. W-9 documents live in vendor_documents
-- (doc_type='w9', mig 009). We add tax_classification (read off the W-9) so the
-- system can SUGGEST is_1099_vendor; the operator still confirms.
-- ============================================================================
BEGIN;

-- Cash-basis paid date on the historical invoice record (nullable; existing
-- rows fall back to invoice_date in the view, flagged as estimated).
ALTER TABLE invoices_received ADD COLUMN IF NOT EXISTS paid_date DATE;
CREATE INDEX IF NOT EXISTS idx_inv_recv_paid_date
  ON invoices_received (community_id, paid_date) WHERE paid_date IS NOT NULL;

-- W-9 tax classification (Individual/Sole prop, LLC, C-Corp, S-Corp, Partnership,
-- Trust). Corporations are generally 1099-exempt; drives the suggested 1099 flag.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tax_classification TEXT;

-- ---------------------------------------------------------------------------
-- v_vendor_payments_all — granular union (one row per payment, both rails).
-- amount normalized to CENTS. invoices_received.total_amount is NUMERIC dollars;
-- ap_payments.amount_cents is already cents.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_vendor_annual_spend CASCADE;
DROP VIEW IF EXISTS v_vendor_payments_all CASCADE;

CREATE VIEW v_vendor_payments_all AS
  SELECT
    ir.vendor_id,
    ir.community_id,
    COALESCE(ir.paid_date, ir.invoice_date)                        AS paid_date,
    (EXTRACT(YEAR FROM COALESCE(ir.paid_date, ir.invoice_date)))::int AS paid_year,
    ROUND(COALESCE(ir.total_amount, 0) * 100)::bigint              AS amount_cents,
    'historical'::text                                            AS source,
    (ir.paid_date IS NULL)                                        AS date_estimated,
    ir.invoice_number                                            AS ref,
    ir.id                                                        AS source_id
  FROM invoices_received ir
  WHERE COALESCE(ir.total_amount, 0) <> 0
    AND COALESCE(ir.paid_date, ir.invoice_date) IS NOT NULL
UNION ALL
  SELECT
    p.vendor_id,
    p.community_id,
    p.payment_date::date                                         AS paid_date,
    (EXTRACT(YEAR FROM p.payment_date))::int                     AS paid_year,
    p.amount_cents,
    'current'::text                                              AS source,
    FALSE                                                        AS date_estimated,
    p.check_number                                              AS ref,
    p.id                                                        AS source_id
  FROM ap_payments p
  WHERE p.status = 'completed';

GRANT SELECT ON v_vendor_payments_all TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- v_vendor_annual_spend — total paid per vendor x community x year, with each
-- rail broken out so overlap is visible. Drives the spend report + 1099 file.
-- ---------------------------------------------------------------------------
CREATE VIEW v_vendor_annual_spend AS
  SELECT
    vendor_id,
    community_id,
    paid_year,
    SUM(amount_cents)                                                        AS total_cents,
    SUM(amount_cents) FILTER (WHERE source = 'historical')                   AS historical_cents,
    SUM(amount_cents) FILTER (WHERE source = 'current')                      AS current_cents,
    COUNT(*)                                                                 AS payment_count,
    bool_or(date_estimated)                                                  AS has_estimated_dates
  FROM v_vendor_payments_all
  GROUP BY vendor_id, community_id, paid_year;

GRANT SELECT ON v_vendor_annual_spend TO authenticated, service_role;

COMMIT;
