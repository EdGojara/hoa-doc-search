// lib/email/amanda_wake.js  (Issue #29 W1, 2026-10-04)
// ----------------------------------------------------------------------------
// Direct mail to Amanda wakes Amanda. Portfolio mail ingest stays manual (Pull
// inbox; EMAIL_INGEST_AUTO is untouched). This is a narrow deterministic poll of
// ONE mailbox, the Amanda mailbox identity (AMANDA_MAILBOX, amandaalbright@;
// amanda@ is the alias and 404s in Graph), on its own short timer, separate
// from the 15-minute scheduler.
//
// It reuses ingestMailbox, the same pipeline Pull inbox runs, so a new message
// goes through the same classify, the same shared Amanda request contract and
// lands as the same PENDING draft. Nothing is sent from here.
//
// Cost: an empty check is one Graph list call plus one Supabase lookup, and no
// model call (already-processed mail is skipped before any AI work). The lookup
// fails closed inside ingestMailbox. It never files backlog mail (Pull inbox
// does that), and it never waits behind a running ingest of the same mailbox
// (single flight in ingestMailbox; a busy mailbox skips this tick).
//
// OFF by default. AMANDA_WAKE=on turns it on; AMANDA_WAKE_INTERVAL_SEC sets the
// cadence (default 60, minimum 30).
//
// Single instance assumed (lib/scheduler.js header; verified 2026-10-04 by
// sampling /version). During a Render deploy the old and new process can
// overlap for a few seconds; the single-flight guard is per process, so a
// message arriving in that window could be ingested by both. Residual risk,
// documented on PR; dedupe on write (delete-then-insert by internet_message_id)
// keeps one row.
// ----------------------------------------------------------------------------
const LOOKBACK_MAX_MS = 30 * 60 * 1000;   // restart/deploy recovery window
const OVERLAP_MS = 2 * 60 * 1000;         // re-read a little behind the last good poll
const HEARTBEAT_MS = 60 * 60 * 1000;
const JOB = 'amanda_wake';

function intervalMs() {
  const sec = parseInt(process.env.AMANDA_WAKE_INTERVAL_SEC, 10);
  return Math.max(30, Number.isFinite(sec) ? sec : 60) * 1000;
}
const enabled = () => String(process.env.AMANDA_WAKE || '').toLowerCase() === 'on';

// The window to read: from a little before the last good poll, never further back than 30 min.
function windowStart(lastOkAt, now = Date.now()) {
  const floor = now - LOOKBACK_MAX_MS;
  return new Date(lastOkAt ? Math.max(floor, lastOkAt - OVERLAP_MS) : floor).toISOString();
}

function createAmandaWake(deps = {}) {
  const ingest = deps.ingestMailbox || ((mbx, o) => require('./graph_ingest').ingestMailbox(mbx, o));
  const configured = deps.isConfigured || (() => require('./graph_send').isConfigured());
  const mailbox = deps.mailbox || require('./graph_send').AMANDA_MAILBOX;
  const supabase = deps.supabase || null;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const state = { lastOkAt: null, polls: 0, empty: 0, busy: 0, kept: 0, errors: 0, lastHeartbeat: now() };

  // Recorded only when a poll took in new mail or failed; empty minutes leave no row.
  async function record(startedAt, ok, summary, error) {
    const sb = supabase || (() => { try { return require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); } catch (_) { return null; } })();
    if (!sb) return;
    try {
      const { error: e } = await sb.from('cron_runs').insert({ job_name: JOB, started_at: new Date(startedAt).toISOString(), finished_at: new Date(now()).toISOString(),
        ok, summary, error: error || null, triggered_by: JOB });
      if (e) log.warn('[amanda_wake] cron_runs insert failed:', e.message);
    } catch (e) { log.warn('[amanda_wake] cron_runs insert threw:', e.message); }
  }

  async function pollOnce() {
    if (!configured()) return { skipped: 'graph_not_configured' };
    const startedAt = now();
    const sinceISO = windowStart(state.lastOkAt, startedAt);
    state.polls += 1;
    let stats;
    try {
      stats = await ingest(mailbox, { sinceISO, light: false, onlyLinked: false, max: 50, fileBacklog: false, skipIfBusy: true });
    } catch (e) {
      state.errors += 1;
      log.error('[amanda_wake] poll failed (nothing processed past the failure):', e.message);
      await record(startedAt, false, { mailbox, since: sinceISO }, String(e.message || e).slice(0, 500));
      return { error: e.message };
    }
    if (stats && stats.busy) { state.busy += 1; return { busy: true }; }   // a Pull inbox is already ingesting this mailbox
    state.lastOkAt = startedAt;
    if (stats && stats.kept > 0) {
      state.kept += stats.kept;
      log.log(`[amanda_wake] ${mailbox}: ${stats.kept} new message(s) ingested`);
      await record(startedAt, true, { mailbox, since: sinceISO, ...stats }, null);
    } else state.empty += 1;
    return { stats };
  }

  function heartbeat() {
    if (now() - state.lastHeartbeat < HEARTBEAT_MS) return;
    log.log(`[amanda_wake] heartbeat: ${state.polls} polls, ${state.empty} empty, ${state.kept} ingested, ${state.busy} busy, ${state.errors} errors`);
    Object.assign(state, { polls: 0, empty: 0, busy: 0, kept: 0, errors: 0, lastHeartbeat: now() });
  }

  let running = false;
  async function tick() {
    if (running) return { skipped: 'running' };
    running = true;
    try { return await pollOnce(); } finally { running = false; heartbeat(); }
  }
  return { tick, pollOnce, state, mailbox };
}

let _timer = null;
function startAmandaWake(deps = {}) {
  if (!enabled()) { console.log('[amanda_wake] off (set AMANDA_WAKE=on to wake Amanda on new mail)'); return null; }
  if (_timer) return _timer;
  const wake = createAmandaWake(deps);
  const ms = intervalMs();
  console.log(`[amanda_wake] on: polling ${wake.mailbox} every ${ms / 1000}s`);
  _timer = setInterval(() => { wake.tick().catch((e) => console.error('[amanda_wake] tick threw:', e.message)); }, ms);
  if (_timer.unref) _timer.unref();
  return _timer;
}

module.exports = { startAmandaWake, createAmandaWake, windowStart, intervalMs, enabled, JOB };
