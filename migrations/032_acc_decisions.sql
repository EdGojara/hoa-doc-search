-- ============================================================================
-- 032_acc_decisions.sql
-- ----------------------------------------------------------------------------
-- Saves every manager-finalized ACC decision so we can:
--   1. Look up past decisions by homeowner_address (Ed's specific ask)
--   2. Re-download the decision letter at any time
--   3. Generate a merged packet (letter + original application + photos)
--      on demand for record-keeping or board distribution
--
-- Apply AFTER 031. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS acc_decisions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  community_id                UUID NULL,
  community_name              TEXT NOT NULL,
  homeowner_name              TEXT NULL,
  homeowner_address           TEXT NULL,
  project_summary             TEXT NULL,
  reference_number            TEXT NULL,
  decision_type               TEXT NULL
                                CHECK (decision_type IS NULL OR decision_type IN
                                       ('approved', 'approved_no_conditions', 'approved_with_conditions',
                                        'request_more_info', 'incomplete', 'denied')),
  letter_body                 TEXT NULL,
  review_text                 TEXT NULL,
  -- Supabase storage paths (under the existing `documents` bucket)
  letter_pdf_storage_path     TEXT NULL,
  application_pdf_storage_path TEXT NULL,
  photo_storage_paths         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  packet_pdf_storage_path     TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Address is the key Ed asked to search by ("pull up history later if needed")
CREATE INDEX IF NOT EXISTS idx_acc_decisions_address
  ON acc_decisions (homeowner_address);
CREATE INDEX IF NOT EXISTS idx_acc_decisions_mgmt_created
  ON acc_decisions (management_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acc_decisions_community
  ON acc_decisions (community_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON acc_decisions TO anon, authenticated, service_role;

COMMIT;

-- Verify:
--   SELECT id, community_name, homeowner_address, decision_type, created_at
--     FROM acc_decisions ORDER BY created_at DESC LIMIT 5;
