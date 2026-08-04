-- 351_acc_email_linking.sql
-- ---------------------------------------------------------------------------
-- Link the names + emails on inbound ACC correspondence to the application
-- (Ed 2026-08-03).
--
-- The Lopez patio (EAG-ARC-2026-0001) fragmented across three acc_decisions
-- rows because a homeowner follow-up email could not be matched back to the
-- open case: she wrote from a different address than the one on her form, and
-- the address string differed only in punctuation. Every miss spawned a new
-- decision, so the returned engineered plans — and her real name + email —
-- never joined the case. See lib/acc/match_open_application.js.
--
-- Two columns make the link durable:
--   - correspondent_emails: every EXTERNAL address that has written about this
--     application. The matcher checks it (signal #3), so once an address has
--     touched a case, the next email from it self-matches even without the
--     thread. The link compounds instead of resetting each message.
--   - conversation_id: the Graph conversation the case belongs to, so a
--     follow-up in the same thread attaches with certainty (signal #1) without
--     re-deriving it from source_email_refs each time.
--
-- Record ownership: workpaper (acc_decisions is Bedrock's decision record; the
-- SENT letter is sealed separately as association_record). Idempotent.
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE acc_decisions
  ADD COLUMN IF NOT EXISTS correspondent_emails text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS conversation_id text;

-- Find the case for a given inbound thread fast (matcher signal #1).
CREATE INDEX IF NOT EXISTS idx_acc_decisions_conversation_id
  ON acc_decisions (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Membership lookups on the address set (matcher signal #3).
CREATE INDEX IF NOT EXISTS idx_acc_decisions_correspondent_emails
  ON acc_decisions USING gin (correspondent_emails);

-- acc_decisions already grants SELECT/INSERT/UPDATE/DELETE to service_role and
-- SELECT to authenticated (mig 326); added columns inherit those table grants.

COMMIT;
