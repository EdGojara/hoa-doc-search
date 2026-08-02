-- ===========================================================================
-- 346_ea_standing_tasks.sql
-- ---------------------------------------------------------------------------
-- Tessa's standing instructions — recurring emails Ed sets up once and she sends
-- on schedule without being re-asked ("remind the team the first of every month
-- to set their out-of-office"). The scheduler's tessa_standing job runs once a
-- day and fires any task that's due (daily / weekly on a weekday / monthly on a
-- day-of-month), sending as Tessa (or Ed), logging each send to the Sent view.
--
-- Record ownership: WORKPAPER (Bedrock's internal EA automation). Owner-only.
-- ===========================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS ea_standing_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,                       -- "Monthly OOO reminder to the team"
  recipients_spec  TEXT NOT NULL DEFAULT 'custom',      -- 'team' (all active staff) | 'custom'
  to_emails        TEXT,                                -- comma list, used when spec='custom'
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'tessa',        -- 'tessa' | 'ed'
  freq             TEXT NOT NULL DEFAULT 'monthly'
                   CHECK (freq IN ('daily', 'weekly', 'monthly')),
  day_of_week      SMALLINT,                            -- 0=Sun..6=Sat (weekly)
  day_of_month     SMALLINT,                            -- 1..28 (monthly)
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at      TIMESTAMPTZ,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ea_standing_active ON ea_standing_tasks (active) WHERE active;

DROP TRIGGER IF EXISTS trg_ea_standing_updated_at ON ea_standing_tasks;
CREATE TRIGGER trg_ea_standing_updated_at
  BEFORE UPDATE ON ea_standing_tasks
  FOR EACH ROW EXECUTE FUNCTION trusted_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ea_standing_tasks TO service_role;
GRANT SELECT                          ON ea_standing_tasks TO authenticated;

COMMIT;
