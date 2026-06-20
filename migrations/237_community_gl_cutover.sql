-- ============================================================================
-- 237_community_gl_cutover.sql
-- ----------------------------------------------------------------------------
-- Mark which communities are on trustEd's GL as book of record vs still on
-- Vantaca snapshots. Drives the migration-aware Finance area: a community with
-- a cutover date shows the live GL screens (Trial Balance, Homeowner Accounts,
-- AR, Tie-Out, Bank Rec); without one, it keeps the Vantaca-snapshot screens
-- (Owner AR, Financial Review). As each community migrates, set its date and it
-- flips over -- no duplicate screens, no two-answers-one-number risk.
-- ============================================================================
BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS gl_cutover_date DATE;  -- NULL = Vantaca snapshots; set = trustEd GL is book of record

COMMENT ON COLUMN communities.gl_cutover_date IS
  'Date trustEd GL became book of record. NULL = still on Vantaca snapshots. Drives the migration-aware Finance nav.';

-- Quail Ridge cut over 6/1/2026 (first community).
UPDATE communities SET gl_cutover_date = '2026-06-01'
  WHERE id = 'a0000000-0000-4000-8000-000000000005' AND gl_cutover_date IS NULL;

COMMIT;
