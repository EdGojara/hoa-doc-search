-- ============================================================================
-- 040_nominations_floor_policy.sql
-- ----------------------------------------------------------------------------
-- Floor-nominations policy on the call-for-nominations letter.
--
-- Texas dedicatory instruments (CC&Rs, Bylaws, articles) vary across
-- communities — some forbid nominations from the floor at the annual meeting,
-- some allow them. When forbidden, §209.0058 makes the prior disclosure
-- load-bearing: homeowners must be told before the meeting so they have a
-- chance to submit on time.
--
-- Bedrock's review workflow: as we pull each community's dedicatory
-- instruments, we record the policy here. The letter renders the appropriate
-- notice based on the policy. The free-form `floor_nominations_note` lets us
-- substitute custom wording when a board has elected to deviate from their
-- governing documents — the note becomes the paper trail that they were
-- informed and chose to proceed anyway.
--
-- Defaults:
--   floor_nominations_policy           = NULL  (not yet reviewed)
--   include_floor_nominations_notice   = FALSE (omit until reviewed)
--   floor_nominations_note             = NULL  (use canned wording per policy)
--
-- Apply AFTER 039. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS floor_nominations_policy          TEXT NULL
    CHECK (floor_nominations_policy IN ('allowed', 'not_allowed') OR floor_nominations_policy IS NULL),
  ADD COLUMN IF NOT EXISTS include_floor_nominations_notice  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS floor_nominations_note            TEXT NULL;

COMMIT;

-- Verify:
--   SELECT id, community_name, floor_nominations_policy,
--          include_floor_nominations_notice, floor_nominations_note
--     FROM nomination_cycles ORDER BY created_at DESC LIMIT 5;
