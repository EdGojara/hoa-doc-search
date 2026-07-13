-- ============================================================================
-- 293_assessment_delinquency_assessments_only.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- Redefine v_assessment_delinquency (from 291) so the restrictable amount is
-- ASSESSMENTS ONLY, matching Ed's §209 decision + lib/ar/amenity_access.js:
--   assessment_past_due = total − (late fees + interest) − (fines/attorney/admin)
-- Late fees + interest are now EXCLUDED from the restriction trigger (they
-- resemble the fines-only wrongful-restriction risk; folding them in is
-- Declaration-specific + an RMWBH call). Categories are broken out so the
-- Late-on-Assessments watchlist can show what's excluded.
--
-- 291 shipped the earlier "assessment-class" shape and was already applied;
-- this is the follow-up migration rather than an edit to 291. Column set
-- changed, so DROP + CREATE + re-GRANT (per the "DROP VIEW loses GRANTs" scar).
-- ============================================================================
BEGIN;

DROP VIEW IF EXISTS v_assessment_delinquency CASCADE;
CREATE VIEW v_assessment_delinquency AS
SELECT
  community_id,
  vantaca_account_id,
  property_id,
  contact_id,
  SUM(amount_cents)                                                                          AS total_balance_cents,
  SUM(CASE WHEN charge_category = 'assessment'            THEN amount_cents ELSE 0 END)       AS assessment_cents,
  SUM(CASE WHEN charge_category IN ('late_fee','interest') THEN amount_cents ELSE 0 END)      AS late_interest_cents,
  SUM(CASE WHEN charge_category IN ('fine','attorney_fee','admin_fee') THEN amount_cents ELSE 0 END) AS other_charges_cents,
  SUM(amount_cents)
    - SUM(CASE WHEN charge_category IN ('late_fee','interest','fine','attorney_fee','admin_fee') THEN amount_cents ELSE 0 END) AS assessment_past_due_cents
FROM v_homeowner_balance_composition
GROUP BY community_id, vantaca_account_id, property_id, contact_id;

GRANT SELECT ON v_assessment_delinquency TO service_role, authenticated;

COMMIT;
