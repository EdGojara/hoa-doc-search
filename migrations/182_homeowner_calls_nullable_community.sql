-- 182: Make homeowner_calls.community_id nullable
--
-- Ed's Claire test call (2026-06-06) didn't appear in the Calls list because
-- the api/voice.js incoming handler GATED the homeowner_calls row creation
-- on a non-null community_id. When 832-430-2956 didn't resolve to a
-- community (either via voice_phone_routes lookup OR via caller-ID
-- contact match), no row was created — even though Claire still answered
-- the call.
--
-- Result: every unrouted call is invisible to ops. Can't see them, can't
-- tune them, can't even catch routing misconfig until someone notices
-- 'where's my test call?'
--
-- Fix: make community_id nullable on homeowner_calls. NULL means
-- 'unrouted / Claire answered with generic greeting / community
-- resolution failed.' Combined with the api/voice.js change (always
-- upsert the row), every Twilio call is now logged.
--
-- Record ownership: workpaper (per CLAUDE.md — internal call recordings
-- + briefs are Bedrock's operational data; the relevant per-community
-- subset becomes mixed when delivered to a board via dashboards).

BEGIN;

ALTER TABLE homeowner_calls
  ALTER COLUMN community_id DROP NOT NULL;

-- Add an index so 'show me unrouted calls' queries are fast.
CREATE INDEX IF NOT EXISTS idx_calls_unrouted
  ON homeowner_calls (started_at DESC)
  WHERE community_id IS NULL;

COMMIT;
