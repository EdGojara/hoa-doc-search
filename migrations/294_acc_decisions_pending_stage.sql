-- ============================================================================
-- 294_acc_decisions_pending_stage.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- Turn acc_decisions (the ONE working decision engine's store) into a queue +
-- history: an application from any door (staff upload, homeowner portal, Annie's
-- email) lands as status='pending_review' carrying the engine's DRAFTED
-- recommendation + letter; a human reviews, accepts/adjusts the decision, and
-- sending the letter flips it to status='decided'.
--
-- Existing 29 rows are finished decisions → default 'decided' (unchanged flow).
-- ============================================================================
BEGIN;

ALTER TABLE acc_decisions
  ADD COLUMN IF NOT EXISTS status             TEXT NOT NULL DEFAULT 'decided'
                            CHECK (status IN ('pending_review', 'decided')),
  ADD COLUMN IF NOT EXISTS source             TEXT,     -- 'staff_upload' | 'email' | 'portal' | 'web'
  ADD COLUMN IF NOT EXISTS submitter_email    TEXT,
  ADD COLUMN IF NOT EXISTS ai_recommendation  TEXT,     -- engine's suggested decision_type (advisory)
  ADD COLUMN IF NOT EXISTS ai_review_text     TEXT,     -- engine workpaper / analysis
  ADD COLUMN IF NOT EXISTS ai_letter_body     TEXT,     -- engine's drafted homeowner letter
  ADD COLUMN IF NOT EXISTS intake_source_ref  TEXT;     -- 'email:<graphId>' etc. — idempotency

-- One record per source item (an emailed application is never queued twice).
CREATE UNIQUE INDEX IF NOT EXISTS ux_acc_decisions_intake_ref
  ON acc_decisions (intake_source_ref) WHERE intake_source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acc_decisions_status
  ON acc_decisions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_decisions_source
  ON acc_decisions (source, status);

COMMIT;
