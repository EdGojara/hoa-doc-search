-- ============================================================================
-- 418_voice_route_bedrock_number.sql  (Ed 2026-09-12)
-- ----------------------------------------------------------------------------
-- Register Bedrock's Twilio number (+1 832-430-2956) as an inbound voice route
-- so a call to it reaches Claire scoped to a community. Mapped to Waterview
-- Estates for now (Ed's launch-prep test community).
--
-- Routing model note: this is "Model B" (a dedicated number per community).
-- Today Bedrock has ONE number, so any caller to it is scoped to Waterview.
-- Before real multi-community launch we either (a) get a number per community,
-- or (b) rely on caller-ID community detection with a "which community?" prompt.
-- Change the community here by editing this row (inbound_phone_number is UNIQUE).
--
-- Idempotent: safe to re-run.
-- ============================================================================
BEGIN;

INSERT INTO voice_phone_routes
  (inbound_phone_number, community_id, community_display_name, enabled, off_hours_behavior)
VALUES
  ('+18324302956',
   (SELECT id FROM communities WHERE name ILIKE '%Waterview Estates%' LIMIT 1),
   'Waterview Estates',
   TRUE,
   'voicemail')
ON CONFLICT (inbound_phone_number) DO UPDATE
  SET community_id           = EXCLUDED.community_id,
      community_display_name = EXCLUDED.community_display_name,
      enabled                = TRUE,
      updated_at             = NOW();

COMMIT;

-- Verify:
--   SELECT inbound_phone_number, community_display_name, enabled
--   FROM voice_phone_routes;
