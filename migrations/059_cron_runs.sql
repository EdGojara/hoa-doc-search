-- Cron run log
-- Records every automatic job run so the UI can show "last run", admins can
-- audit, and we can debug missed/duplicate fires.

create table if not exists cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  summary jsonb,
  error text,
  triggered_by text default 'scheduler'  -- 'scheduler' | 'manual' (future)
);

create index if not exists idx_cron_runs_job_started
  on cron_runs(job_name, started_at desc);
