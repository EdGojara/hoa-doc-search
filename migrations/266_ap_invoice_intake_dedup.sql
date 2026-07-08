-- ============================================================================
-- 266_ap_invoice_intake_dedup.sql  (Ed 2026-07-08)
-- ----------------------------------------------------------------------------
-- Emma (AP) intake provenance + duplicate defense for ap_invoices.
--
-- The risk Ed named: the SAME invoice arrives by email (vendor -> emma@) AND as
-- a physical scan (Mail Scan). Both must funnel through one intake and be
-- deduped. The subledger already has UNIQUE (community, vendor, invoice#) — but
-- that has a hole: a NULL/garbled invoice number slips right past it, and Postgres
-- treats NULLs as distinct. So we add:
--   - file_sha256            : identical file re-uploaded -> certain duplicate
--   - dedup_status           : unique | suspected_duplicate | confirmed_duplicate
--   - duplicate_of_invoice_id: which existing payable this one matches
--   - intake_method / _ref   : which channel it came in on (audit)
--   - source_storage_path    : the stored PDF (so the queue can show it)
-- and index (vendor, total, invoice_date) so the fuzzy check (same vendor + same
-- amount + same/near date) catches dupes even when the invoice number is missing
-- or typed differently. Nothing here weakens the existing UNIQUE constraint.
-- ============================================================================
BEGIN;

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS intake_method         TEXT
    CHECK (intake_method IS NULL OR intake_method IN ('email','manual_upload','mail_scan','api')),
  ADD COLUMN IF NOT EXISTS intake_source_ref     TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_path   TEXT,
  ADD COLUMN IF NOT EXISTS file_sha256           TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of_invoice_id UUID REFERENCES ap_invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dedup_status          TEXT NOT NULL DEFAULT 'unique'
    CHECK (dedup_status IN ('unique','suspected_duplicate','confirmed_duplicate'));

-- Identical-file detector (per community, so two associations legitimately
-- storing the same shared-vendor PDF don't collide).
CREATE INDEX IF NOT EXISTS idx_ap_invoices_file_sha
  ON ap_invoices (community_id, file_sha256) WHERE file_sha256 IS NOT NULL;

-- Fuzzy dedup lookup: same vendor + same amount + same/near date. Closes the
-- NULL-invoice-number hole in the UNIQUE constraint.
CREATE INDEX IF NOT EXISTS idx_ap_invoices_dedup_fuzzy
  ON ap_invoices (community_id, vendor_id, total_cents, invoice_date);

-- Surface the holding area (suspected dupes sit on_hold with this flag set).
CREATE INDEX IF NOT EXISTS idx_ap_invoices_suspected
  ON ap_invoices (community_id) WHERE dedup_status = 'suspected_duplicate';

COMMIT;
