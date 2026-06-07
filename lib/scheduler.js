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
const { sendArMonthlyReminderIfDue } = require('./notifications/ar_reminder');

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

// Heuristic: did this job summary represent meaningful work? Used to
// decide whether to log to stdout (versus just persisting to cron_runs
// silently). The pattern below covers every existing job's summary
// shape. New jobs can add their own field names — when in doubt, the
// default of "log if anything looks non-zero / true" errs on the side
// of visibility.
function _summaryDidWork(summary) {
  if (!summary || typeof summary !== 'object') return false;
  // Explicit "did nothing" markers
  if (summary.fired === false) return false;
  if (summary.ok === false) return true; // failures are work — log them
  // Look for any positive integer field — closed, indexed, processed,
  // applied, fixed, sent, drafted, escalated, flipped, etc.
  for (const v of Object.values(summary)) {
    if (typeof v === 'number' && v > 0) return true;
    if (typeof v === 'boolean' && v === true && v !== summary.ok) return true;
  }
  // budget_hit / errors → log even if no other work surfaced
  if (summary.budget_hit) return true;
  if (Array.isArray(summary.errors) && summary.errors.length > 0) return true;
  return false;
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
    // Per-job opt-in (Ed 2026-06-08): the platform is young and most
    // background jobs have no real work yet. Default behavior: jobs only
    // run when explicitly enabled via SCHEDULER_ENABLED env var
    // (comma-separated list of job names), OR when SCHEDULER_ENABLED='all'.
    // If SCHEDULER_ENABLED is unset, NO jobs run — most conservative
    // posture for a low-volume platform.
    //
    // Example Render config:
    //   SCHEDULER_ENABLED=stale_inspection_close
    //   SCHEDULER_ENABLED=stale_inspection_close,cure_lapse
    //   SCHEDULER_ENABLED=all
    const allowList = String(process.env.SCHEDULER_ENABLED || '').trim();
    const allEnabled = allowList === 'all' || allowList === '*';
    const enabledNames = allEnabled
      ? null
      : new Set(allowList.split(',').map((s) => s.trim()).filter(Boolean));
    const enabled = allEnabled || (enabledNames && enabledNames.has(name));
    if (!enabled) {
      this.logger.log(`[scheduler] job '${name}' SKIPPED — not in SCHEDULER_ENABLED allowlist`);
      return; // job not registered at all
    }
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
      const summary = await job.run();
      const finishedAt = new Date().toISOString();
      if (runId) {
        await this.supabase.from('cron_runs').update({
          finished_at: finishedAt, ok: true, summary,
        }).eq('id', runId);
      }
      // Quiet mode (Ed 2026-06-08): only log when the job actually did
      // something meaningful. Most ticks find empty queues and return
      // {closed:0} / {indexed:0} / {fired:false} — those should be
      // silent because Ed correctly noted nothing's running yet and the
      // log noise made the platform look busier than it is.
      //
      // Set SCHEDULER_VERBOSE=true on Render to restore the old behavior.
      if (_summaryDidWork(summary) || process.env.SCHEDULER_VERBOSE === 'true') {
        this.logger.log(`[scheduler:${job.name}] firing…`);
        this.logger.log(`[scheduler:${job.name}] ok —`, JSON.stringify(summary).slice(0, 300));
      }
      // Cron_runs row is ALWAYS recorded regardless of verbosity — the
      // admin UI / audit trail uses that, not log output. We're only
      // changing what hits stdout, not what gets persisted.
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

  // Monthly Owner-AR cadence reminder — daily fire at 09:00 Central, but the
  // run function itself no-ops unless today is the 3rd of the month. Keeps
  // the scheduler framework simple (no monthly mode needed); the day-of-month
  // gate lives inside the run. See lib/notifications/ar_reminder.js.
  scheduler.register({
    name: 'ar_monthly_reminder',
    targetHour: 9,
    run: () => sendArMonthlyReminderIfDue({ supabase }),
  });

  // Messaging SLA tick (Ed 2026-06-04 design): every 2 hours, flip threads
  // to yellow/red/overdue based on first_response_due_at, auto-close
  // closure_pending threads after 24h homeowner silence. Bezos's "mechanisms
  // not good intentions" — but starting LOOSE on cadence + thresholds so the
  // team isn't discouraged by metrics they can't reach. Tightens over time as
  // performance proves the baseline. Tunable via thresholds in sla_engine.js.
  const { runSlaTick } = require('./messaging/sla_engine');
  scheduler.register({
    name: 'messaging_sla_tick',
    minIntervalMin: 120,   // every 2 hours
    run: () => runSlaTick(),
  });

  // Stale-inspection auto-close: every 2 hours, find inspections that have
  // been status='in_progress' but haven't had a GPS ping in N hours (default
  // 4) and mark them status='captured' with ended_at=last_ping_at. Catches
  // the 'operator forgot to click End drive' case — without this, in_progress
  // rows accumulate forever and pollute the Active Drives banner + queries.
  scheduler.register({
    name: 'stale_inspection_close',
    minIntervalMin: 120,
    run: async () => {
      const staleHours = Number(process.env.INSPECTION_STALE_HOURS || 4);
      const cutoffIso = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
      const { data: stale, error } = await supabase
        .from('inspections')
        .select('id, started_at, last_ping_at, community_id, mode')
        .eq('status', 'in_progress')
        .or(`last_ping_at.lt.${cutoffIso},and(last_ping_at.is.null,started_at.lt.${cutoffIso})`)
        .limit(200);
      if (error) {
        return { ok: false, error: error.message };
      }
      if (!stale || stale.length === 0) {
        return { ok: true, closed: 0 };
      }
      const ids = stale.map(s => s.id);
      // Use last_ping_at as ended_at when available; fall back to started_at
      // + staleHours so the audit trail makes sense. Do it per-row since each
      // has different timestamps.
      let closed = 0;
      for (const s of stale) {
        const endedAt = s.last_ping_at
          || new Date(new Date(s.started_at).getTime() + staleHours * 60 * 60 * 1000).toISOString();
        const { error: upErr } = await supabase
          .from('inspections')
          .update({
            status: 'captured',
            ended_at: endedAt,
            notes: `Auto-closed by stale_inspection_close after ${staleHours}h of no GPS pings. Inspector tablet may have closed without End being tapped.`,
          })
          .eq('id', s.id);
        if (!upErr) closed += 1;
      }
      return { ok: true, closed, found: stale.length, cutoff_hours: staleHours };
    },
  });

  scheduler.start();
  return scheduler;
}

module.exports = { startScheduler, Scheduler };
