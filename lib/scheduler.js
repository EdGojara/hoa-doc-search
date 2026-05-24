// In-process scheduler — runs jobs without a separate cron service.
//
// Why in-process: Ed's Render web service stays warm (paid plan), single
// instance. An external cron job (Render Cron, GitHub Actions) is more
// moving parts than this scale needs. If we ever scale to multiple web
// instances we'll either lift this into a worker service or add a row-lock
// on cron_runs to elect a single firer — neither problem today.
//
// Design:
//   - Tick every 15 minutes
//   - Two firing modes per job:
//       (a) Daily mode (targetHour set, minIntervalMin unset): fire once
//           per Central calendar day after the targetHour, only if no
//           successful run exists yet today. Used for one-shot jobs like
//           cure_lapse and postcard_reminders that have a daily semantic.
//       (b) Poll mode (minIntervalMin set, targetHour optional): fire
//           whenever no run has STARTED in the last minIntervalMin minutes.
//           Used for queue-drainers like documents_auto_reindex where new
//           work arrives continuously and waiting until tomorrow leaves
//           recent uploads invisible to askEd for hours.
//   - Each run is logged to cron_runs (started_at, finished_at, ok, summary).
//   - `this.running` in-memory guard prevents the 15-min tick from double-
//     firing a long-running job that's still in flight.

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { processCureLapses, processPostcardReminders } = require('../api/enforcement');
const { drainUnindexedQueue } = require('../api/documents');

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

  register({ name, targetHour, minIntervalMin, run }) {
    this.jobs.push({ name, targetHour, minIntervalMin, run });
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
    const now = new Date();
    const cp = centralParts(now);
    for (const job of this.jobs) {
      if (this.running.has(job.name)) continue;

      // Earliest-start gate: a targetHour means the job can't start before
      // that Central-time hour. Poll-mode jobs can omit this for 24/7 firing.
      if (job.targetHour != null && cp.hour < job.targetHour) continue;

      // Refire gate. Two modes — see the design comment at top of file.
      let lookbackIso;
      let pollMode = false;
      if (job.minIntervalMin) {
        lookbackIso = new Date(now.getTime() - job.minIntervalMin * 60000).toISOString();
        pollMode = true;
      } else {
        lookbackIso = centralMidnightUtc(cp.year, cp.month, cp.day);
      }

      const { data: existing, error: chkErr } = await this.supabase
        .from('cron_runs')
        .select('id, ok, started_at')
        .eq('job_name', job.name)
        .gte('started_at', lookbackIso)
        .order('started_at', { ascending: false })
        .limit(1);

      if (chkErr) {
        this.logger.warn(`[scheduler:${job.name}] check failed:`, chkErr.message);
        continue;
      }
      if (existing && existing.length > 0) {
        if (pollMode) continue;                       // any recent run blocks refire
        if (existing[0].ok) continue;                 // daily mode: today's success blocks
      }

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
  const schedulerDisabled = (() => {
    const v = String(process.env.SCHEDULER_DISABLED || '').trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1' || v === 'on';
  })();
  if (schedulerDisabled) {
    logger.log('[scheduler] disabled via SCHEDULER_DISABLED env var');
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

  // Auto-reindex unindexed library docs — fires at 05:00 Central daily.
  // Catches docs whose synchronous auto-index on upload failed (OpenAI
  // hiccup, weird PDF, timeout) so they end up searchable by morning
  // without anyone clicking a button. Operator never sees the
  // 'NOT indexed' purgatory unless something catastrophic happens.
  if (process.env.OPENAI_API_KEY) {
    const openaiForReindex = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    scheduler.register({
      name: 'documents_auto_reindex',
      // Poll mode: fire whenever N+ minutes have passed since the last run
      // started. Default 120 (every 2 hours) — for Bedrock's actual upload
      // rate this is plenty fresh (uploads searchable within ~2-3 hrs)
      // without burning 48 cycles/day on mostly-empty queue checks. Tune
      // via REINDEX_INTERVAL_MIN env var if usage pattern changes.
      //
      // Originally set to 30 (every 30 min, 48 cycles/day) — that was an
      // overcorrection from the daily-only baseline. Dialed back 2026-05-24
      // after Ed flagged the cycle count vs. actual upload rate.
      //
      // No targetHour — uploads at any hour are searchable within the
      // poll interval. Upstream is async-upload (api/documents.js marks
      // new docs as index_status='pending').
      minIntervalMin: Number(process.env.REINDEX_INTERVAL_MIN || 120),
      // 60-min budget + 500-doc cap. Running-guard prevents the 15-min tick
      // from double-firing a long run. Per-doc time is dominated by Claude
      // vision transcription of form-field / scanned PDFs (~30-90s each) —
      // see lib/ocr_pdf.js.
      run: () => drainUnindexedQueue({ supabase, openai: openaiForReindex, maxDocs: 500, budgetMs: 60 * 60 * 1000 }),
    });
  } else {
    logger.warn('[scheduler] OPENAI_API_KEY missing — documents_auto_reindex job not registered');
  }

  scheduler.start();
  return scheduler;
}

module.exports = { startScheduler, Scheduler };
