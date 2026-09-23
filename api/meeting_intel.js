// ============================================================================
// api/meeting_intel.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Meeting Intelligence, Step 2: turn a server-VERIFIED recording session into
// one continuous audio file -> transcript -> Paige's review -> draft minutes.
// Mounted at /api/meeting-intel. Staff only (Supabase JWT, role admin|staff).
//
// OFF unless MEETING_PROCESSING_ENABLED === 'true': every route 404s and the
// background worker does not start, so this can ship dark.
//
// Processing runs in the background (lib/meetings/pipeline.js); these routes
// only queue work, report status, and serve results.
//   GET  /sessions/:sid              processing status + results summary
//   POST /sessions/:sid/process      queue a verified session
//   POST /jobs/:id/retry             retry from the failed stage (or ?from=stage)
//   GET  /sessions/:sid/audio        the joined audio (302 to a signed URL)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { createPipeline } = require('../lib/meetings/pipeline');
const { assembleStage, BUCKET } = require('../lib/meetings/stage_assemble');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handlers = { assemble: assembleStage };
const pipeline = createPipeline({ supabase, handlers });

const enabled = () => process.env.MEETING_PROCESSING_ENABLED === 'true';
router.use((req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'meeting_processing_disabled' })));

async function staffOnly(req, res) {
  const u = await requireStaff(req, res);
  if (!u) return null;
  if (!['admin', 'staff'].includes(u.role)) { res.status(403).json({ error: 'staff_only' }); return null; }
  return u;
}
const fail = (res, tag, err) => { console.error(`[meeting-intel] ${tag}:`, err && err.message ? err.message : err); res.status(500).json({ error: safeErrorMessage(err) }); };
const one = async (table, cols, col, val) => {
  const { data, error } = await supabase.from(table).select(cols).eq(col, val).maybeSingle();
  if (error) throw error;
  return data;
};

// The status line the UI shows: Audio verified -> Joining audio -> Transcribing -> Analyzing -> Ready for review
function statusView(session, job) {
  const steps = [
    { key: 'verified', label: 'Audio verified', state: session.status === 'verified' ? 'done' : 'pending' },
    { key: 'assemble', label: 'Joining audio' }, { key: 'transcribe', label: 'Transcribing' }, { key: 'analyze', label: 'Analyzing' },
    { key: 'ready', label: 'Ready for review' },
  ];
  for (const st of steps.slice(1, 4)) {
    const info = job && job.stages && job.stages[st.key];
    st.state = !job || !info ? 'pending' : info.status === 'done' ? 'done' : info.status === 'failed' ? 'failed' : job.current_stage === st.key && ['running', 'queued'].includes(job.status) ? (info.status === 'retrying' ? 'retrying' : job.status === 'running' ? 'running' : 'queued') : 'pending';
    if (info && info.error) st.error = info.error;
  }
  steps[4].state = job && job.status === 'ready' ? 'done' : 'pending';
  return steps;
}

router.get('/sessions/:sid', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const s = await one('meeting_recording_sessions', 'id, meeting_id, community_id, status, verification, client_started_at, client_stopped_at', 'id', req.params.sid);
    if (!s) return res.status(404).json({ error: 'session_not_found' });
    const job = await one('meeting_processing_jobs', '*', 'session_id', s.id);
    const assembly = await one('meeting_audio_assemblies', 'id, bytes, sha256, duration_ms, meeting_span_ms, segment_count, gaps, exec_ranges, boundaries, created_at', 'session_id', s.id);
    const out = { session: { id: s.id, meeting_id: s.meeting_id, community_id: s.community_id, status: s.status }, job, steps: statusView(s, job), assembly };
    for (const extra of statusExtras) Object.assign(out, await extra(s, job));
    res.json(out);
  } catch (e) { fail(res, 'status', e); }
});
// Later stages add their summary to the status response.
const statusExtras = [];

router.post('/sessions/:sid/process', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const r = await pipeline.enqueue(req.params.sid, u.user.id);
    res.status(r.status).json(r.body);
  } catch (e) { fail(res, 'process', e); }
});

router.post('/jobs/:id/retry', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid_job' });
    const r = await pipeline.retry(req.params.id, { fromStage: req.query.from || undefined });
    res.status(r.status).json(r.body);
  } catch (e) { fail(res, 'retry', e); }
});

router.get('/sessions/:sid/audio', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const a = await one('meeting_audio_assemblies', 'storage_path', 'session_id', req.params.sid);
    if (!a) return res.status(404).json({ error: 'audio_not_ready' });
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(a.storage_path, 3600);
    if (error || !data) return res.status(502).json({ error: 'signed_url_failed' });
    res.redirect(302, data.signedUrl);
  } catch (e) { fail(res, 'audio', e); }
});

/** Start the background worker (server.js). No-op unless processing is enabled. */
function startMeetingWorker() {
  if (!enabled()) return false;
  pipeline.start();
  console.log(`[meeting-intel] worker started (${pipeline.owner}); stages: ${pipeline.stages.join(' -> ')}`);
  return true;
}

module.exports = router;
module.exports.startMeetingWorker = startMeetingWorker;
module.exports._pipeline = pipeline;
module.exports._handlers = handlers;
module.exports._statusExtras = statusExtras;
module.exports._supabase = supabase;
