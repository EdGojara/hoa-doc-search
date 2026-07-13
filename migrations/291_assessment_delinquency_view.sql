-- ============================================================================
-- 291_assessment_delinquency_view.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- Portfolio "late on assessments" roll-up. One row per account with the
-- ASSESSMENT-CLASS past-due (assessment + late_fee + interest), split out from
-- fines / attorney / admin fees — exactly the split lib/ar/amenity_access.js
-- uses, so "late on assessments" and "amenity restricted" never disagree.
--
-- Legally load-bearing (Texas): amenity access may be restricted for
-- assessment delinquency but NOT for fines-only debt. Keeping the split here
-- (not "owes money") is what keeps a restriction defensible.
--
-- Source is the live transactions ledger (v_homeowner_balance_composition ->
-- homeowner_transactions), the same balance the portal + Homeowner 360 + amenity
-- gate read. Coverage grows as communities move onto the ledger.
-- ============================================================================
BEGIN;

CREATE OR REPLACE VIEW v_assessment_delinquency AS
SELECT
  community_id,
  vantaca_account_id,
  property_id,
  contact_id,
  SUM(amount_cents)                                                                    AS total_balance_cents,
  SUM(CASE WHEN charge_category IN ('fine','attorney_fee','admin_fee') THEN amount_cents ELSE 0 END) AS non_assessment_cents,
  SUM(amount_cents)
    - SUM(CASE WHEN charge_category IN ('fine','attorney_fee','admin_fee') THEN amount_cents ELSE 0 END) AS assessment_past_due_cents
FROM v_homeowner_balance_composition
GROUP BY community_id, vantaca_account_id, property_id, contact_id;

GRANT SELECT ON v_assessment_delinquency TO service_role, authenticated;

COMMIT;
