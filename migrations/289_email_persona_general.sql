-- ============================================================================
-- 289_email_persona_general.sql  (Ed 2026-07-12)
-- ----------------------------------------------------------------------------
-- Split the general inbox off Claire. Undirected junk that hit info@
-- (solicitations, marketing, unclassifiable — classification spam/other) gets
-- its own 'general' bucket so it never clutters Claire's card and never
-- auto-drafts. Real homeowner mail, legal, and staff/internal mail stay with
-- Claire. Mail sent straight to claire@ stays hers regardless.
-- Live rows are routed by lib/email/persona.js; this backfills existing ones.
-- ============================================================================
BEGIN;

UPDATE email_messages
   SET persona = 'general'
 WHERE persona = 'claire'
   AND classification IN ('spam', 'other')
   AND lower(coalesce(mailbox, '')) NOT LIKE '%claire@%';

COMMIT;
