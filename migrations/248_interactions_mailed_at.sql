-- ============================================================================
-- 248_interactions_mailed_at.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-26 — Mail Queue process gap. "Lock dates + print" marked letters
-- printed + sent in one shot; if the download was blocked / missed / failed,
-- the letters vanished from the queue but never physically printed or mailed
-- (65 letters stranded this way in one click). Letters should stay in the
-- system to be reviewed or re-printed until they are actually mailed.
--
-- Split the lifecycle: printed_at = the batch was LOCKED + the PDF generated
-- (re-downloadable); mailed_at = the operator CONFIRMED it was physically
-- mailed (the new "Confirm mailed" step). A locked-but-not-mailed batch
-- (printed_at set, mailed_at NULL) stays visible in the Mail Queue so it can
-- be re-downloaded any number of times — a missed download can never strand a
-- letter again.
-- ============================================================================

BEGIN;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS mailed_at TIMESTAMPTZ;

COMMENT ON COLUMN interactions.mailed_at IS
  'When a violation letter was confirmed physically mailed (operator clicks "Confirm mailed" after the locked batch is printed). NULL + printed_at set = locked/printed, awaiting mail confirmation (still re-downloadable in the Mail Queue). Distinct from printed_at (lock/postmark time).';

-- Backfill: any letter already marked printed before this change is treated as
-- mailed (it predates the two-step flow), so it doesn't resurface as "awaiting
-- confirmation". The 2026-06-26 stranded batch was already reset to 'approved'
-- (printed_at NULL) out-of-band, so it is correctly excluded here.
UPDATE interactions
   SET mailed_at = COALESCE(sent_at, printed_at)
 WHERE type LIKE 'letter_%'
   AND printed_at IS NOT NULL
   AND mailed_at IS NULL;

COMMIT;
