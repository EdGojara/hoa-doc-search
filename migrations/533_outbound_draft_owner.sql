-- ============================================================================
-- 533_outbound_draft_owner.sql  (Ed 2026-10-16)
-- ----------------------------------------------------------------------------
-- Draft ownership, stored so it can be enforced server-side. Before this, the
-- Draft Queue (/api/email-drafts) trusted the global staff cookie alone: any
-- staffer could read, edit, send or discard ANY draft.
--
--   outbound_email_drafts.owner_user_id  the signed-in person who started the
--   draft (user_profiles.id). Stamped by the New Email window and Amanda's desk.
--   NULL = started by automation (no human starter).
--
-- The rule lives in lib/email/draft_access.js: admins act on every draft (the
-- owner only for owner-only personas such as Tessa); staff act only on drafts
-- whose owner_user_id is their own. Existing rows stay NULL, so until someone
-- re-saves them they are admin-only, which matches who uses the queue today.
--
-- Record ownership: unchanged (MIXED, migration 327). Additive only: no row is
-- changed and nothing is sent. Community FK on this table: migration 532.
-- ============================================================================
BEGIN;

ALTER TABLE outbound_email_drafts
  ADD COLUMN IF NOT EXISTS owner_user_id UUID NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbound_email_drafts_owner_user_fkey') THEN
    ALTER TABLE outbound_email_drafts ADD CONSTRAINT outbound_email_drafts_owner_user_fkey
      FOREIGN KEY (owner_user_id) REFERENCES user_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- A staff user's own open drafts.
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_owner_open
  ON outbound_email_drafts (owner_user_id, status) WHERE owner_user_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_email_drafts TO service_role;
GRANT SELECT                          ON outbound_email_drafts TO authenticated;

COMMIT;

-- Verify:
--   SELECT owner_user_id IS NOT NULL AS owned, count(*) FROM outbound_email_drafts GROUP BY 1;
