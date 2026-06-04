-- 160_converted_reports.sql
--
-- Tracks every Vantaca-format report converted to a Bedrock-branded
-- equivalent. Ed 2026-06-04 directive: drag-drop a Vantaca PDF, AI
-- extracts the structured data, Bedrock renders the customer-facing
-- artifact. First report type supported is DRV monthly summary (the
-- April LOPF / Violation (7) docs in the working example); pattern
-- extends to AR aging, work order summary, financial reports, etc. as
-- they're built.
--
-- Record ownership per CLAUDE.md:
--   - This row is workpaper — Bedrock IP. The conversion is our
--     value-add over Vantaca's raw output.
--   - The source PDF and rendered output PDF are mixed: the rendered
--     artifact is delivered to a board (association_record on
--     termination); the source upload + AI extraction + branding
--     pipeline is workpaper.

BEGIN;

CREATE TABLE IF NOT EXISTS converted_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid REFERENCES communities(id) ON DELETE SET NULL,

  -- What kind of source report was uploaded. Driven by AI auto-detection
  -- + operator confirmation. Extensible: every new template adds a new
  -- enum value via follow-up migration.
  source_type text NOT NULL
    CHECK (source_type IN (
      'vantaca_drv_summary',
      'vantaca_violation_detail',
      'vantaca_ar_aging',
      'vantaca_work_order_summary',
      'vantaca_other',
      'unknown'
    )),

  -- Reporting period the source covers — useful for filtering and for
  -- the rendered artifact's title (e.g., "April 2026"). Either set if
  -- detected, or null if not applicable.
  period_label text,
  period_start date,
  period_end date,

  -- Source file
  source_file_path text NOT NULL,            -- Supabase storage path
  source_file_name text NOT NULL,
  source_file_hash text,                      -- sha256 for dedup
  source_file_size_bytes int,

  -- Rendered output file
  output_file_path text,                      -- Supabase storage path, null until render succeeds
  output_file_name text,
  output_page_count int,

  -- AI extraction
  extraction_model text DEFAULT 'claude-sonnet-4-5',
  extraction_confidence text CHECK (extraction_confidence IN ('high','medium','low')),
  ai_extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_extraction text,                         -- raw model response for diagnosis

  -- Lifecycle
  status text NOT NULL DEFAULT 'extracted'
    CHECK (status IN ('extracted','rendered','failed','archived')),
  error_message text,

  -- Audit
  uploaded_by_email text,
  rendered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_converted_reports_community ON converted_reports(community_id);
CREATE INDEX IF NOT EXISTS idx_converted_reports_source_type ON converted_reports(source_type);
CREATE INDEX IF NOT EXISTS idx_converted_reports_period ON converted_reports(period_end DESC);
CREATE INDEX IF NOT EXISTS idx_converted_reports_status ON converted_reports(status);
CREATE INDEX IF NOT EXISTS idx_converted_reports_hash ON converted_reports(source_file_hash);

DROP TRIGGER IF EXISTS trg_converted_reports_updated_at ON converted_reports;
CREATE TRIGGER trg_converted_reports_updated_at
  BEFORE UPDATE ON converted_reports
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON converted_reports TO service_role;
GRANT SELECT ON converted_reports TO authenticated;

COMMIT;
