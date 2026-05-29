-- ============================================================================
-- 132_candidate_ballot_order.sql
-- ----------------------------------------------------------------------------
-- Per-cycle candidate ordering for the Annual Meeting Notice. Today the
-- renderer hard-sorts alphabetical by last name on both the ballot (page 3)
-- and the candidate statements (page 4). This migration adds two pieces of
-- config that let Bedrock control the order at notice generation time:
--
--   nomination_cycles.candidate_sort_mode  — how to sort the slate
--     'alphabetical'      → existing behavior (default)
--     'incumbents_first'  → is_incumbent=true first (alpha within), then
--                           challengers (alpha within)
--     'manual'            → use the per-nomination ballot_order integer
--
--   nominations.ballot_order               — explicit per-candidate position
--     NULL  → fall back to alphabetical within bucket
--     1     → top of ballot
--     2     → second
--     ...   → ...
--
-- WHY THIS MATTERS:
--   HOA convention is to list incumbents first on the ballot — recognizes
--   their current service while keeping the ballot fair. Ed flagged
--   2026-05-29 that the alphabetical default puts incumbents wherever their
--   last name lands, which can read as a procedural slight even when it
--   isn't. The toggle keeps the renderer flexible per-cycle without
--   touching the legal-notice statutory wording (which stays locked in
--   GLOBAL_RULES / template files).
--
-- RECORD OWNERSHIP (CLAUDE.md):
--   nomination_cycles = association_record (HOA owns the cycle history)
--   nominations.ballot_order = mixed (the cycle/slate is the HOA's; how
--                              Bedrock ordered it at render time is part
--                              of Bedrock's workflow but the order
--                              physically prints on the delivered notice)
--
-- Apply AFTER 131. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS candidate_sort_mode TEXT NOT NULL DEFAULT 'alphabetical'
    CHECK (candidate_sort_mode IN ('alphabetical', 'incumbents_first', 'manual'));

ALTER TABLE nominations
  ADD COLUMN IF NOT EXISTS ballot_order INTEGER NULL
    CHECK (ballot_order IS NULL OR ballot_order >= 1);

-- Partial index — sparse, only matters when an explicit order is set
CREATE INDEX IF NOT EXISTS idx_nominations_ballot_order
  ON nominations (cycle_id, ballot_order)
  WHERE ballot_order IS NOT NULL;

COMMENT ON COLUMN nomination_cycles.candidate_sort_mode IS
  'How the Annual Meeting Notice renderer sorts candidates on the ballot + statements pages. Set per-cycle by Bedrock before generating the notice.';
COMMENT ON COLUMN nominations.ballot_order IS
  'Explicit 1-based position on the ballot. Only honored when the cycle row has candidate_sort_mode = manual. NULL means fall back to alphabetical within bucket.';

COMMIT;
