-- 168: Vantaca Imports — canonical landing table for ALL Vantaca-sourced
-- reports (AR Aging, GL Export, AP Ledger, Bank Recon, Owner Statements,
-- etc.). One drop module, classifier figures out the type, fans out to
-- per-domain snapshot tables.
--
-- ARCHITECTURE (per Ed 2026-06-06):
-- Until Bedrock replaces Vantaca with a more durable back-office solution,
-- Vantaca remains the system of record for accounting. The Vantaca Imports
-- module gives operators ONE place to drop any Vantaca export — system
-- classifies, extracts, and routes to the right downstream snapshot table.
-- Every customer-facing surface that reads a Vantaca-mirrored value MUST
-- display "as of [datetime]" so no one mistakes the snapshot for live state.
--
-- HONEST NAMING: the table is named `vantaca_imports`, not a neutral term.
-- This visible dependency is intentional — the day we replace Vantaca, this
-- table gets renamed (or aliased) and the dependency mortgage gets paid off.
-- Until then, the name reminds everyone (including franchise operators)
-- what the back-office function actually is and where the bill goes.
--
-- RECORD OWNERSHIP (per CLAUDE.md):
--   vantaca_imports — MIXED:
--     - Row metadata (classifier confidence, extraction notes, import time,
--       operator ID) = workpaper. Bedrock's production process.
--     - Raw file referenced at storage_path = association_record. It's the
--       HOA's financial data we received on their behalf.
--   Per-type snapshot tables (owner_ar_snapshots, etc.) = association_record.
--     This is the community's financial data presented to boards and owners.
--
-- BUILDS ON:
--   migration 077 (owner_ar_snapshots) — existing AR snapshot table is the
--   first downstream consumer. This migration adds vantaca_import_id FK so
--   every AR snapshot row links back to the canonical import that produced it.
--
-- IDEMPOTENT — re-runnable.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) vantaca_imports — canonical landing table
-- ---------------------------------------------------------------------------
-- One row per file ever dropped into the Vantaca Imports module. Captures:
--   - what file came in (storage path, sha, size)
--   - how the classifier categorized it (community, report type, as-of)
--   - how confident the classifier was
--   - when the import happened and who triggered it
--   - the raw extraction result (for audit / debug-first per CLAUDE.md)
--   - the downstream snapshot row(s) it fed into
--
-- Source can be 'manual' (drag-drop in the UI) or 'email_ingest' (Phase 2,
-- M365 mailbox webhook) or future 'api' (when Vantaca finally cooperates
-- or when we've replaced them).
CREATE TABLE IF NOT EXISTS vantaca_imports (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id     UUID NOT NULL REFERENCES management_companies(id),

  -- Classification — may be NULL when status='needs_review' (operator
  -- overrides). Populated immediately after auto-classify on high-confidence
  -- routes, or after a manual reclassify.
  community_id              UUID REFERENCES communities(id) ON DELETE RESTRICT,
  report_type               TEXT
                              CHECK (report_type IS NULL OR report_type IN (
                                'ar_aging',
                                'gl_export',
                                'ap_ledger',
                                'bank_reconciliation',
                                'owner_statement',
                                'vendor_history',
                                'budget_actual',
                                'unknown'
                              )),
  -- As-of moment claimed BY THE REPORT (header date typically). Combined
  -- with imported_at at display time: "AR as of June 6 (imported June 7 8:42 AM)"
  as_of_date                DATE,

  -- Source provenance
  source                    TEXT NOT NULL DEFAULT 'manual'
                              CHECK (source IN ('manual', 'email_ingest', 'api')),
  source_filename           TEXT,
  source_storage_path       TEXT,                           -- Supabase storage path to original file
  source_email_from         TEXT,                           -- when source='email_ingest'
  source_email_subject      TEXT,                           -- when source='email_ingest'
  source_email_received_at  TIMESTAMPTZ,                    -- when source='email_ingest'
  source_sha256             TEXT,                           -- dedupe key — if same sha already imported, flag
  source_file_size_bytes    BIGINT,
  source_file_mime          TEXT,                           -- 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', etc.

  -- Classifier output
  classifier_confidence     TEXT
                              CHECK (classifier_confidence IS NULL OR classifier_confidence IN ('high', 'medium', 'low')),
  classifier_signals        JSONB,                          -- which signals fired: filename pattern, header match, content scan
  classifier_raw            JSONB,                          -- raw classifier output for debug

  -- Extraction output (per-extractor — varies by report type)
  extraction_raw            JSONB,                          -- structured rows the extractor produced
  extraction_row_count      INTEGER,                        -- e.g., 156 AR rows extracted
  extraction_warnings       TEXT[],                         -- ["mold sublimit not visible", "ar bucket totals don't match line total by $0.42"]

  -- Workflow state
  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN (
                                'pending',          -- uploaded, awaiting classify
                                'needs_review',     -- classifier confidence low; operator must pick
                                'classified',       -- classified, awaiting extraction
                                'processing',       -- extractor running
                                'completed',        -- extractor succeeded, downstream rows written
                                'failed',           -- extractor errored — see extraction_warnings
                                'voided'            -- operator deleted; row kept for audit
                              )),
  voided_at                 TIMESTAMPTZ,
  voided_by_user_id         UUID,
  voided_reason             TEXT,

  -- Operator attribution
  imported_by_user_id       UUID,
  imported_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Downstream linkage — IDs of the snapshot rows this import produced.
  -- For AR Aging: array of owner_ar_snapshots.id (one per property).
  -- For GL Export: array of gl_snapshots.id (one per account).
  -- Etc. Lets us answer "what rows came from import X?" without scanning.
  downstream_snapshot_table TEXT,
  downstream_snapshot_count INTEGER,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vantaca_imports_community_type_asof
  ON vantaca_imports (community_id, report_type, as_of_date DESC NULLS LAST)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_vantaca_imports_needs_review
  ON vantaca_imports (status, created_at DESC)
  WHERE status IN ('pending', 'needs_review', 'failed');

CREATE INDEX IF NOT EXISTS idx_vantaca_imports_sha
  ON vantaca_imports (source_sha256) WHERE source_sha256 IS NOT NULL;

DROP TRIGGER IF EXISTS trg_vantaca_imports_updated_at ON vantaca_imports;
CREATE TRIGGER trg_vantaca_imports_updated_at
  BEFORE UPDATE ON vantaca_imports
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Backlink: owner_ar_snapshots → vantaca_imports
-- ---------------------------------------------------------------------------
-- The existing AR snapshot table (migration 077) gets a column linking back
-- to the canonical import that produced its rows. ON DELETE SET NULL — if
-- the parent import is voided, the snapshot row stays but loses its link.
-- Audit trail preserved either way (vantaca_imports rows are kept on void,
-- not deleted; the FK SET NULL is a defensive fallback).
ALTER TABLE owner_ar_snapshots
  ADD COLUMN IF NOT EXISTS vantaca_import_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'owner_ar_snapshots_vantaca_import_fk'
  ) THEN
    ALTER TABLE owner_ar_snapshots
      ADD CONSTRAINT owner_ar_snapshots_vantaca_import_fk
      FOREIGN KEY (vantaca_import_id) REFERENCES vantaca_imports(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_owner_ar_snapshots_vantaca_import
  ON owner_ar_snapshots (vantaca_import_id)
  WHERE vantaca_import_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) Per-community staleness view
-- ---------------------------------------------------------------------------
-- The Vantaca Imports dashboard needs a fast "what's the latest of each
-- report type per community" query. View collapses the per-community ×
-- per-report-type matrix to one row each.
DROP VIEW IF EXISTS v_vantaca_mirror_freshness CASCADE;
CREATE VIEW v_vantaca_mirror_freshness AS
SELECT
  vi.community_id,
  c.name AS community_name,
  c.slug AS community_slug,
  vi.report_type,
  MAX(vi.as_of_date) AS latest_as_of_date,
  MAX(vi.imported_at) AS latest_imported_at,
  COUNT(*) FILTER (WHERE vi.status = 'completed') AS completed_count,
  -- Days since the last successful import — used for staleness flags.
  -- Tolerances live in code (per report type) so they can be tuned without
  -- a schema change.
  EXTRACT(DAY FROM (now() - MAX(vi.imported_at)))::INTEGER AS days_since_import
FROM vantaca_imports vi
JOIN communities c ON c.id = vi.community_id
WHERE vi.status = 'completed'
  AND vi.community_id IS NOT NULL
  AND vi.report_type IS NOT NULL
GROUP BY vi.community_id, c.name, c.slug, vi.report_type;

GRANT SELECT ON v_vantaca_mirror_freshness TO anon, authenticated, service_role;

COMMIT;
