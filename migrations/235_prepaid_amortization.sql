-- ============================================================================
-- 235_prepaid_amortization.sql
-- ----------------------------------------------------------------------------
-- Prepaid amortization engine. The accounting policy Ed wants encoded: a staff
-- member uploads a document (insurance policy, prepaid service contract, etc.),
-- the system books it to a prepaid asset, segments the cost across expense
-- accounts, and then auto-posts the monthly amortization on its own — for every
-- community. trustEd knows the journal entries; anyone can upload the document.
--
-- Three tables:
--   prepaid_schedules            one per prepaid item being amortized
--   prepaid_schedule_segments    the expense-account breakdown (D&O->5605, etc.)
--   prepaid_amortization_postings one row per month actually posted (idempotency)
--
-- Record ownership: association_record (the HOA's books).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS prepaid_schedules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  description              TEXT NOT NULL,                         -- "Insurance 2025-2026 policy year"
  prepaid_account_number   TEXT NOT NULL,                         -- the asset being drawn down, e.g. '1400'
  source_document_id       UUID REFERENCES library_documents(id) ON DELETE SET NULL,  -- the uploaded doc
  -- Amortization parameters (in trustEd — i.e. the portion trustEd amortizes).
  amortize_amount_cents    BIGINT NOT NULL CHECK (amortize_amount_cents > 0),  -- total to amortize here
  amortize_start_month     DATE NOT NULL,                         -- first month posted (1st of month)
  term_months              INTEGER NOT NULL CHECK (term_months > 0),
  monthly_amount_cents     BIGINT NOT NULL,                       -- per-month (last month stubs to exact)
  coverage_period_start    DATE,                                  -- the underlying policy/contract dates (info)
  coverage_period_end      DATE,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'fully_amortized', 'cancelled')),
  notes                    TEXT,
  record_ownership         TEXT NOT NULL DEFAULT 'association_record',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prepaid_sched_community ON prepaid_schedules(community_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS prepaid_schedule_segments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id              UUID NOT NULL REFERENCES prepaid_schedules(id) ON DELETE CASCADE,
  expense_account_number   TEXT NOT NULL,                         -- '5605'
  label                    TEXT,                                  -- 'Directors & Officers'
  monthly_amount_cents     BIGINT NOT NULL CHECK (monthly_amount_cents >= 0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prepaid_seg_schedule ON prepaid_schedule_segments(schedule_id);

CREATE TABLE IF NOT EXISTS prepaid_amortization_postings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id              UUID NOT NULL REFERENCES prepaid_schedules(id) ON DELETE CASCADE,
  period_month             DATE NOT NULL,                         -- 1st of the month posted
  journal_entry_id         UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  amount_cents             BIGINT NOT NULL,
  posted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_month)                             -- a month can only post once
);

DROP TRIGGER IF EXISTS trg_prepaid_sched_updated ON prepaid_schedules;
CREATE TRIGGER trg_prepaid_sched_updated BEFORE UPDATE ON prepaid_schedules
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON prepaid_schedules            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON prepaid_schedule_segments    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON prepaid_amortization_postings TO service_role;
GRANT SELECT ON prepaid_schedules            TO authenticated;
GRANT SELECT ON prepaid_schedule_segments    TO authenticated;
GRANT SELECT ON prepaid_amortization_postings TO authenticated;

COMMIT;
