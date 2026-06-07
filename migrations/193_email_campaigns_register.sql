-- ============================================================================
-- 193_email_campaigns_register.sql
-- ----------------------------------------------------------------------------
-- Adds the "voice register" classification to email_campaigns. Register
-- drives Claire's drafting voice + the rendered letterhead variant +
-- compliance posture per the Bedrock Connect design philosophy (Ed
-- 2026-06-08).
--
-- THREE REGISTERS:
--   engagement   — Warm, community, social. Hero photo + multiple CTAs.
--                  Events, surveys, newsletters, board candidate spotlights.
--   operational  — Clear, actionable, professional. Single primary CTA.
--                  Meeting reminders, maintenance notices, hurricane prep.
--   compliance   — Formal, legally precise, branded. Statutory wording.
--                  Violations, fines, §209 cure notices. Auto-routes to
--                  certified mail when law requires. Cannot be
--                  unsubscribed by homeowner.
--
-- For v1, the register drives letterhead variant + button color in the
-- rendered HTML. Future iterations will hook Claire's drafting voice
-- to this field.
-- ============================================================================

BEGIN;

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS register TEXT NOT NULL DEFAULT 'operational'
  CHECK (register IN ('engagement','operational','compliance'));

COMMENT ON COLUMN email_campaigns.register IS
  'Voice register classification per Bedrock Connect philosophy. Drives Claire drafting voice + letterhead variant + compliance posture. Three values: engagement (warm/community/social), operational (clear/actionable/professional), compliance (formal/legally precise/branded — cannot be unsubscribed).';

CREATE INDEX IF NOT EXISTS idx_email_campaigns_register
  ON email_campaigns(register, created_at DESC);

COMMIT;
