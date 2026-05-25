-- ============================================================================
-- 108_portal_tutorial_dismissed.sql
-- ----------------------------------------------------------------------------
-- Adds a tutorial_dismissed_at column to portal_users so we know whether a
-- homeowner has already dismissed (or completed) the first-login tutorial
-- overlay. Used to decide whether to AUTO-show the tutorial on portal load:
--
--   tutorial_dismissed_at IS NULL  -> show automatically (new user)
--   tutorial_dismissed_at IS NOT NULL -> only show if user clicks "Tour"
--
-- This pattern avoids needing a separate "first login" check — once dismissed,
-- the tutorial only re-appears when the user explicitly asks for it. Less
-- annoying than re-prompting every login until X interactions.
--
-- record_ownership: portal_users is association_record (homeowner identity
-- and access info belongs to the HOA on termination). Adding a UX-state column
-- doesn't change ownership.
-- ============================================================================

BEGIN;

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS tutorial_dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN portal_users.tutorial_dismissed_at IS
  'Timestamp the homeowner dismissed or completed the first-login tutorial overlay. '
  'NULL means tutorial auto-shows on next portal load. Set via '
  'POST /api/portal/tutorial-dismissed.';

COMMIT;
