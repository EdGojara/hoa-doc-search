-- ============================================================================
-- 288_email_persona_tessa.sql  (Ed 2026-07-12)
-- ----------------------------------------------------------------------------
-- Tessa is Ed's PRIVATE executive assistant. Her sends log into email_messages
-- from tessa@ (as Tessa) or from Ed's own mailbox (ghostwritten). Migration 287
-- had no tessa rule, so those rows fell through to 'claire' and would surface on
-- the shared team board. Re-tag them 'tessa' so they stay owner-only. The API
-- excludes persona='tessa' from every non-owner query.
-- ============================================================================
BEGIN;

UPDATE email_messages
   SET persona = 'tessa'
 WHERE lower(mailbox) IN ('tessa@bedrocktx.com', 'egojara@bedrocktx.com');

COMMIT;
