BEGIN;

-- ============================================================================
-- 313_board_package_validation.sql  (Ed 2026-07-18)
-- ----------------------------------------------------------------------------
-- Turns the board-packet module into a validating meeting-operations engine
-- (the "Paige" agent): a per-association PROFILE of what a complete package
-- requires, plus a richer VALIDATION verdict per section so the system chases
-- and checks like a seasoned CAM while a human keeps judgment + final approval.
--
--   communities.board_package_config  — the reusable meeting profile: required
--     sections, responsible owner, confidentiality, cadence, financial cutoff,
--     board preferences. Encode the process once; no manager rebuilds it monthly.
--
--   board_packet_sections.validation_status / _detail — the spec's per-item
--     verdict (ready / missing / stale / wrong_period / incomplete / duplicate /
--     needs_confirmation / restricted / not_required), separate from the existing
--     workflow `status` (pending/ready/skipped). responsible_owner carries who
--     is on the hook for the exceptions.
-- ============================================================================

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS board_package_config JSONB;

ALTER TABLE board_packet_sections
  ADD COLUMN IF NOT EXISTS validation_status TEXT
    CHECK (validation_status IN ('ready','missing','stale','wrong_period','incomplete','duplicate','needs_confirmation','restricted','not_required')),
  ADD COLUMN IF NOT EXISTS validation_detail JSONB,
  ADD COLUMN IF NOT EXISTS responsible_owner TEXT;

CREATE INDEX IF NOT EXISTS idx_board_packet_sections_validation
  ON board_packet_sections (packet_id, validation_status);

COMMIT;
