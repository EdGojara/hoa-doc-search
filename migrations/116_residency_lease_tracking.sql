-- ============================================================================
-- 116_residency_lease_tracking.sql
-- ----------------------------------------------------------------------------
-- Extends property_residencies (migration 049) with lease term tracking so
-- staff can capture full rental relationships (start/end dates, monthly rent,
-- security deposit, renter-specific notes) and so downstream surfaces can
-- check "is this person eligible right now" — e.g., the amenity-rentals flow
-- gating clubhouse bookings on an active lease.
--
-- Existing columns on property_residencies (kept):
--   property_id, contact_id (the renter), residency_type, start_date, end_date,
--   lease_end_date, lease_pdf_path, source, notes
--
-- New columns added by this migration:
--   lease_start_date    — when the current lease term began
--   monthly_rent        — rental rate (informational, not used for AR)
--   security_deposit    — deposit amount held (informational)
--   notes_renter        — renter-specific notes (vehicles, pets, etc.) —
--                         separate from notes (which is more residency-level)
--   lease_renewal_count — incremented when a lease is renewed in place
--                         (vs. ending the residency and starting a new one)
--
-- Plus a view v_active_leases that surfaces:
--   - residency_type='renter' AND end_date IS NULL
--   - lease_active flag (lease_end_date >= today)
--   - days_until_lease_expires
--   - Used by future amenity-eligibility checks + the Property Detail UI's
--     "lease expiring soon" warning
--
-- Apply AFTER 115. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE property_residencies
  ADD COLUMN IF NOT EXISTS lease_start_date    DATE NULL,
  ADD COLUMN IF NOT EXISTS monthly_rent        NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS security_deposit    NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS notes_renter        TEXT NULL,
  ADD COLUMN IF NOT EXISTS lease_renewal_count INTEGER NOT NULL DEFAULT 0;

-- View for the active-lease-eligibility check. Used by:
--   - Property Detail UI (lease status badge, days remaining, expiring-soon warning)
--   - Amenity rental booking endpoint (block if no active lease)
--   - Calendar / dashboard summaries (count leases expiring within 60 days)
DROP VIEW IF EXISTS v_active_leases CASCADE;
CREATE VIEW v_active_leases AS
SELECT
  pr.id                 AS residency_id,
  pr.property_id,
  pr.contact_id,
  c.full_name           AS renter_name,
  c.primary_email       AS renter_email,
  c.primary_phone       AS renter_phone,
  pr.residency_type,
  pr.start_date         AS residency_start,
  pr.lease_start_date,
  pr.lease_end_date,
  pr.monthly_rent,
  pr.security_deposit,
  pr.lease_renewal_count,
  pr.lease_pdf_path,
  pr.notes_renter,
  (pr.lease_end_date IS NOT NULL AND pr.lease_end_date >= CURRENT_DATE) AS lease_active,
  CASE
    WHEN pr.lease_end_date IS NULL THEN NULL
    WHEN pr.lease_end_date < CURRENT_DATE THEN 0
    ELSE (pr.lease_end_date - CURRENT_DATE)
  END                   AS days_until_lease_expires,
  CASE
    WHEN pr.lease_end_date IS NOT NULL AND pr.lease_end_date - CURRENT_DATE BETWEEN 0 AND 60 THEN TRUE
    ELSE FALSE
  END                   AS expiring_within_60_days
FROM property_residencies pr
LEFT JOIN contacts c ON c.id = pr.contact_id
WHERE pr.residency_type = 'renter'
  AND pr.end_date IS NULL;

-- Index for amenity-eligibility lookups: "what's the current residency for property X?"
CREATE INDEX IF NOT EXISTS idx_residencies_current_lookup
  ON property_residencies (property_id, residency_type)
  WHERE end_date IS NULL;

-- Index for "leases expiring soon" queries (avoid full scan)
CREATE INDEX IF NOT EXISTS idx_residencies_lease_end_active
  ON property_residencies (lease_end_date)
  WHERE end_date IS NULL AND residency_type = 'renter' AND lease_end_date IS NOT NULL;

GRANT SELECT ON v_active_leases TO anon, authenticated, service_role;

COMMIT;

-- Verify after running:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'property_residencies'
--      AND column_name IN ('lease_start_date','monthly_rent','security_deposit','notes_renter','lease_renewal_count');
--   -- expect 5 rows
--
--   SELECT COUNT(*) FROM v_active_leases;
--   -- count of current renter residencies
--
--   SELECT renter_name, lease_end_date, days_until_lease_expires
--   FROM v_active_leases WHERE expiring_within_60_days = TRUE
--   ORDER BY lease_end_date;
