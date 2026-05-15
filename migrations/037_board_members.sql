-- ============================================================================
-- 037_board_members.sql
-- ----------------------------------------------------------------------------
-- Per-community Board roster. Single source of truth for who serves on each
-- board, with positions, term dates, contact info. Flows into:
--   • Call for Nominations cycle.current_board snapshot
--   • Board Packets cover page roster
--   • Recaps / annual meeting minutes attendance
--   • "Who's up for re-election" auto-suggestion
--
-- Apply AFTER 036. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS board_members (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  community_id                UUID NULL,
  community_name              TEXT NOT NULL,
  name                        TEXT NOT NULL,
  position                    TEXT NULL,           -- President, Vice President, Treasurer, Secretary, At-Large, Director
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

COMMIT;

-- Verify:
--   SELECT name, position, term_end FROM board_members
--    WHERE community_name ILIKE '%waterview%' AND is_active ORDER BY position;
