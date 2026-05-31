-- ============================================================================
-- 139_nominee_bio_audit.sql
-- ----------------------------------------------------------------------------
-- Allows staff to edit nominee_bio on online_form submissions while
-- preserving an immutable record of what the homeowner originally typed.
--
-- WHY THIS EXISTS:
--   Migration 034 (nominations base) set up the table with nominee_bio as a
--   plain TEXT field. The PATCH /api/nominations/:id endpoint then added a
--   guard refusing nominee_* edits on online_form submissions — to protect
--   the audit trail of what the homeowner said vs. what staff edited later.
--
--   That guard worked legally but broke operationally: bios DO have typos,
--   formatting glitches, mis-spelled names. Sending the Annual Meeting
--   Notice/ballot with embarrassing typos in nominee bios is also bad. The
--   right answer is "edit allowed, original preserved, audit captures it."
--
-- WHAT THIS DOES:
--   - original_nominee_bio: captured on first edit, immutable afterward.
--     Reads exactly what the homeowner submitted through /nominate. If a
--     nominee later disputes the ballot bio, this is the receipt.
--   - bio_edited_at / bio_edited_by / bio_edit_reason / bio_edit_count:
--     captures every subsequent edit. The edit_reason is operator-supplied
--     ("typo fix", "formatting", "shortened to fit ballot", etc.) so the
--     audit log answers "why was this changed."
--
--   Other nominee_* fields (name, address, email, phone) STAY guarded —
--   bio is the only one that's a stylistic correction. Editing a name or
--   address has different risk (identity / mailing) and stays locked.
--
-- Record ownership (CLAUDE.md):
--   `association_record` bucket — these audit columns become part of the
--   election record handed over on termination. Operator names recorded in
--   bio_edited_by are workpaper but the EDIT itself (what changed and why)
--   is association_record.
--
-- Apply after 138. Idempotent via ADD COLUMN IF NOT EXISTS.
-- ============================================================================

BEGIN;

ALTER TABLE nominations
  ADD COLUMN IF NOT EXISTS original_nominee_bio TEXT,
  ADD COLUMN IF NOT EXISTS bio_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bio_edited_by TEXT,
  ADD COLUMN IF NOT EXISTS bio_edit_reason TEXT,
  ADD COLUMN IF NOT EXISTS bio_edit_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN nominations.original_nominee_bio IS
  'Immutable copy of what the homeowner originally submitted via /nominate. Set on first staff edit of nominee_bio; never overwritten. Source-of-truth for "what did the candidate actually write."';

COMMENT ON COLUMN nominations.bio_edited_at IS
  'Timestamp of most recent staff edit to nominee_bio. NULL if never edited.';

COMMENT ON COLUMN nominations.bio_edited_by IS
  'Email of the staff member who most recently edited nominee_bio.';

COMMENT ON COLUMN nominations.bio_edit_reason IS
  'Operator-supplied reason for the most recent bio edit (e.g., "typo fix", "formatting", "name spelling correction"). Required when editing online_form bios.';

COMMENT ON COLUMN nominations.bio_edit_count IS
  'Number of times nominee_bio has been edited by staff. 0 = exactly as submitted; 1+ = edited.';

-- Helpful index for the audit view ("show me every edited bio in this cycle")
CREATE INDEX IF NOT EXISTS idx_nominations_bio_edited
  ON nominations (cycle_id, bio_edit_count)
  WHERE bio_edit_count > 0;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'nominations'
--   AND column_name LIKE '%bio%'
-- ORDER BY ordinal_position;
--
-- -- Bios that have been edited (any cycle):
-- SELECT cycle_id, nominee_name, bio_edit_count, bio_edited_at, bio_edited_by, bio_edit_reason
-- FROM nominations
-- WHERE bio_edit_count > 0
-- ORDER BY bio_edited_at DESC;
