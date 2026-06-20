-- ============================================================================
-- 235_recognition_engine.sql
-- ----------------------------------------------------------------------------
-- Revenue/expense recognition engine — the accounting policy Ed wants encoded
-- for every community: a balance-sheet amount is recognized into the income
-- statement over time, automatically, with no human touching a journal.
--
-- TWO mirror-image cases, ONE engine (avoid a silo):
--   prepaid_expense   prepaid ASSET (1400) -> EXPENSE (5605/5610/5615) monthly.
--                     Dr expense, Cr prepaid. (insurance, prepaid contracts)
--   deferred_revenue  unearned LIABILITY (e.g. 2205) -> REVENUE (4000) monthly.
--                     Dr unearned, Cr revenue. (annual assessments earned 1/12)
--
-- Staff upload the document / set up the schedule once; the engine posts every
-- due month. trustEd knows the journal entries.
--
-- Three tables. Record ownership: association_record (the HOA's books).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS recognition_schedules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  schedule_type            TEXT NOT NULL
                             CHECK (schedule_type IN ('prepaid_expense', 'deferred_revenue')),
  description              TEXT NOT NULL,                         -- "Insurance 2025-2026" / "2026 Annual Assessments"
  -- The balance-sheet account being drawn down:
  --   prepaid_expense  -> the prepaid asset (e.g. 1400)
  --   deferred_revenue -> the unearned/deferred liability (e.g. 2205)
  balance_account_number   TEXT NOT NULL,
  source_document_id       UUID REFERENCES library_documents(id) ON DELETE SET NULL,
  recognize_amount_cents   BIGINT NOT NULL CHECK (recognize_amount_cents > 0),  -- total to recognize here
  start_month              DATE NOT NULL,                         -- first month posted (1st of month)
  term_months              INTEGER NOT NULL CHECK (term_months > 0),
  monthly_amount_cents     BIGINT NOT NULL,                       -- per month (last month stubs to exact)
  period_start             DATE,                                  -- underlying policy/fiscal period (info)
  period_end               DATE,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'fully_recognized', 'cancelled')),
  notes                    TEXT,
  record_ownership         TEXT NOT NULL DEFAULT 'association_record',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recog_sched_community ON recognition_schedules(community_id) WHERE status = 'active';

-- The income-statement account(s) the amount is recognized into:
--   prepaid_expense  -> expense accounts (D&O 5605, GL 5610, Other 5615)
--   deferred_revenue -> revenue accounts (Assessment Income 4000)
CREATE TABLE IF NOT EXISTS recognition_schedule_segments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id              UUID NOT NULL REFERENCES recognition_schedules(id) ON DELETE CASCADE,
  income_account_number    TEXT NOT NULL,
  label                    TEXT,
  monthly_amount_cents     BIGINT NOT NULL CHECK (monthly_amount_cents >= 0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recog_seg_schedule ON recognition_schedule_segments(schedule_id);

CREATE TABLE IF NOT EXISTS recognition_postings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id              UUID NOT NULL REFERENCES recognition_schedules(id) ON DELETE CASCADE,
  period_month             DATE NOT NULL,                         -- 1st of the month posted
  journal_entry_id         UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  amount_cents             BIGINT NOT NULL,
  posted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_month)                             -- a month can only post once
);

DROP TRIGGER IF EXISTS trg_recog_sched_updated ON recognition_schedules;
CREATE TRIGGER trg_recog_sched_updated BEFORE UPDATE ON recognition_schedules
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON recognition_schedules          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON recognition_schedule_segments  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON recognition_postings           TO service_role;
GRANT SELECT ON recognition_schedules          TO authenticated;
GRANT SELECT ON recognition_schedule_segments  TO authenticated;
GRANT SELECT ON recognition_postings           TO authenticated;

COMMIT;
