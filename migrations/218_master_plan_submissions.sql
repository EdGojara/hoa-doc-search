-- ============================================================================
-- 218_master_plan_submissions.sql
-- ----------------------------------------------------------------------------
-- Teresa Contreras (Lennar) 2026-06-12 surfaced the gap: she needs to submit
-- a NEW master plan to the Still Creek Ranch catalog, separate from the
-- per-lot construction submission flow. The platform had no front door for
-- this — the 36 master plans in the system were imported server-side as
-- pre-approved Tier batches, not via a builder-facing submission path.
--
-- This migration creates the application substrate for builder-side master
-- plan submissions. The two submission types stay schema-separate because:
--   • Per-lot submissions (builder_applications) have lot/block/section/
--     address as NOT NULL. They're fundamentally lot-bound.
--   • Master plan submissions are plan-bound, not lot-bound. They produce
--     master_plans rows (the catalog) on approval, not a lot decision.
--   • Review criteria, SLA expectations, and letter content differ.
--
-- On approval, the existing /master-plans/bulk-extract endpoint runs the
-- AI extraction on the uploaded PDF and adds the extracted plans to
-- master_plans with status='approved'. Same downstream catalog every
-- per-lot submission references.
--
-- Record ownership (CLAUDE.md): mixed — drafts are workpaper (Bedrock's
-- review process), delivered approval letters are association_record.
-- Attachments (the master plan PDF set) are association_record (the
-- HOA's design archive).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) master_plan_submissions — one row per "builder proposes new master plan"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_plan_submissions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  builder_company_id       UUID NOT NULL REFERENCES builder_companies(id) ON DELETE RESTRICT,

  reference_number         TEXT UNIQUE,

  -- Submitter
  submitter_email          TEXT NOT NULL,
  submitter_name           TEXT,
  submitter_phone          TEXT,
  portal_user_id           UUID REFERENCES portal_users(id) ON DELETE SET NULL,
  source                   TEXT NOT NULL DEFAULT 'portal'
                             CHECK (source IN ('portal', 'email', 'manual_entry')),

  -- What the builder is submitting
  submission_title         TEXT NOT NULL,                   -- e.g. "Lennar Classic 4 Side — Q3 2026 Addition"
  plan_numbers_proposed    TEXT[] NOT NULL DEFAULT '{}',    -- e.g. {"4900","4910","4920"}
  description              TEXT,                            -- free-text notes from the builder

  -- Workflow state
  status                   TEXT NOT NULL DEFAULT 'received'
                             CHECK (status IN ('received','under_review','info_requested',
                                               'approved','approved_with_conditions','denied','withdrawn')),

  -- AI extraction results — populated when staff runs the bulk-extract
  -- against the uploaded PDF. Shape mirrors what master_plans expects per
  -- elevation, plus an accept/reject flag per row for the staff reviewer.
  --   { extracted_at: ISO, ai_confidence: "high|medium|low",
  --     elevations: [ {plan_number, plan_name, elevation, elevation_orientation,
  --                    square_footage, stories, accepted: bool} ] }
  ai_extraction            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Created master_plans IDs once approved — backlink for audit. Lets us
  -- answer "which submission introduced Plan 4900-C4 to the catalog?".
  created_master_plan_ids  UUID[] NOT NULL DEFAULT '{}',

  -- Builder acknowledgments captured at submission
  builder_acknowledgments  JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Decision metadata (populated on finalize)
  decided_at               TIMESTAMPTZ,
  decided_by               TEXT,
  decision_notes           TEXT,                            -- approval conditions / denial reasons

  -- Letter artifact (populated when approval letter renders)
  letter_pdf_path          TEXT,
  letter_signed_url        TEXT,
  letter_signed_url_expires_at TIMESTAMPTZ,

  submitted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mps_queue
  ON master_plan_submissions(community_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_mps_builder
  ON master_plan_submissions(builder_company_id, status, submitted_at DESC);

DROP TRIGGER IF EXISTS trg_master_plan_submissions_updated_at ON master_plan_submissions;
CREATE TRIGGER trg_master_plan_submissions_updated_at
  BEFORE UPDATE ON master_plan_submissions
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON master_plan_submissions TO service_role;
GRANT SELECT ON master_plan_submissions TO authenticated;


-- ---------------------------------------------------------------------------
-- 2) master_plan_submission_attachments — uploaded plan PDFs + supporting docs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_plan_submission_attachments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id            UUID NOT NULL REFERENCES master_plan_submissions(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL DEFAULT 'master_plan_pdf'
                             CHECK (kind IN ('master_plan_pdf','color_board','material_sample','design_guidelines_reference','other')),
  storage_bucket           TEXT NOT NULL DEFAULT 'documents',
  storage_path             TEXT NOT NULL,
  original_filename        TEXT,
  mime_type                TEXT,
  size_bytes               BIGINT,
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by              TEXT
);

CREATE INDEX IF NOT EXISTS idx_mps_attachments_submission
  ON master_plan_submission_attachments(submission_id, kind);

GRANT SELECT, INSERT, UPDATE, DELETE ON master_plan_submission_attachments TO service_role;
GRANT SELECT ON master_plan_submission_attachments TO authenticated;


-- ---------------------------------------------------------------------------
-- 3) Reference number sequence: SCR-MPS-2026-NNNN (community prefix + MPS)
--    Reuses the existing application_reference_counters table from
--    migration 080 with a new service_type discriminator.
-- ---------------------------------------------------------------------------
-- application_reference_counters CHECK constraint already includes
-- 'builder_arc'. Adding 'master_plan_submission' as a parallel service_type
-- so the counter increments independently of per-lot submissions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'application_reference_counters'
      AND constraint_name LIKE 'application_reference_counters_service_type%'
  ) THEN
    ALTER TABLE application_reference_counters
      DROP CONSTRAINT IF EXISTS application_reference_counters_service_type_check;
    ALTER TABLE application_reference_counters
      ADD CONSTRAINT application_reference_counters_service_type_check
      CHECK (service_type IN ('builder_arc','master_plan_submission','resident_acc','estoppel','other'));
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================
-- -- Tables exist:
-- SELECT count(*) FROM master_plan_submissions;
-- SELECT count(*) FROM master_plan_submission_attachments;
--
-- -- Counter service_type accepts the new value:
-- INSERT INTO application_reference_counters (community_id, service_type, year, counter)
--   VALUES ('a0000000-0000-4000-8000-000000000006','master_plan_submission',2026,0)
--   ON CONFLICT DO NOTHING;
