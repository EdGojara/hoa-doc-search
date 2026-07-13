-- ============================================================================
-- 291_assessment_delinquency_view.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- Portfolio "late on assessments" roll-up. One row per account, categories
-- broken out so the amenity-restriction trigger can be set precisely.
--
-- Legally load-bearing (Texas): the authority to restrict amenities comes from
-- the DECLARATION; §209 governs process + payment priority (§209.0063, which
-- separates assessments from fines from "other"). The DEFENSIBLE default is to
-- restrict on ASSESSMENTS ONLY — not late fees / interest (which resemble the
-- fines-only wrongful-restriction risk), and never fines / attorney / admin.
-- Whether late fees + interest fold into "assessment" is Declaration-dependent
-- and an RMWBH call; hence they are broken out here so the rule stays a one-line
-- config in lib/ar/amenity_access.js rather than baked into the data.
--
-- Source is the live transactions ledger (v_homeowner_balance_composition ->
-- homeowner_transactions), the same balance the portal + Homeowner 360 + amenity
-- gate read. Coverage grows as communities move onto the ledger.
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
  -- DEFAULT restrictable amount for the watchlist: assessments only, net of
  -- payments/credits (total minus late fees/interest and fines/attorney/admin).
  -- The authoritative per-community gate decision is lib/ar/amenity_access.js.
  SUM(amount_cents)
    - SUM(CASE WHEN charge_category IN ('late_fee','interest','fine','attorney_fee','admin_fee') THEN amount_cents ELSE 0 END) AS assessment_past_due_cents
FROM v_homeowner_balance_composition
GROUP BY community_id, vantaca_account_id, property_id, contact_id;

GRANT SELECT ON v_assessment_delinquency TO service_role, authenticated;

COMMIT;
