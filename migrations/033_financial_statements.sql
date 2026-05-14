-- ============================================================================
-- 033_financial_statements.sql
-- ----------------------------------------------------------------------------
-- Stores monthly financial statements imported from Vantaca (or any accounting
-- source). Each row holds the source PDF, AI-extracted line-item JSON, and a
-- pointer to the Bedrock-branded re-rendered PDF. Findings (AI judgment pass)
-- live in their own JSONB column for now; later we can pull them into a
-- normalized table if we want cross-period analysis.
--
-- Apply AFTER 032. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS financial_statements (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id       UUID NOT NULL,
  community_id                UUID NULL,
  community_name              TEXT NOT NULL,
  -- What kind of statement
  statement_type              TEXT NOT NULL
                                CHECK (statement_type IN ('balance_sheet', 'income_statement', 'cash_flow', 'other')),
  -- Period it covers ("April 2026" + month-end date for sorting / variance)
  period_label                TEXT NOT NULL,
  period_end_date             DATE NULL,
  -- Source (Vantaca or whatever they uploaded)
  source_filename             TEXT NULL,
  source_pdf_storage_path     TEXT NULL,
  -- Structured data the AI extracted from the source
  extracted_data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Bedrock-branded output PDF
  branded_pdf_storage_path    TEXT NULL,
  -- Findings (AI judgment over the numbers)
  findings                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'generated'
                                CHECK (status IN ('draft', 'generated', 'failed')),
  created_by                  TEXT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_statements_community_period
  ON financial_statements (community_id, period_end_date DESC);
CREATE INDEX IF NOT EXISTS idx_financial_statements_mgmt_created
  ON financial_statements (management_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_statements_type
  ON financial_statements (statement_type, period_end_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON financial_statements TO anon, authenticated, service_role;

COMMIT;

-- Verify:
--   SELECT id, community_name, statement_type, period_label, created_at
--     FROM financial_statements ORDER BY created_at DESC LIMIT 5;
