-- ============================================================================
-- 144_nomination_layout_mode.sql
-- ----------------------------------------------------------------------------
-- Adds layout_mode to nomination_cycles so different communities can pick
-- the Annual Meeting Notice layout that matches their established convention.
--
--   'compact'   — Waterview Estates 2025 style. Notice + Proxy + Ballot all
--                 on ONE page with §209.00592 disclosure embedded inline in
--                 the Assignment-of-Proxy paragraph. No standalone agenda
--                 page. Most postage-efficient. 2-3 pages total typical.
--
--   'detailed'  — Canyon Gate 2026 style. Separate pages for notice+agenda,
--                 voting instructions, and proxy/ballot. §209 disclosure as
--                 its own callout box. 5-6 pages total typical.
--
-- Both formats produce legally-compliant outputs per Texas Property Code
-- §209.0056 (notice content + 10-60 day timing) and §209.00592 (electronic
-- ballot disclosure). The choice is a board-style preference, not a
-- compliance question.
--
-- Default: 'compact' for new cycles (postage savings + matches most prior
-- Bedrock packets). Existing cycles keep their current behavior via the
-- COALESCE in the renderer.
--
-- Apply after 143. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nomination_cycles
  ADD COLUMN IF NOT EXISTS layout_mode TEXT
    CHECK (layout_mode IS NULL OR layout_mode IN ('compact', 'detailed'));

COMMENT ON COLUMN nomination_cycles.layout_mode IS
  'AMN packet layout. NULL = renderer default (compact). compact = single-page notice+proxy+ballot (Waterview 2025 style). detailed = separate notice/agenda/instructions/ballot pages (Canyon Gate 2026 style). Per-cycle so different community conventions can coexist.';

-- Seed: tag the existing Waterview cycle as compact so the current cycle
-- regenerates in the format it's used historically. Other cycles get NULL
-- (which the renderer treats as the default — also compact).
UPDATE nomination_cycles
SET layout_mode = 'compact'
WHERE community_name ILIKE 'Waterview%' AND layout_mode IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT community_name, annual_meeting_date, layout_mode, status
-- FROM nomination_cycles
-- ORDER BY annual_meeting_date DESC;
