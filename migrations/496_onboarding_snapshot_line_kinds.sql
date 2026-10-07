-- ============================================================================
-- 496_onboarding_snapshot_line_kinds.sql  (Ed 2026-10-07)
-- ----------------------------------------------------------------------------
-- The snapshot now emits three line kinds the 483 CHECK never listed, so the
-- first official Canyon Gate snapshot was refused by the database:
--   former_owner_receivable  former-owner debits routed out of AR (#78)
--   former_owner_refund      former-owner credits routed to a refund liability (#78)
--   ap_detail_restored       invoices an approved opening correction restores to AP (#80)
-- Widen the CHECK to exactly the kinds lib/onboarding/snapshot.js emits (enforced by
-- tests/test_onboarding_snapshot.js against this list). Existing rows are unchanged
-- (all use the original six kinds). Record ownership: workpaper (unchanged).
-- ============================================================================
BEGIN;

ALTER TABLE onboarding_snapshot_lines DROP CONSTRAINT IF EXISTS onboarding_snapshot_lines_kind_check;
ALTER TABLE onboarding_snapshot_lines ADD CONSTRAINT onboarding_snapshot_lines_kind_check
  CHECK (kind IN ('gl_opening_balance','ar_detail','ar_aging_item','prepaid_detail','ap_detail','unsupported_detail',
                  'former_owner_receivable','former_owner_refund','ap_detail_restored'));

COMMIT;
