// In-process scheduler — runs daily jobs without a separate cron service.
//
// Why in-process: Ed's Render web service stays warm (paid plan), single
// instance. An external cron job (Render Cron, GitHub Actions) is more
// moving parts than this scale needs. If we ever scale to multiple web
// instances we'll either lift this into a worker service or add a row-lock
// on cron_runs to elect a single firer — neither problem today.
//
// Design:
//   - Tick every 15 minutes
//   - For each job: if Central-time hour ≥ target_hour AND we haven't
//     successfully run today (Central calendar day), fire it
//   - Each run is logged to cron_runs (started_at, finished_at, ok, summary)
//   - Same logic re-checks history on every tick, so a restart mid-day
//     won't double-fire (already-ran-today check) and won't miss the day
//     (will fire on the next tick after target_hour)

const { createClient } = require('@supabase/supabase-js');
const { processCureLapses, processPostcardReminders } = require('../api/enforcement');

const TICK_MS = 15 * 60 * 1000;
const CENTRAL_TZ = 'America/Chicago';

// Returns { year, month, day, hour } in America/Chicago for the given Date.
function centralParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// Returns the ISO start-of-day in Central for a given (year, month, day).
// Used to query cron_runs.started_at >= today_central_midnight_utc.
function centralMidnightUtc(year, month, day) {
  // Easier: construct a naive ISO at the central date, then ask the same
  // formatter what UTC instant maps to "central midnight" of that date.
  // Pragmatic: just probe with a known UTC and shift. Range: CT is UTC-5/-6.
  // Safest: build a date at UTC and walk backwards until centralParts says
  // hour=0 of (year, month, day). Cheap — runs once per tick at most.
  const guess = new Date(Date.UTC(year, month - 1, day, 5, 0, 0)); // 05:00 UTC ~ midnight CDT/CST
  for (let i = -2; i <= 2; i++) {
    const probe = new Date(guess.getTime() + i * 60 * 60 * 1000);
    const cp = centralParts(probe);
    if (cp.year === year && cp.month === month && cp.day === day && cp.hour === 0) {
      return probe.toISOString();
    }
  }
  return guess.toISOString(); // fallback — within an hour of correct
}

class Scheduler {
  constructor({ supabase, logger = console }) {
    this.supabase = supabase;
    this.logger = logger;
    this.jobs = [];
    this.timer = null;
    this.running = new Set();
  }

  register({ name, targetHour, run }) {
    this.jobs.push({ name, targetHour, run });
  }

  start() {
    if (this.timer) return;
    this.tick().catch((e) => this.logger.error('[scheduler.tick]', e));
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.logger.error('[scheduler.tick]', e));
    }, TICK_MS);
    this.logger.log(`[scheduler] started — ${this.jobs.length} job(s), tick=${TICK_MS / 60000}min`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const cp = centralParts();
    for (const job of this.jobs) {
      if (this.running.has(job.name)) continue;
      if (cp.hour < job.targetHour) continue;

      const todayStart = centralMidnightUtc(cp.year, cp.month, cp.day);
      const { data: existing, error: chkErr } = await this.supabase
        .from('cron_runs')
        .select('id, ok, started_at')
        .eq('job_name', job.name)
        .gte('started_at', todayStart)
        .order('started_at', { ascending: false })
        .limit(1);

      if (chkErr) {
        this.logger.warn(`[scheduler:${job.name}] check failed:`, chkErr.message);
        continue;
      }
      if (existing && existing.length > 0 && existing[0].ok) continue;

      this.running.add(job.name);
      this.runJob(job).finally(() => this.running.delete(job.name));
    }
  }

  async runJob(job) {
    const startedAt = new Date().toISOString();
    let runId = null;
    try {
      const { data: ins } = await this.supabase
        .from('cron_runs')
        .insert({ job_name: job.name, started_at: startedAt, triggered_by: 'scheduler' })
        .select('id')
        .single();
      runId = ins && ins.id;
    } catch (e) {
      this.logger.warn(`[scheduler:${job.name}] could not log run start:`, e.message);
    }

    try {
      this.logger.log(`[scheduler:${job.name}] firing…`);
      const summary = await job.run();
      const finishedAt = new Date().toISOString();
      if (runId) {
        await this.supabase.from('cron_runs').update({
          finished_at: finishedAt, ok: true, summary,
        }).eq('id', runId);
      }
      this.logger.log(`[scheduler:${job.name}] ok —`, JSON.stringify(summary).slice(0, 300));
    } catch (err) {
      const finishedAt = new Date().toISOString();
      this.logger.error(`[scheduler:${job.name}] failed:`, err.message);
      if (runId) {
        await this.supabase.from('cron_runs').update({
          finished_at: finishedAt, ok: false, error: err.message,
        }).eq('id', runId);
      }
    }
  }
}

function startScheduler({ logger = console } = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    logger.warn('[scheduler] SUPABASE_URL/KEY missing — scheduler disabled');
    return null;
  }
  if (process.env.SCHEDULER_DISABLED === 'true') {
    logger.log('[scheduler] disabled via SCHEDULER_DISABLED=true');
    return null;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const scheduler = new Scheduler({ supabase, logger });

  // Cure-lapse processor — fires at 06:00 Central daily.
  scheduler.register({
    name: 'cure_lapse',
    targetHour: 6,
    run: () => processCureLapses({ limit: 200 }),
  });

  // Postcard reminder processor — fires at 06:00 Central daily. Drafts
  // mid-window reminder postcards for courtesy_1 violations whose
  // courtesy_1 letter was mailed N days ago and whose cure window is
  // still open. Per-community N (default 7) on communities.postcard_reminder_days.
  scheduler.register({
    name: 'postcard_reminders',
    targetHour: 6,
    run: () => processPostcardReminders({ limit: 200 }),
  });

  scheduler.start();
  return scheduler;
}

module.exports = { startScheduler, Scheduler };
