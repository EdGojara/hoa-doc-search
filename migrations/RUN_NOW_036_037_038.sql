-- ============================================================================
-- PASTE THIS WHOLE FILE INTO SUPABASE SQL EDITOR AND RUN ONCE.
-- ----------------------------------------------------------------------------
-- Bundled migrations 036 + 037 + 038. Idempotent — safe to re-run.
--
-- After this runs:
--   ✓ "Save as draft" works (drafts table exists)
--   ✓ "Save cycle" works with online/mail-back delivery toggles
--   ✓ Board Roster screen can save members
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 036: drafts table — save-in-progress for any screen
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drafts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  draft_type                  TEXT NOT NULL,
  community_name              TEXT NULL,
  community_id                UUID NULL,
  label                       TEXT NULL,
  state                       JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_refs                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drafts_type_community
  ON drafts (draft_type, community_name, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_company_updated
  ON drafts (management_company_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON drafts TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 037: board_members table — single source of truth per community
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_members (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  community_id                UUID NULL,
  community_name              TEXT NOT NULL,
  name                        TEXT NOT NULL,
  position                    TEXT NULL,
  term_start                  DATE NULL,
  term_end                    DATE NULL,
  email                       TEXT NULL,
  phone                       TEXT NULL,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  notes                       TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_members_community
  ON board_members (community_name, is_active, term_end);
CREATE INDEX IF NOT EXISTS idx_board_members_company
  ON board_members (management_company_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON board_members TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 038: delivery method columns on nomination_cycles
-- ----------------------------------------------------------------------------
ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS accept_electronic    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS accept_physical_mail BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;

-- ============================================================================
-- VERIFY (run these as separate queries after the COMMIT):
--   SELECT COUNT(*) FROM drafts;                       -- table exists
--   SELECT COUNT(*) FROM board_members;                -- table exists
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='nomination_cycles'
--       AND column_name IN ('accept_electronic','accept_physical_mail');
--   -- expect 2 rows
-- ============================================================================
