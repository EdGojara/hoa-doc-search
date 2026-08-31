-- ============================================================================
-- 401_vendor_master_repoint_ap_rail.sql  (Ed 2026-08-31)
-- ----------------------------------------------------------------------------
-- Vendor Master list showed Lifetime $0.00 / # Inv 0 / Last invoice — for every
-- vendor, while the Vendor 360 DETAIL page showed the real numbers.
--
-- Root cause: single-source-of-truth drift. v_vendors_with_status (migration
-- 009/009b) still sources those three columns from the LEGACY invoice rail:
--   * invoice_count            -> COUNT(invoices_received)      (table now empty)
--   * total_invoiced_lifetime  -> vendors.total_invoiced_lifetime, a column kept
--                                 up to date by a trigger on invoices_received
--   * last_invoice_at          -> same dead trigger
-- Migration 334 moved AP onto ap_invoices / ap_payments, so invoices_received no
-- longer receives writes, the trigger never fires, and all three read as
-- zero/empty. The detail page (api/vendors.js GET /:id) already computes spend
-- live from ap_payments, which is why clicking a vendor shows the truth.
--
-- Fix: repoint the view's three aggregates to the canonical rail, matching the
-- detail page — Lifetime $ = total PAID (ap_payments), # Inv = count of
-- ap_invoices, Last invoice = latest ap_invoices.invoice_date. Voided invoices
-- are excluded from the count/last-date.
--
-- DROP + CREATE (not CREATE OR REPLACE): last_invoice_at changes from a stored
-- timestamptz column to a computed date-cast, a type change CREATE OR REPLACE
-- rejects. Re-GRANT after DROP (a dropped view loses its grants — CLAUDE.md scar).
-- Output column names/order are unchanged, so the endpoint + frontend are
-- untouched. Read-only view; no data migration.
-- ============================================================================
BEGIN;

DROP VIEW IF EXISTS v_vendors_with_status;

CREATE VIEW v_vendors_with_status AS
SELECT
  v.id,
  v.management_company_id,
  v.name,
  v.dba,
  v.category,
  v.status,
  v.w9_on_file,
  -- Latest invoice date from the canonical AP rail (cast to timestamptz to keep
  -- the column's original type). Excludes voided bills.
  (
    SELECT MAX(i.invoice_date)::timestamptz
    FROM ap_invoices i
    WHERE i.vendor_id = v.id AND i.status <> 'voided'
  ) AS last_invoice_at,
  -- Lifetime $ = total actually PAID to the vendor (ap_payments), in dollars —
  -- the same basis the Vendor 360 detail page uses. NUMERIC(14,2)-compatible.
  (
    COALESCE((SELECT SUM(p.amount_cents) FROM ap_payments p WHERE p.vendor_id = v.id), 0)
  )::numeric / 100.0 AS total_invoiced_lifetime,
  v.first_seen_at,
  -- # Inv = count of AP invoices for the vendor (excluding voided).
  (
    SELECT COUNT(*)
    FROM ap_invoices i
    WHERE i.vendor_id = v.id AND i.status <> 'voided'
  ) AS invoice_count,
  (
    SELECT MIN(d.expires_at) FROM vendor_documents d
    WHERE d.vendor_id = v.id AND d.doc_type = 'coi' AND d.expires_at IS NOT NULL
  ) AS earliest_coi_expiry,
  (
    SELECT MIN(d.expires_at) FROM vendor_documents d
    WHERE d.vendor_id = v.id AND d.doc_type = 'contract' AND d.expires_at IS NOT NULL
  ) AS earliest_contract_expiry
FROM vendors v;

GRANT SELECT ON v_vendors_with_status TO service_role, authenticated;

COMMIT;

-- Verify:
--   SELECT name, total_invoiced_lifetime, invoice_count, last_invoice_at
--   FROM v_vendors_with_status
--   WHERE total_invoiced_lifetime > 0
--   ORDER BY total_invoiced_lifetime DESC LIMIT 10;
