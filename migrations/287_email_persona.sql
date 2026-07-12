-- ============================================================================
-- 287_email_persona.sql  (Ed 2026-07-12)
-- ----------------------------------------------------------------------------
-- Attribute every email to the AI team member who owns it (Claire / Emma /
-- Annie / Miranda) so the Communications board can show a roster of names that
-- expands to each person's mail. Attribution is by ROUTING, not just mailbox:
-- a DRV response or ACC application arrives at info@ but belongs to Miranda /
-- Annie. Live rows are stamped at ingest by lib/email/persona.js; this backfills
-- the existing ones with the same precedence.
-- ============================================================================
BEGIN;

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS persona TEXT;

UPDATE email_messages SET persona = CASE
  WHEN lower(mailbox) = 'miranda@bedrocktx.com'          THEN 'miranda'
  WHEN extracted->'drv'->>'persona' = 'miranda'          THEN 'miranda'
  WHEN lower(mailbox) = 'annie@bedrocktx.com'            THEN 'annie'
  WHEN classification = 'acc_request'                    THEN 'annie'
  WHEN lower(mailbox) = 'emma@bedrocktx.com'             THEN 'emma'
  WHEN resolved_vendor_id IS NOT NULL                    THEN 'emma'
  WHEN classification IN ('vendor_financial','vendor_general') THEN 'emma'
  ELSE 'claire'
END
WHERE persona IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_messages_persona ON email_messages (persona, received_at DESC);

COMMIT;
