-- ============================================================================
-- 418_voice_route_bedrock_number.sql  (Ed 2026-09-12)
-- ----------------------------------------------------------------------------
-- Register Bedrock's Twilio number (+1 832-430-2956) as an inbound voice route
-- for TESTING ONLY. Per Ed 2026-09-12: this number is NOT to be used for
-- anything client-facing for now (it is a test line, not A2P-cleared). So it is
-- mapped to the DEMO community (Drama Creek Estates), never a real client
-- community — a stray call can never land in a real association's context.
--
-- Routing model note: "Model B" (a dedicated number per community). When Ed is
-- ready to connect Claire to the real/main number for clients, add that number
-- here mapped to the right community. Do NOT point this test number at a client.
--
-- Idempotent: safe to re-run.
-- ============================================================================
BEGIN;

INSERT INTO voice_phone_routes
  (inbound_phone_number, community_id, community_display_name, enabled, off_hours_behavior)
VALUES
  ('+18324302956',
   (SELECT id FROM communities WHERE name ILIKE '%Drama Creek%' LIMIT 1),
   'Drama Creek Estates (TEST)',
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
