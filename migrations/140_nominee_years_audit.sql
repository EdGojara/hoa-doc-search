-- ============================================================================
-- 140_nominee_years_audit.sql
-- ----------------------------------------------------------------------------
-- Mirrors migration 139 (nominee_bio audit) for the years_in_community
-- field. Same problem, same shape:
--
--   - years_in_community is in NOMINEE_FIELDS, so the PATCH guard locks
--     it on online_form submissions.
--   - But typos happen ("2024" vs "2014"), and the value is public-facing
--     (printed under the candidate's name on the meeting notice / ballot).
--   - The right move is the same as for bio: edits allowed, original
--     preserved, every edit captures who/when/why.
--
-- Edit a name? Still locked (identity field, different risk profile).
-- Edit a years_in_community? Allowed with bio_edit_reason-style audit.
--
-- Apply after 139. Idempotent.
-- ============================================================================

BEGIN;

ALTER TABLE nominations
  ADD COLUMN IF NOT EXISTS original_years_in_community TEXT,
  ADD COLUMN IF NOT EXISTS years_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS years_edited_by TEXT,
  ADD COLUMN IF NOT EXISTS years_edit_reason TEXT,
  ADD COLUMN IF NOT EXISTS years_edit_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN nominations.original_years_in_community IS
  'Immutable copy of years_in_community as the homeowner originally submitted via /nominate. Set on first staff edit; never overwritten. Companion to original_nominee_bio (migration 139).';

COMMENT ON COLUMN nominations.years_edited_at IS
  'Timestamp of most recent staff edit to years_in_community. NULL if never edited.';

COMMENT ON COLUMN nominations.years_edited_by IS
  'Email of the staff member who most recently edited years_in_community.';

COMMENT ON COLUMN nominations.years_edit_reason IS
  'Operator-supplied reason for the most recent years edit (e.g., "Fixed typo: 2024 → 2014 per bio context").';

COMMENT ON COLUMN nominations.years_edit_count IS
  'Number of times years_in_community has been edited by staff. 0 = as submitted; 1+ = edited.';

-- Audit-query index for finding edited-years rows in a cycle
CREATE INDEX IF NOT EXISTS idx_nominations_years_edited
  ON nominations (cycle_id, years_edit_count)
  WHERE years_edit_count > 0;

COMMIT;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- SELECT cycle_id, nominee_name, years_in_community, original_years_in_community,
--        years_edit_count, years_edit_reason
-- FROM nominations
-- WHERE years_edit_count > 0
-- ORDER BY years_edited_at DESC;
