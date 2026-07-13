-- ============================================================================
-- 295_community_billing_contact.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- A saved "send invoices to" contact per community — the single canonical place
-- for who receives this community's Bedrock invoices (the treasurer or whoever
-- the board designates). The invoice email flow auto-fills the recipient from
-- here, falling back to the board treasurer/president only when it's unset;
-- staff can still override per send. Removes the re-typing friction (Ed wanted
-- billing "automated with manual overrides").
--
-- Single-value primary + a comma-separated Cc list covers "send to certain
-- emails" (e.g. treasurer To, president Cc) without a child table.
--
-- association_record context: these live on the communities row (already an
-- association-scoped record); no new table, no new grants.
-- ============================================================================
BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS billing_contact_name  TEXT,
  ADD COLUMN IF NOT EXISTS billing_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS billing_cc_emails     TEXT;   -- comma-separated Cc list

COMMENT ON COLUMN communities.billing_contact_email IS
  'Primary recipient for this community''s Bedrock invoices (falls back to board treasurer/president when null).';

COMMIT;
