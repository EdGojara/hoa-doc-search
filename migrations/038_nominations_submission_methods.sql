-- ============================================================================
-- 038_nominations_submission_methods.sql
-- ----------------------------------------------------------------------------
-- Which submission paths the community will accept from homeowners on a
-- given cycle:
--   • accept_electronic    — online form (QR) + email
--   • accept_physical_mail — homeowner mails the nomination back
--
-- Drives the work-backwards "send-by" date in the timeline:
--   electronic only        → close − 14 days
--   physical mail accepted → close − 21 days  (extra 7 for USPS round-trip)
--
-- Also drives which submission paths the letter template prints. Default
-- both TRUE so existing cycles keep the current behavior.
--
-- Apply AFTER 037. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS accept_electronic    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS accept_physical_mail BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;

-- Verify:
--   SELECT id, community_name, accept_electronic, accept_physical_mail
--     FROM nomination_cycles ORDER BY created_at DESC LIMIT 5;
