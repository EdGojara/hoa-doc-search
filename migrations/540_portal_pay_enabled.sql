-- ============================================================================
-- 540_portal_pay_enabled.sql  (Ed 2026-10-16, portal launch blockers)
-- ----------------------------------------------------------------------------
-- The homeowner portal showed "Pay now" whenever a community had a Stripe
-- connected account id. Waterview has an account but its ledger conversion is
-- not done, so owners there could have been offered a payment against a balance
-- that is not yet right.
--
-- Ed's activation gate: a community takes portal payments only after ownership
-- identity is verified, opening balances / conversion are approved, AR is
-- reconciled, cash / bank reconciliation is acceptable, and the Stripe account
-- and bank are verified. That judgment is Ed's, per community, so it gets an
-- explicit switch rather than being inferred from "an account exists".
--
-- communities.portal_pay_enabled: OFF by default. This migration turns it on for
-- NO community. Ed turns it on per community after the gate passes. Read by
-- lib/portal/pay_gate.js (both the Pay button and /api/portal/pay/checkout),
-- which also requires active financials, Stripe charges + payouts enabled, and
-- live mode in production.
--
-- Additive, idempotent. No data changes.
-- ============================================================================
BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS portal_pay_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN communities.portal_pay_enabled IS
  'Ed''s per-community switch for homeowner portal payments. OFF by default and never set by a migration. Turn on only after the activation gate (ownership verified, conversion approved, AR reconciled, bank rec acceptable, Stripe live + bank verified). lib/portal/pay_gate.js also requires financials active and Stripe charges + payouts enabled.';

COMMIT;
