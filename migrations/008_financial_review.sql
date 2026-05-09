-- ============================================================================
-- 008_financial_review.sql
-- ----------------------------------------------------------------------------
-- HOA Monthly Financial Review module.
--
-- The CPA / hedge-fund-desk trading mindset: every monthly financial package
-- gets a structured analytical pass before it reaches Ed (or eventually a
-- board). Variance is the enemy. Anomalies surface as findings ranked by
-- severity. Clerk addresses each, escalates exceptions only.
--
-- Same module is the embryo of the layer-3 consulting engine (per
-- project_trusted memory) — built on Bedrock's own clients first, sold as
-- AUP-style service to outside boards later.
--
-- Tables:
--   financial_packages      uploaded BS/IS/rolling-12 per community per period
--   gl_account_lines        chart of accounts entries extracted from package
--   gl_monthly_balances     month-by-month actual + budget per GL line
--   analytical_review_runs  every AI analytical pass (P3 trade-tape integration)
--   analytical_findings     structured findings, severity-ranked, status-tracked
--   finding_responses       clerk's answer / dismissal / escalation per finding
--
-- Apply AFTER 001 (foundation), 002 (billing — for contract cross-tie checks).
-- Idempotent. Per the brand-the-output rule: parsed GL data is the source for
-- Bedrock-rendered financial highlights, never a forwarded vendor PDF.
-- ============================================================================

-- ============================================================================
-- financial_packages
-- One row per (community, period) pair. The IS, BS, rolling-12, and any
-- supporting docs uploaded for that period.
-- ============================================================================
CREATE TABLE IF NOT EXISTS financial_packages (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id),
  fiscal_period            DATE NOT NULL,                                -- month-end of the period covered
  period_label             TEXT NOT NULL,                                -- e.g. "March 2026"
  source_doc_urls          JSONB,                                        -- {is, bs, rolling12, other}
  uploaded_by              UUID,
  uploaded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','parsed','reviewed','approved','void')),
  parsed_at                TIMESTAMPTZ,
  reviewed_at              TIMESTAMPTZ,
  approved_at              TIMESTAMPTZ,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (community_id, fiscal_period)
);

CREATE INDEX IF NOT EXISTS idx_fin_pkg_community_period
  ON financial_packages(community_id, fiscal_period DESC);
CREATE INDEX IF NOT EXISTS idx_fin_pkg_status
  ON financial_packages(management_company_id, status, fiscal_period DESC);

DROP TRIGGER IF EXISTS trg_fin_pkg_updated_at ON financial_packages;
CREATE TRIGGER trg_fin_pkg_updated_at
  BEFORE UPDATE ON financial_packages
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- gl_account_lines
-- Chart of accounts entries for a financial package. One row per unique
-- (account_code) within a package.
--
-- section: 'revenue' | 'expense' | 'reserve' | 'savings' | 'other'
--   matches the way Vantaca-style reports group rows
-- category_label: subgroup heading (e.g. "Holiday and Community events",
--   "Landscaping Expenses", "Office/Administrative Expenses")
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_account_lines (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  package_id               UUID NOT NULL REFERENCES financial_packages(id) ON DELETE CASCADE,
  account_code             TEXT,                                         -- e.g. "5770"; null tolerable for headers/totals
  account_name             TEXT NOT NULL,                                -- e.g. "Security Services"
  section                  TEXT NOT NULL DEFAULT 'other'
                           CHECK (section IN ('revenue','expense','reserve','savings','other')),
  category_label           TEXT,                                         -- e.g. "Office/Administrative Expenses"
  sort_order               INTEGER NOT NULL DEFAULT 0,
  is_subtotal              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_lines_package
  ON gl_account_lines(package_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_gl_lines_code
  ON gl_account_lines(account_code) WHERE account_code IS NOT NULL;

-- ============================================================================
-- gl_monthly_balances
-- Month-by-month actual + budget per GL account line. For a rolling-12
-- statement we get 12 rows per line; for a single-period statement we get 1.
--
-- variance is a stored generated column for convenience.
-- ============================================================================
CREATE TABLE IF NOT EXISTS gl_monthly_balances (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_id                  UUID NOT NULL REFERENCES gl_account_lines(id) ON DELETE CASCADE,
  month                    DATE NOT NULL,                                -- first-of-month
  actual                   NUMERIC(14,2),
  budget                   NUMERIC(14,2),
  variance                 NUMERIC(14,2)
                           GENERATED ALWAYS AS (
                             COALESCE(actual,0) - COALESCE(budget,0)
                           ) STORED,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, month)
);

CREATE INDEX IF NOT EXISTS idx_gl_balances_line_month
  ON gl_monthly_balances(line_id, month DESC);
CREATE INDEX IF NOT EXISTS idx_gl_balances_month
  ON gl_monthly_balances(month);

-- ============================================================================
-- analytical_review_runs
-- One row per AI analytical pass. Captures the prompt + model + cost
-- + duration so we can replay, audit, and version-control the analysis.
-- Same operating-model rule as agent_runs: every AI-driven decision has a
-- complete trade tape.
-- ============================================================================
CREATE TABLE IF NOT EXISTS analytical_review_runs (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  package_id               UUID NOT NULL REFERENCES financial_packages(id) ON DELETE CASCADE,
  management_company_id    UUID NOT NULL REFERENCES management_companies(id),
  community_id             UUID NOT NULL REFERENCES communities(id),
  run_kind                 TEXT NOT NULL DEFAULT 'standard_review'
                           CHECK (run_kind IN ('standard_review','deep_dive','reclassification_check','custom')),
  model                    TEXT,
  prompt_version           TEXT,
  input_token_count        INTEGER,
  output_token_count       INTEGER,
  cost_usd                 NUMERIC(10,6),
  duration_ms              INTEGER,
  finding_count            INTEGER NOT NULL DEFAULT 0,
  raw_response             JSONB,                                        -- preserve full AI response for replay/audit
  run_by_user_id           UUID,                                         -- nullable until auth
  agent_run_id             UUID REFERENCES agent_runs(id),               -- bridge to global trade tape
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_runs_package
  ON analytical_review_runs(package_id, created_at DESC);

-- ============================================================================
-- analytical_findings
-- The output of the check engine. Structured, ranked, status-tracked.
--
-- check_type enum captures the analytical procedure that surfaced this:
--   zero_where_never_zero    line went silent vs. its baseline
--   trend_break              variance from recent baseline
--   reversal_entry           +N then -N pattern
--   gl_classification        capital vs expense / wrong account
--   contract_cross_tie       GL line doesn't match contract rate (e.g. website $250 vs $150)
--   duplicate_posting        same dollar amount in two places (potential dupe)
--   presentation_issue       e.g. transfer netted into revenue rather than below the line
--   materiality_threshold    line above $X warrants board attention
--   ai_observed              free-form judgment finding from the AI pass
--
-- severity drives the queue ranking. CFE-instinct: critical finds first.
-- ============================================================================
CREATE TABLE IF NOT EXISTS analytical_findings (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  package_id               UUID NOT NULL REFERENCES financial_packages(id) ON DELETE CASCADE,
  run_id                   UUID REFERENCES analytical_review_runs(id),
  severity                 TEXT NOT NULL DEFAULT 'medium'
                           CHECK (severity IN ('critical','high','medium','low','info')),
  check_type               TEXT NOT NULL
                           CHECK (check_type IN (
                             'zero_where_never_zero',
                             'trend_break',
                             'reversal_entry',
                             'gl_classification',
                             'contract_cross_tie',
                             'duplicate_posting',
                             'presentation_issue',
                             'materiality_threshold',
                             'ai_observed'
                           )),
  title                    TEXT NOT NULL,                                -- one-line headline
  finding_text             TEXT NOT NULL,                                -- detailed analytical paragraph
  account_codes            TEXT[],
  months_involved          DATE[],
  amount_at_issue          NUMERIC(14,2),
  suggested_question       TEXT,                                         -- what to ask the clerk
  evidence                 JSONB,                                        -- raw rows / context
  status                   TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','answered','dismissed','escalated')),
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_findings_package_severity
  ON analytical_findings(package_id, severity, sort_order);
CREATE INDEX IF NOT EXISTS idx_findings_open
  ON analytical_findings(package_id, severity)
  WHERE status = 'open';

DROP TRIGGER IF EXISTS trg_findings_updated_at ON analytical_findings;
CREATE TRIGGER trg_findings_updated_at
  BEFORE UPDATE ON analytical_findings
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

-- ============================================================================
-- finding_responses
-- Clerk's answer to a finding. Full audit trail for layer-3 defensibility.
-- ============================================================================
CREATE TABLE IF NOT EXISTS finding_responses (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  finding_id               UUID NOT NULL REFERENCES analytical_findings(id) ON DELETE CASCADE,
  answered_by              UUID,                                         -- nullable until auth
  answered_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_text            TEXT NOT NULL,
  action_taken             TEXT,                                         -- 'reclass', 'investigated', 'no_action', etc.
  supporting_doc_urls      JSONB,
  resolved                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finding_responses_finding
  ON finding_responses(finding_id, answered_at DESC);

-- ============================================================================
-- Row Level Security
-- ============================================================================
ALTER TABLE financial_packages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_account_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_monthly_balances      ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytical_review_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytical_findings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_responses        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_fin_pkg_tenant ON financial_packages;
CREATE POLICY p_fin_pkg_tenant ON financial_packages
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_gl_lines_tenant ON gl_account_lines;
CREATE POLICY p_gl_lines_tenant ON gl_account_lines
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM financial_packages p
    WHERE p.id = gl_account_lines.package_id
      AND p.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_gl_balances_tenant ON gl_monthly_balances;
CREATE POLICY p_gl_balances_tenant ON gl_monthly_balances
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM gl_account_lines l
    JOIN financial_packages p ON p.id = l.package_id
    WHERE l.id = gl_monthly_balances.line_id
      AND p.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_review_runs_tenant ON analytical_review_runs;
CREATE POLICY p_review_runs_tenant ON analytical_review_runs
  FOR ALL TO authenticated
  USING (management_company_id::text = (auth.jwt() ->> 'management_company_id'))
  WITH CHECK (management_company_id::text = (auth.jwt() ->> 'management_company_id'));

DROP POLICY IF EXISTS p_findings_tenant ON analytical_findings;
CREATE POLICY p_findings_tenant ON analytical_findings
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM financial_packages p
    WHERE p.id = analytical_findings.package_id
      AND p.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

DROP POLICY IF EXISTS p_finding_responses_tenant ON finding_responses;
CREATE POLICY p_finding_responses_tenant ON finding_responses
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM analytical_findings f
    JOIN financial_packages p ON p.id = f.package_id
    WHERE f.id = finding_responses.finding_id
      AND p.management_company_id::text = (auth.jwt() ->> 'management_company_id')
  ));

-- ============================================================================
-- API role grants (consistent with 004_grants pattern for billing tables)
-- ============================================================================
GRANT ALL ON
  financial_packages,
  gl_account_lines,
  gl_monthly_balances,
  analytical_review_runs,
  analytical_findings,
  finding_responses
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  financial_packages,
  gl_account_lines,
  gl_monthly_balances,
  analytical_review_runs,
  analytical_findings,
  finding_responses
TO authenticated;

-- ============================================================================
-- Convenience view: open findings ranked by severity per package
-- ============================================================================
CREATE OR REPLACE VIEW v_findings_open_by_package AS
SELECT
  f.package_id,
  p.community_id,
  p.fiscal_period,
  p.period_label,
  CASE f.severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    WHEN 'info' THEN 5
    ELSE 9
  END AS severity_rank,
  f.id AS finding_id,
  f.severity,
  f.check_type,
  f.title,
  f.finding_text,
  f.amount_at_issue,
  f.account_codes,
  f.months_involved,
  f.suggested_question,
  f.evidence,
  f.created_at
FROM analytical_findings f
JOIN financial_packages p ON p.id = f.package_id
WHERE f.status = 'open'
ORDER BY p.fiscal_period DESC, severity_rank, f.sort_order;

GRANT SELECT ON v_findings_open_by_package
  TO service_role, authenticated;

-- ============================================================================
-- Done. Verify with:
--   SELECT COUNT(*) FROM financial_packages;     -- expect 0
--   SELECT COUNT(*) FROM analytical_findings;    -- expect 0
-- ============================================================================
