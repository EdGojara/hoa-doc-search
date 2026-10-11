-- ============================================================================
-- 510_accounting_runs.sql  (Ed 2026-10-11)
-- ----------------------------------------------------------------------------
-- Kat's controlled monthly accounting runs. One framework for the routine
-- entries trustEd originates every month (Ed: trustEd is the system of record
-- from the GL cutover; Vantaca only collects payments):
--   recognition  the approved recognition schedules (assessment revenue, CLMA,
--                prepaid insurance, ...) via lib/accounting/recognition_engine
--   interest     monthly late interest on eligible assessment principal on the
--                tenure-aware homeowner ledger (lib/ar/monthly_interest.js)
--
-- Controls:
--   * community_accounting_automation: per community + process, OFF by default.
--     enabled = Kat prepares the month; auto_post = posting without a person
--     (OFF; Ed approves every run until reliability is shown).
--   * accounting_runs: one live run per community + process + month (partial
--     unique index); prepared -> approved -> posted, or held / failed. The
--     preview (every proposed entry, owner by owner for interest), totals and
--     exceptions are stored on the run, so what was approved is what posts.
--   * accounting_run_events: append-only audit trail (prepared, approved, held,
--     posted, failed) with actor and detail. Never updated or deleted.
--
-- Record ownership: accounting_runs / accounting_run_events are `mixed` (the
-- posted entries they produce are association_record and live in the GL and
-- homeowner ledger; the previews and Kat's working notes are workpaper);
-- community_accounting_automation is workpaper (Bedrock configuration).
-- Seeds Canyon Gate at Cinco Ranch only: both processes enabled, auto_post off.
-- No journal entry, ledger row or balance is created or changed.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS community_accounting_automation (
  community_id  uuid NOT NULL CONSTRAINT community_accounting_automation_community_fkey REFERENCES communities(id) ON DELETE RESTRICT,
  process       text NOT NULL CONSTRAINT community_accounting_automation_process_check CHECK (process IN ('recognition', 'interest')),
  enabled       boolean NOT NULL DEFAULT false,
  auto_post     boolean NOT NULL DEFAULT false,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_accounting_automation_pkey PRIMARY KEY (community_id, process)
);

CREATE TABLE IF NOT EXISTS accounting_runs (
  id             uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT accounting_runs_pkey PRIMARY KEY,
  community_id   uuid NOT NULL CONSTRAINT accounting_runs_community_fkey REFERENCES communities(id) ON DELETE RESTRICT,
  process        text NOT NULL CONSTRAINT accounting_runs_process_check CHECK (process IN ('recognition', 'interest')),
  period_month   date NOT NULL CONSTRAINT accounting_runs_period_check CHECK (extract(day FROM period_month) = 1),
  run_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'prepared' CONSTRAINT accounting_runs_status_check CHECK (status IN ('prepared', 'approved', 'posted', 'held', 'failed', 'superseded')),
  preview        jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals         jsonb NOT NULL DEFAULT '{}'::jsonb,
  exceptions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  prepared_by    text NOT NULL,
  prepared_at    timestamptz NOT NULL DEFAULT now(),
  approved_by    text,
  approved_at    timestamptz,
  posted_by      text,
  posted_at      timestamptz,
  result         jsonb,
  held_reason    text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_runs_approved_check CHECK (status NOT IN ('approved', 'posted') OR approved_by IS NOT NULL),
  CONSTRAINT accounting_runs_posted_check CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND result IS NOT NULL)),
  CONSTRAINT accounting_runs_held_check CHECK (status <> 'held' OR coalesce(btrim(held_reason), '') <> ''),
  CONSTRAINT accounting_runs_failed_check CHECK (status <> 'failed' OR coalesce(btrim(error), '') <> '')
);
-- One live run per community + process + month: a second prepare for the same
-- month is refused; a held or failed run must be superseded before a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_runs_live
  ON accounting_runs (community_id, process, period_month)
  WHERE status IN ('prepared', 'approved', 'posted', 'held', 'failed');
CREATE INDEX IF NOT EXISTS ix_accounting_runs_community ON accounting_runs (community_id, period_month DESC);

-- A posted run is final: only its own bookkeeping columns may never change again.
CREATE OR REPLACE FUNCTION accounting_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'accounting runs are permanent (run %)', OLD.id; END IF;
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'a posted accounting run is final (run %)', OLD.id; END IF;
  IF OLD.status = 'superseded' THEN RAISE EXCEPTION 'a superseded accounting run is final (run %)', OLD.id; END IF;
  IF NEW.preview IS DISTINCT FROM OLD.preview OR NEW.totals IS DISTINCT FROM OLD.totals OR NEW.period_month IS DISTINCT FROM OLD.period_month
     OR NEW.community_id IS DISTINCT FROM OLD.community_id OR NEW.process IS DISTINCT FROM OLD.process THEN
    RAISE EXCEPTION 'what was prepared cannot be edited; supersede the run and prepare a new one (run %)', OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_accounting_runs_guard ON accounting_runs;
CREATE TRIGGER trg_accounting_runs_guard BEFORE UPDATE OR DELETE ON accounting_runs FOR EACH ROW EXECUTE FUNCTION accounting_runs_guard();

CREATE TABLE IF NOT EXISTS accounting_run_events (
  id          uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT accounting_run_events_pkey PRIMARY KEY,
  run_id      uuid NOT NULL CONSTRAINT accounting_run_events_run_fkey REFERENCES accounting_runs(id) ON DELETE RESTRICT,
  event       text NOT NULL CONSTRAINT accounting_run_events_event_check CHECK (event IN ('prepared', 'approved', 'held', 'posting', 'posted', 'failed', 'superseded', 'note')),
  actor       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_accounting_run_events_run ON accounting_run_events (run_id, created_at);
CREATE OR REPLACE FUNCTION accounting_run_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'accounting run events are permanent (event %)', OLD.id; END;
$fn$;
DROP TRIGGER IF EXISTS trg_accounting_run_events_append_only ON accounting_run_events;
CREATE TRIGGER trg_accounting_run_events_append_only BEFORE UPDATE OR DELETE ON accounting_run_events FOR EACH ROW EXECUTE FUNCTION accounting_run_events_append_only();

GRANT SELECT, INSERT, UPDATE, DELETE ON community_accounting_automation TO service_role;
GRANT SELECT, INSERT, UPDATE ON accounting_runs TO service_role;
GRANT SELECT, INSERT ON accounting_run_events TO service_role;

-- Canyon Gate at Cinco Ranch only. Interest settings from the Declaration
-- (Art. VI Sec 8: 10% per annum on an assessment unpaid 30 days after its due
-- date; assessment principal only). due_offset_days: days from the assessment
-- charge date to its due date (0 = due on the billing date).
INSERT INTO community_accounting_automation (community_id, process, enabled, auto_post, settings, updated_by)
SELECT 'a0000000-0000-4000-8000-000000000003', p.process, true, false, p.settings, 'Migration 510 (Ed 2026-10-11)'
FROM (VALUES
  ('recognition', '{}'::jsonb),
  ('interest', '{"rate_bps": 1000, "grace_days": 30, "due_offset_days": 0, "income_account_number": "4030"}'::jsonb)
) AS p(process, settings)
WHERE EXISTS (SELECT 1 FROM communities WHERE id = 'a0000000-0000-4000-8000-000000000003')
ON CONFLICT (community_id, process) DO NOTHING;

COMMIT;
