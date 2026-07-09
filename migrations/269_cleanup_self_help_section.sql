-- ============================================================================
-- 269_cleanup_self_help_section.sql
-- ----------------------------------------------------------------------------
-- Per-community trash/debris self-help authority for the 10-Day Certified
-- Cleanup letter.
--
-- WHY: The self-help right to enter and abate a violation is granted by the
-- Declaration, and NOT every community's documents grant it — and where they
-- do, the trash/debris cleanup authority is often a DIFFERENT article than the
-- lawn force-mow authority (`communities.force_mow_section_full`). Reusing the
-- force-mow article on a cleanup letter risks citing authority the Declaration
-- doesn't actually grant for debris — a §209 / trespass exposure on a
-- court-bound certified letter. (Ed 2026-07-09: "not all communities have a
-- self-help provision and documents are different so they need to be tailored
-- for each community" → chose separate, explicit sections with no fallback.)
--
-- MODEL: exact parallel to force_mow_section_full. The 10-day cleanup letter
-- is offered ONLY where cleanup_section_full is populated (plus the shared
-- Declaration doc # + county). Blank = the letter is not available for that
-- community. No fallback to the force-mow article.
--
-- Record ownership: communities is association-scoped config; no new table.
-- No new GRANT needed (communities already granted to service_role).
-- ============================================================================

BEGIN;

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS cleanup_section_full text;

COMMENT ON COLUMN communities.cleanup_section_full IS
  'Declaration article/section that authorizes Association self-help cleanup / '
  'abatement of trash & debris (e.g., "Article 6.18 of the Declaration"). '
  'Required before the 10-Day Certified Cleanup letter (remedy_mode=cleanup) '
  'will render for this community; NULL = community has no recorded trash '
  'self-help authority and the letter is not offered. Distinct from '
  'force_mow_section_full (the lawn force-mow authority) — do not conflate.';

COMMIT;
