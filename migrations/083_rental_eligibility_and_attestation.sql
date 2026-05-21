-- ============================================================================
-- 083_rental_eligibility_and_attestation.sql
-- ----------------------------------------------------------------------------
-- Adds renter eligibility tracking to amenity_rentals.
--
-- See project_eligibility_and_deposits.md — three-tier eligibility design:
--   Tier 1: self-attestation at submission (captured here as
--           attested_current_at_submission + attested_at + attested_ip)
--   Tier 2: auto-flag via owner_ar_snapshots cross-reference at intake
--           (captured here as eligibility_check_flag + eligibility_check_data)
--   Tier 3: hard block at submission (later, when Vantaca API is real-time)
--
-- Apply after 082. Idempotent.
-- ============================================================================

ALTER TABLE amenity_rentals
  ADD COLUMN IF NOT EXISTS attested_current_at_submission  BOOLEAN,
  ADD COLUMN IF NOT EXISTS attested_at                     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eligibility_check_flag          TEXT
    CHECK (eligibility_check_flag IS NULL OR eligibility_check_flag IN
      ('clean', 'past_due_at_intake', 'no_property_match', 'unverified',
       'staff_overridden_to_confirmed', 'staff_overridden_to_cancelled')),
  ADD COLUMN IF NOT EXISTS eligibility_check_data          JSONB,
  ADD COLUMN IF NOT EXISTS eligibility_reviewed_by         TEXT,
  ADD COLUMN IF NOT EXISTS eligibility_reviewed_at         TIMESTAMPTZ;

COMMENT ON COLUMN amenity_rentals.attested_current_at_submission IS
  'TRUE when renter checked the "I am current on assessments" attestation at submission. Captured with attested_at + attested_ip for audit trail.';
COMMENT ON COLUMN amenity_rentals.eligibility_check_flag IS
  'Result of automatic eligibility check at intake. clean = no past-due match found. past_due_at_intake = property matched, balance > 0, status delinquent. no_property_match = address could not be matched to a property. unverified = check did not run (community has no owner_ar_snapshots populated). staff_*_overridden = staff explicitly resolved the flag.';
COMMENT ON COLUMN amenity_rentals.eligibility_check_data IS
  'Snapshot of what the auto-check found at intake — matched property_id, balance_cents, ar_status, snapshot_at, etc. Preserved so staff sees the state at submission even if AR data later changes.';

-- Index so the admin queue can quickly filter to flagged rentals
CREATE INDEX IF NOT EXISTS idx_amenity_rentals_eligibility_flag
  ON amenity_rentals(community_id, eligibility_check_flag, event_date DESC)
  WHERE eligibility_check_flag IS NOT NULL AND eligibility_check_flag <> 'clean';
