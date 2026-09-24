-- ============================================================================
-- 452_conversion_staging.sql  (Ed 2026-09-24)  -- NOT YET APPLIED
-- ----------------------------------------------------------------------------
-- Staging for a period-end accounting conversion (first use: Lakes of Pine
-- Forest, Vantaca -> Trusted, baseline 2026-07-31).
--
-- STAGING ONLY. These tables hold the normalized input files Ed / ChatGPT
-- supply, the supplied control totals, the result of every deterministic
-- validation run, and every row that did not map exactly. Nothing here posts
-- to the GL, ar_charges, ar_payments, ap_invoices or any live table, and no
-- trigger or view reads these tables into live balances.
--
-- Flow: batch (draft) -> source files registered with sha256 -> rows staged
-- with exact-key mapping results -> control totals / control rules staged ->
-- validation runs recorded -> exceptions captured -> (later, separately
-- approved) posting. Rows are append-only per run; a re-supplied file is a new
-- source_files row and the old one is marked superseded, never overwritten.
--
-- Record ownership (CLAUDE.md): conversion inputs, controls and results are
-- the association's financial conversion record -> association_record.
-- Validation runs and exceptions are Bedrock's working papers -> workpaper.
-- Both are community-scoped through conversion_batches.community_id.
--
-- Security: operator-only. RLS enabled with no policies; service_role granted
-- explicitly (new tables without service_role grants are silently unwritable).
-- Purely additive: no existing table or row is changed.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS conversion_batches (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id              UUID NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  batch_code                TEXT NOT NULL UNIQUE,              -- e.g. CONV-LPF-20260731
  as_of_date                DATE NOT NULL,                     -- baseline date
  source_system             TEXT NOT NULL DEFAULT 'vantaca',
  status                    TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','staged','validated','approved','posted','voided')),
  august_forward_fingerprint TEXT,                             -- sha256 of Trusted rows dated after as_of, captured at staging
  notes                     TEXT,
  created_by                TEXT,
  approved_by               TEXT,
  approved_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversion_batches_community ON conversion_batches (community_id, as_of_date);

CREATE TABLE IF NOT EXISTS conversion_source_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  input_kind      TEXT NOT NULL CHECK (input_kind IN (
                    'ar_debits','ar_credits','ar_former_owners','ap_open','gl_trial_balance',
                    'bank_balances','outstanding_items','july_gl_activity','control_totals','control_rules')),
  filename        TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  row_count       INTEGER NOT NULL CHECK (row_count >= 0),
  format_ok       BOOLEAN NOT NULL,
  format_errors   JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_path    TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  supplied_by     TEXT,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One ACTIVE file per kind per batch; history kept as 'superseded'.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversion_source_files_active
  ON conversion_source_files (batch_id, input_kind) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversion_source_files_batch ON conversion_source_files (batch_id);

CREATE TABLE IF NOT EXISTS conversion_staged_rows (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  source_file_id          UUID NOT NULL REFERENCES conversion_source_files(id) ON DELETE RESTRICT,
  input_kind              TEXT NOT NULL,
  line_no                 INTEGER NOT NULL,                    -- line in the supplied file (header = 1)
  conversion_source_key   TEXT NOT NULL,                       -- <batch>:<file sha256>:<source_row or line>; stable audit identity
  row_data                JSONB NOT NULL,                      -- parsed row exactly as validated (amounts in cents)
  vantaca_account_id      TEXT,
  account_number          TEXT,
  amount_cents            BIGINT,
  -- exact-key mapping results (NULL = did not map; see conversion_exceptions)
  mapped_property_id      UUID REFERENCES properties(id) ON DELETE RESTRICT,
  mapped_account_id       UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  mapped_fund_id          UUID REFERENCES account_funds(id) ON DELETE RESTRICT,
  mapped_bank_account_id  UUID REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  mapped_vendor_id        UUID REFERENCES vendors(id) ON DELETE RESTRICT,
  map_status              TEXT NOT NULL CHECK (map_status IN ('mapped','exception','not_applicable')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_file_id, line_no),
  UNIQUE (batch_id, conversion_source_key)
);
CREATE INDEX IF NOT EXISTS idx_conversion_staged_rows_batch_kind ON conversion_staged_rows (batch_id, input_kind);
CREATE INDEX IF NOT EXISTS idx_conversion_staged_rows_account ON conversion_staged_rows (batch_id, vantaca_account_id) WHERE vantaca_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversion_control_totals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  source_file_id  UUID NOT NULL REFERENCES conversion_source_files(id) ON DELETE RESTRICT,
  control_code    TEXT NOT NULL,
  amount_cents    BIGINT NOT NULL,
  as_of           DATE NOT NULL,
  source_report   TEXT NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_file_id, control_code)
);

-- Control rules are supplied externally (control_rules.csv): "left must equal right".
CREATE TABLE IF NOT EXISTS conversion_control_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  source_file_id  UUID NOT NULL REFERENCES conversion_source_files(id) ON DELETE RESTRICT,
  rule_code       TEXT NOT NULL,
  left_expr       TEXT NOT NULL,
  right_expr      TEXT NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_file_id, rule_code)
);

-- One row per validation run (dry run). Results and exceptions hang off it,
-- so every run is reproducible and comparable.
CREATE TABLE IF NOT EXISTS conversion_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  run_kind        TEXT NOT NULL DEFAULT 'dry_run' CHECK (run_kind IN ('dry_run')),
  source_file_ids UUID[] NOT NULL,
  counts          JSONB NOT NULL,                              -- rule status counts
  staged_rows     JSONB NOT NULL,                              -- per file: rows, valid, mapped, exceptions
  all_pass        BOOLEAN NOT NULL,
  august_forward_fingerprint TEXT,
  report          JSONB NOT NULL,
  run_by          TEXT,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversion_runs_batch ON conversion_runs (batch_id, run_at DESC);

CREATE TABLE IF NOT EXISTS conversion_control_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES conversion_runs(id) ON DELETE CASCADE,
  rule_code       TEXT NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL CHECK (status IN ('PASS','FAIL','BLOCKED','PENDING_INPUT','UNKNOWN_NAME')),
  left_expr       TEXT,
  right_expr      TEXT,
  left_cents      BIGINT,
  right_cents     BIGINT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, rule_code)
);

CREATE TABLE IF NOT EXISTS conversion_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES conversion_runs(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL REFERENCES conversion_batches(id) ON DELETE RESTRICT,
  staged_row_id   UUID REFERENCES conversion_staged_rows(id) ON DELETE RESTRICT,
  input_kind      TEXT NOT NULL,
  line_no         INTEGER,
  field           TEXT,
  code            TEXT NOT NULL,                               -- e.g. FIELD_MISSING, ACCOUNT_NOT_ON_ANY_PROPERTY, GL_ACCOUNT_NOT_FOUND
  detail          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','waived')),
  resolution_note TEXT,                                        -- decided by Ed / ChatGPT, never by the code
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversion_exceptions_batch ON conversion_exceptions (batch_id, status);

DROP TRIGGER IF EXISTS trg_conversion_batches_updated_at ON conversion_batches;
CREATE TRIGGER trg_conversion_batches_updated_at
  BEFORE UPDATE ON conversion_batches
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

ALTER TABLE conversion_batches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_source_files     ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_staged_rows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_control_totals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_control_rules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_runs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_control_results  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_exceptions       ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  conversion_batches, conversion_source_files, conversion_staged_rows, conversion_control_totals,
  conversion_control_rules, conversion_runs, conversion_control_results, conversion_exceptions
  TO service_role;

COMMIT;
