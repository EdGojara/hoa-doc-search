// ============================================================================
// lib/onboarding/resume.js  (Ed 2026-11-01: activity-driven, not polling)
// ----------------------------------------------------------------------------
// When an authorized action elsewhere changes what an open conversion depends on
// (a correction applied, a bill posted, an ownership change approved, a legal
// posting reversed), the conversion operator resumes right after that action:
// no timer, no polling. It reuses service.operate, which
//   * re-runs a stage only when its recorded inputs changed (fingerprints), so a
//     resume with nothing new is a no-op;
//   * never executes, approves, decides or waives anything: it stops at the next
//     owner decision or owner transition (execute / complete are human only, and
//     the database refuses a system advance into them).
// Fire-and-forget after the caller's work is done: it never changes the caller's
// result. One run per batch at a time; a request that arrives while one is
// running queues exactly one more run. A failure is logged; the batch screen's
// Run button (or the next action) resumes it.
// ============================================================================
const OPEN_STAGES = ['intake', 'normalize', 'source_controls', 'snapshot', 'activity_bridge', 'preflight'];
const running = new Map();   // batch id -> { promise, again }

function defaultService() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { createOnboardingService, supabaseBackends } = require('./service');
  return createOnboardingService(supabaseBackends(sb));
}

function operateOnce(service, batchId, reason, log) {
  const cur = running.get(batchId);
  if (cur) { cur.again = true; return cur.promise; }
  const entry = { again: false, promise: null };
  entry.promise = (async () => {
    try {
      do {
        entry.again = false;
        const out = await service.operate(batchId);
        log.log(`[onboarding] resumed ${batchId} after ${reason}: stopped at ${out && out.stopped_at} (${out && out.reason})`);
      } while (entry.again);
    } catch (e) {
      log.warn('[onboarding] resume failed (the batch screen or the next action resumes it):', JSON.stringify({ batch: batchId, reason, error: e.message }));
    } finally { running.delete(batchId); }
  })();
  running.set(batchId, entry);
  return entry.promise;
}

// Resume every open conversion batch (optionally one community's). Returns the batch ids resumed.
async function resumeOpenConversions({ communityId = null, reason = 'activity', service = null, log = console } = {}) {
  const svc = service || defaultService();
  const batches = (await svc.listBatches(communityId || null)) || [];
  const open = batches.filter((b) => OPEN_STAGES.includes(b.stage) && (!communityId || b.community_id === communityId));
  await Promise.all(open.map((b) => operateOnce(svc, b.id, reason, log)));
  return open.map((b) => b.id);
}

// The call sites use this: after the response, never throws, never awaited.
function resumeAfter(opts = {}) {
  setImmediate(() => { resumeOpenConversions(opts).catch((e) => (opts.log || console).warn('[onboarding] resume skipped:', e.message)); });
}

module.exports = { resumeOpenConversions, resumeAfter, operateOnce, OPEN_STAGES };
