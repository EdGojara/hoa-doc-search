// ============================================================================
// lib/meetings/pipeline.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Background processing for a VERIFIED meeting recording session:
//   assemble -> transcribe -> analyze -> ready for review
//
// The durable queue is meeting_processing_jobs (migration 448). An in-process
// worker claims one job at a time with a LEASE (lease_expires_at) and renews it
// while a stage runs. If the server restarts mid-stage, nothing is lost: the
// lease simply expires and the next worker tick re-runs that stage. Every
// stage is idempotent (it rebuilds its own output), so re-running is safe.
//
// Failures: a stage that throws is retried automatically with backoff (a
// Deepgram or network hiccup should not need a person). After MAX_ATTEMPTS, or
// at once for a permanent error (err.permanent, e.g. the session is not
// verified), the job stops as 'failed' with failed_stage + last_error. Retry
// resumes from THAT stage; earlier stages' outputs are kept.
// ============================================================================
const os = require('os');
const crypto = require('crypto');

const STAGE_ORDER = ['assemble', 'transcribe', 'analyze'];
const LEASE_MS = 5 * 60 * 1000;
const RENEW_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const TICK_MS = 15 * 1000;

class PermanentError extends Error { constructor(msg) { super(msg); this.permanent = true; } }

function createPipeline({ supabase, handlers, owner, leaseMs = LEASE_MS, renewMs = RENEW_MS, maxAttempts = MAX_ATTEMPTS, backoffMs = (n) => Math.min(10 * 60000, 30000 * 2 ** (n - 1)), log = console }) {
  const me = owner || `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
  const stages = STAGE_ORDER.filter((s) => typeof handlers[s] === 'function');
  let busy = false, timer = null;

  const nowIso = () => new Date().toISOString();
  async function patchJob(id, patch) {
    const { data, error } = await supabase.from('meeting_processing_jobs').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  }
  // Writes made while running a stage only land if THIS worker still holds the
  // lease. A worker that stalled past its lease (and was replaced) must not
  // overwrite the newer worker's result when it finally wakes up.
  class LeaseLost extends Error {}
  async function patchOwned(id, patch) {
    const { data, error } = await supabase.from('meeting_processing_jobs').update(patch).eq('id', id).eq('lease_owner', me).select('*');
    if (error) throw error;
    if (!data || !data[0]) throw new LeaseLost(`job ${id}: lease lost to another worker`);
    return data[0];
  }
  const stageInfo = (job, s) => ({ ...(job.stages && job.stages[s]) });

  /** Queue a session. Only server-verified sessions are accepted. */
  async function enqueue(sessionId, userId) {
    const { data: s, error } = await supabase.from('meeting_recording_sessions').select('id, meeting_id, community_id, status').eq('id', sessionId).maybeSingle();
    if (error) throw error;
    if (!s) return { status: 404, body: { error: 'session_not_found' } };
    if (s.status !== 'verified') return { status: 409, body: { error: 'session_not_verified', session_status: s.status, hint: 'Only recordings Trusted has verified as complete can be processed.' } };
    const { data: ex, error: exErr } = await supabase.from('meeting_processing_jobs').select('*').eq('session_id', sessionId).maybeSingle();
    if (exErr) throw exErr;
    if (ex) return { status: 200, body: { job: ex, existing: true } };
    const { data: job, error: insErr } = await supabase.from('meeting_processing_jobs').insert({
      session_id: s.id, meeting_id: s.meeting_id, community_id: s.community_id, status: 'queued', current_stage: stages[0], requested_by_user_id: userId || null,
      stages: Object.fromEntries(stages.map((x) => [x, { status: 'pending', attempts: 0 }])),
    }).select('*').single();
    if (insErr) {
      if (insErr.code === '23505') { const { data: again } = await supabase.from('meeting_processing_jobs').select('*').eq('session_id', sessionId).maybeSingle(); if (again) return { status: 200, body: { job: again, existing: true } }; }
      throw insErr;
    }
    kick();
    return { status: 201, body: { job, existing: false } };
  }

  /** Retry a failed job from the stage that failed (or re-run a named stage and everything after it). */
  async function retry(jobId, { fromStage } = {}) {
    const { data: job, error } = await supabase.from('meeting_processing_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw error;
    if (!job) return { status: 404, body: { error: 'job_not_found' } };
    if (fromStage && !stages.includes(fromStage)) return { status: 400, body: { error: 'invalid_stage' } };
    if (!fromStage && job.status !== 'failed') return { status: 409, body: { error: 'job_not_failed', job_status: job.status } };
    if (job.status === 'running' && job.lease_expires_at && Date.parse(job.lease_expires_at) > Date.now()) return { status: 409, body: { error: 'job_running' } };
    const start = fromStage || job.failed_stage || job.current_stage;
    const st = { ...(job.stages || {}) };
    for (const x of stages.slice(stages.indexOf(start))) st[x] = { ...(st[x] || {}), status: 'pending', attempts: 0, error: null };
    const upd = await patchJob(job.id, { status: 'queued', current_stage: start, failed_stage: null, last_error: null, attempts: 0, next_attempt_at: null, lease_owner: null, lease_expires_at: null, stages: st });
    kick();
    return { status: 200, body: { job: upd } };
  }

  // Claim: only a job whose lease is free or expired. The .or() on the lease
  // makes the claim atomic (a second worker's update matches no row).
  async function claimNext() {
    const now = nowIso();
    const { data, error } = await supabase.from('meeting_processing_jobs').select('*').in('status', ['queued', 'running']).order('created_at').limit(20);
    if (error) throw error;
    for (const j of data || []) {
      if (j.lease_expires_at && Date.parse(j.lease_expires_at) > Date.now()) continue;
      if (j.next_attempt_at && Date.parse(j.next_attempt_at) > Date.now()) continue;
      const { data: got, error: cErr } = await supabase.from('meeting_processing_jobs')
        .update({ status: 'running', lease_owner: me, lease_expires_at: new Date(Date.now() + leaseMs).toISOString() })
        .eq('id', j.id).or(`lease_expires_at.is.null,lease_expires_at.lt.${now}`).select('*');
      if (cErr) throw cErr;
      if (got && got[0]) return { job: got[0], resumed: j.status === 'running' };
    }
    return null;
  }

  async function runJob(job, resumed) {
    if (resumed) log.warn && log.warn(`[meeting-pipeline] resuming job ${job.id} at stage ${job.current_stage} (previous worker's lease expired)`);
    let cur = job;
    while (stages.includes(cur.current_stage)) {
      const stage = cur.current_stage;
      const info = stageInfo(cur, stage);
      cur = await patchOwned(cur.id, { stages: { ...cur.stages, [stage]: { ...info, status: 'running', started_at: nowIso(), attempts: (info.attempts || 0) + 1, resumed_after_restart: resumed || undefined, error: null } } });
      resumed = false;
      const renew = setInterval(() => {
        supabase.from('meeting_processing_jobs').update({ lease_expires_at: new Date(Date.now() + leaseMs).toISOString() }).eq('id', cur.id).eq('lease_owner', me)
          .then(({ error }) => { if (error) log.warn && log.warn('[meeting-pipeline] lease renew failed: ' + error.message); });
      }, renewMs);
      let result;
      try {
        result = await handlers[stage]({ job: cur, supabase });
      } catch (err) {
        clearInterval(renew);
        const attempts = (cur.attempts || 0) + 1;
        const giveUp = err.permanent || attempts >= maxAttempts;
        const msg = String((err && err.message) || err).slice(0, 1000);
        log.error && log.error(`[meeting-pipeline] ${stage} failed for job ${cur.id} (attempt ${attempts}${giveUp ? ', giving up' : ''}): ${msg}`);
        const st = { ...cur.stages, [stage]: { ...stageInfo(cur, stage), status: giveUp ? 'failed' : 'retrying', error: msg, finished_at: nowIso() } };
        await patchOwned(cur.id, giveUp
          ? { status: 'failed', failed_stage: stage, last_error: msg, attempts, lease_owner: null, lease_expires_at: null, next_attempt_at: null, stages: st }
          : { status: 'queued', attempts, last_error: msg, lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(), stages: st });
        return;
      }
      clearInterval(renew);
      const next = stages[stages.indexOf(stage) + 1] || 'done';
      cur = await patchOwned(cur.id, {
        current_stage: next, attempts: 0, last_error: null,
        stages: { ...cur.stages, [stage]: { ...stageInfo(cur, stage), status: 'done', finished_at: nowIso(), error: null, result: result || null } },
        ...(next === 'done' ? { status: 'ready', lease_owner: null, lease_expires_at: null } : { lease_expires_at: new Date(Date.now() + leaseMs).toISOString() }),
      });
    }
  }

  /** One worker pass: run every claimable job, one at a time. */
  async function tick() {
    if (busy) return 0;
    busy = true;
    let n = 0;
    try {
      for (let c = await claimNext(); c; c = await claimNext()) {
        try { await runJob(c.job, c.resumed); n++; }
        catch (e) { if (e instanceof LeaseLost) { log.warn && log.warn('[meeting-pipeline] ' + e.message + '; result discarded'); continue; } throw e; }
      }
    } catch (e) {
      log.error && log.error('[meeting-pipeline] tick failed: ' + e.message);
    } finally { busy = false; }
    return n;
  }
  function kick() { if (timer) setImmediate(() => tick()); }
  function start(everyMs = TICK_MS) {
    if (timer) return;
    timer = setInterval(() => tick(), everyMs);
    if (timer.unref) timer.unref();
    setTimeout(() => tick(), 2000).unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { enqueue, retry, tick, start, stop, stages, owner: me };
}

module.exports = { createPipeline, PermanentError, STAGE_ORDER };
