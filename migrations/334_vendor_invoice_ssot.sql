-- 334_vendor_invoice_ssot.sql
-- ---------------------------------------------------------------------------
-- Vendor invoices — one source of truth (Ed 2026-07-25).
--
-- A vendor bill lived in TWO unrelated tables with two extractors and two
-- duplicate-detectors: `ap_invoices` (the live AP workflow — cents, GL linkage,
-- approve→pay, feeds ap_payments) and `invoices_received` (the vendor-page
-- "historical invoice" upload — dollars, its own dedup, feeds the "historical"
-- rail of the 1099 spend view). Two dedup engines that can't see each other are
-- a double-pay vector, and the same bill could land in either table.
--
-- Canonical table is `ap_invoices` (+ `ap_payments` for cash-basis 1099). This
-- migration is the DATA + VIEW half of the merge:
--   (1) relocate the historical invoices_received rows into ap_payments (a
--       standalone completed vendor payment — ap_payments needs no invoice FK),
--       so 1099 counts them from the ONE canonical payments rail; and
--   (2) rebuild the spend/1099 view to read ONLY ap_payments — dropping the
--       redundant invoices_received rail.
--
-- ACCOUNTING TREATMENT (Ed is CPA — flagged for veto): a historical
-- "received" invoice is recorded as a COMPLETED vendor payment dated at its
-- invoice_date (paid_date was null on all current rows, so the 1099 YEAR is
-- unchanged — the old view already used COALESCE(paid_date, invoice_date)).
-- 1099 is cash-basis, so the canonical home for "we paid vendor X $Y in year Z"
-- is ap_payments. Per-vendor/year totals are PRESERVED exactly.
--
-- SAFETY GATE: v_vendor_annual_spend grand total must remain $25,448.86 and
-- every per-vendor/year total unchanged. Verified by scripts post-apply.
--
-- invoices_received is LEFT IN PLACE (deprecated, not dropped) so the raw
-- historical records remain for audit; nothing reads it for 1099 after this.
-- Record ownership: workpaper (internal AP/spend records).
-- ---------------------------------------------------------------------------
BEGIN;

-- (1) Relocate historical invoices_received rows into ap_payments. Idempotent:
-- re-running won't duplicate — guarded on a per-source marker in notes.
INSERT INTO ap_payments (
  community_id, vendor_id, payment_date, amount_cents,
  payment_method, status, notes, created_at
)
SELECT
  ir.community_id,
  ir.vendor_id,
  COALESCE(ir.paid_date, ir.invoice_date)                       AS payment_date,
  ROUND(COALESCE(ir.total_amount, 0) * 100)::bigint             AS amount_cents,
  'other'::text                                                 AS payment_method,
  'completed'::text                                             AS status,
  'hist-import:invoices_received:' || ir.id::text
    || CASE WHEN ir.paid_date IS NULL THEN ' (date estimated from invoice_date)' ELSE '' END
    || CASE WHEN ir.invoice_number IS NOT NULL THEN ' inv#' || ir.invoice_number ELSE '' END
                                                                AS notes,
  now()                                                         AS created_at
FROM invoices_received ir
WHERE ir.community_id IS NOT NULL
  AND ir.vendor_id IS NOT NULL
  AND COALESCE(ir.total_amount, 0) > 0
  AND COALESCE(ir.paid_date, ir.invoice_date) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ap_payments p
    WHERE p.notes = 'hist-import:invoices_received:' || ir.id::text
       OR p.notes LIKE 'hist-import:invoices_received:' || ir.id::text || ' %'
  );

-- (2) Rebuild the spend/1099 view onto the SINGLE canonical rail (ap_payments).
-- DROP+CREATE (a column set changes) — re-issue GRANTs after (scar: DROP VIEW
-- loses grants).
DROP VIEW IF EXISTS v_vendor_annual_spend CASCADE;
DROP VIEW IF EXISTS v_vendor_payments_all CASCADE;

CREATE VIEW v_vendor_payments_all AS
  SELECT
    p.vendor_id,
    p.community_id,
    p.payment_date::date                            AS paid_date,
    (EXTRACT(YEAR FROM p.payment_date))::int        AS paid_year,
    p.amount_cents,
    p.check_number                                  AS ref,
    (p.notes LIKE 'hist-import:%')                   AS is_historical,
    (p.notes LIKE '%date estimated%')               AS date_estimated,
    p.id                                            AS source_id
  FROM ap_payments p
  WHERE p.status = 'completed';

GRANT SELECT ON v_vendor_payments_all TO authenticated, service_role;

CREATE VIEW v_vendor_annual_spend AS
  SELECT
    vendor_id,
    community_id,
    paid_year,
    SUM(amount_cents)                                          AS total_cents,
    SUM(amount_cents) FILTER (WHERE is_historical)             AS historical_cents,
    SUM(amount_cents) FILTER (WHERE NOT is_historical)         AS current_cents,
    COUNT(*)                                                   AS payment_count,
    bool_or(date_estimated)                                    AS has_estimated_dates
  FROM v_vendor_payments_all
  GROUP BY vendor_id, community_id, paid_year;

GRANT SELECT ON v_vendor_annual_spend TO authenticated, service_role;

COMMIT;
