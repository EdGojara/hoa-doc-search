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
//   GET  /sessions/:sid/audio        the joined audio (302 to a signed URL; ?json=1 returns it)
//   GET  /sessions/:sid/transcript   current transcript: segments, speakers, roster, gaps
//   PUT  /sessions/:sid/speakers/:n  map Speaker n -> board member / Manager / Vendor / Homeowner / Other
//   DELETE /sessions/:sid/speakers/:n  clear that mapping
//   GET  /sessions/:sid/analysis     Paige's review, re-checked against the CURRENT
//                                    speaker mappings, + a draft-minutes preview
//   POST /sessions/:sid/reanalyze    re-run Paige (e.g. after mapping speakers)
//   POST /sessions/:sid/draft-minutes  save a DRAFT into the minutes module
//                                    (never finalized, emailed, or turned into
//                                    motions/projects/tasks from here)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { createPipeline } = require('../lib/meetings/pipeline');
const { assembleStage, BUCKET } = require('../lib/meetings/stage_assemble');
const { transcribeStage } = require('../lib/meetings/stage_transcribe');
const { boardRoster, speakerMappings, speakerLabel } = require('../lib/meetings/roster');
const { fetchAll } = require('../lib/db/fetch_all');
const { analyzeStage, loadContext, recheck, mappingsChanged } = require('../lib/meetings/stage_analyze');
const { buildDraftMinutes } = require('../lib/meetings/minutes_from_analysis');
const { BEDROCK_MGMT_CO_ID } = require('../lib/company');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handlers = { assemble: assembleStage, transcribe: transcribeStage, analyze: analyzeStage };
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
    if (req.query.json) return res.json({ url: data.signedUrl, expires_in: 3600 });   // the page's player needs the URL (an <audio> tag cannot send the login header)
    res.redirect(302, data.signedUrl);
  } catch (e) { fail(res, 'audio', e); }
});

// ------------------------------------------------------------ transcript
const ROLES = new Set(['board_member', 'manager', 'vendor', 'homeowner', 'other']);
async function currentTranscript(sid) {
  const { data, error } = await supabase.from('meeting_transcripts').select('*').eq('session_id', sid).eq('is_current', true).maybeSingle();
  if (error) throw error;
  return data;
}
statusExtras.push(async (s) => {
  const t = await currentTranscript(s.id);
  return { transcript: t ? { id: t.id, model: t.model, speaker_count: t.speaker_count, segment_count: t.segment_count, word_count: t.word_count, avg_confidence: t.avg_confidence, created_at: t.created_at } : null };
});

router.get('/sessions/:sid/transcript', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const t = await currentTranscript(req.params.sid);
    if (!t) return res.status(404).json({ error: 'transcript_not_ready' });
    const [segments, mappings, roster, assembly] = await Promise.all([
      fetchAll(supabase, 'meeting_transcript_segments', { select: 'idx, speaker, start_ms, end_ms, meeting_start_ms, meeting_end_ms, text, confidence, word_count, scope, after_gap', filters: { transcript_id: t.id }, orderBy: 'idx' }),
      speakerMappings(supabase, t.id), boardRoster(supabase, t.community_id),
      one('meeting_audio_assemblies', 'gaps, exec_ranges, duration_ms', 'session_id', req.params.sid),
    ]);
    const speakers = [...new Set(segments.map((x) => x.speaker))].filter((x) => x != null).sort((a, b) => a - b).map((n) => {
      const mine = segments.filter((x) => x.speaker === n);
      const openOnes = mine.filter((x) => x.scope === 'open');
      return { speaker: n, default_label: `Speaker ${n + 1}`, label: speakerLabel(n, mappings, roster), mapping: mappings.find((m) => m.speaker === n) || null,
        segments: mine.length, words: mine.reduce((a, x) => a + x.word_count, 0), first_ms: mine[0] ? mine[0].start_ms : null,
        sample: (openOnes[0] || { text: '' }).text.slice(0, 160) };
    });
    res.json({ transcript: { id: t.id, model: t.model, created_at: t.created_at, speaker_count: t.speaker_count, word_count: t.word_count, avg_confidence: t.avg_confidence },
      segments: segments.map((x) => ({ ...x, label: speakerLabel(x.speaker, mappings, roster) })), speakers, roster,
      gaps: assembly ? assembly.gaps : [], exec_ranges: assembly ? assembly.exec_ranges : [] });
  } catch (e) { fail(res, 'transcript', e); }
});

router.put('/sessions/:sid/speakers/:n', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n > 99) return res.status(400).json({ error: 'invalid_speaker' });
    const t = await currentTranscript(req.params.sid);
    if (!t) return res.status(404).json({ error: 'transcript_not_ready' });
    const b = req.body || {};
    if (!ROLES.has(b.role)) return res.status(400).json({ error: 'invalid_role', allowed: [...ROLES] });
    let boardMemberId = null, displayName = b.display_name ? String(b.display_name).trim().slice(0, 120) : null;
    if (b.role === 'board_member') {
      const roster = await boardRoster(supabase, t.community_id);
      const m = roster.find((r) => r.id === b.board_member_id);
      if (!m) return res.status(400).json({ error: 'not_on_roster', detail: 'Pick a current board member of this community.' });
      boardMemberId = m.id; displayName = m.name;
    }
    const { data: seg } = await supabase.from('meeting_transcript_segments').select('idx').eq('transcript_id', t.id).eq('speaker', n).limit(1);
    if (!seg || !seg.length) return res.status(404).json({ error: 'speaker_not_in_transcript' });
    const { data, error } = await supabase.from('meeting_speaker_mappings').upsert({ transcript_id: t.id, session_id: t.session_id, community_id: t.community_id, speaker: n,
      role: b.role, board_member_id: boardMemberId, display_name: displayName, updated_by_user_id: u.user.id }, { onConflict: 'transcript_id,speaker' }).select('*').single();
    if (error) throw error;
    res.json({ mapping: data });
  } catch (e) { fail(res, 'speaker map', e); }
});

router.delete('/sessions/:sid/speakers/:n', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const t = await currentTranscript(req.params.sid);
    if (!t) return res.status(404).json({ error: 'transcript_not_ready' });
    const { error } = await supabase.from('meeting_speaker_mappings').delete().eq('transcript_id', t.id).eq('speaker', Number(req.params.n));
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { fail(res, 'speaker unmap', e); }
});

// ------------------------------------------------------------ Paige's review + draft minutes
async function currentAnalysis(sid) {
  const { data, error } = await supabase.from('meeting_analyses').select('*').eq('session_id', sid).eq('is_current', true).maybeSingle();
  if (error) throw error;
  return data;
}
const MINUTES_TYPES = new Set(['regular', 'annual', 'special', 'executive', 'organizational']);
statusExtras.push(async (s) => {
  const a = await currentAnalysis(s.id);
  return { analysis: a ? { id: a.id, model: a.model, needs_review_count: a.needs_review_count, withheld_count: a.withheld_count, draft_minutes_id: a.draft_minutes_id, created_at: a.created_at } : null };
});

// The stored analysis re-checked against the CURRENT speaker mappings, plus the draft-minutes preview.
async function reviewPayload(sid) {
  const a = await currentAnalysis(sid);
  if (!a) return null;
  const ctx = await loadContext(supabase, sid);
  const checked = recheck(a, ctx);
  const preview = buildDraftMinutes(checked, { communityName: ctx.community.name, meeting: ctx.meeting, sessionStartedAt: ctx.sessionStartedAt, roster: ctx.roster });
  let draft = null;
  if (a.draft_minutes_id) {
    const { data } = await supabase.from('meeting_minutes').select('id, status, title, created_at').eq('id', a.draft_minutes_id).maybeSingle();
    draft = data || null;
  }
  return { a, ctx, checked, preview, draft };
}

router.get('/sessions/:sid/analysis', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const p = await reviewPayload(req.params.sid);
    if (!p) return res.status(404).json({ error: 'analysis_not_ready' });
    res.json({
      analysis: { id: p.a.id, model: p.a.model, prompt_version: p.a.prompt_version, created_at: p.a.created_at, transcript_id: p.a.transcript_id },
      checked: p.checked, counts: p.checked.counts, mappings_changed: mappingsChanged(p.a, p.ctx),
      minutes_preview: p.preview.body_markdown, draft_minutes: p.draft, community_name: p.ctx.community.name || null,
    });
  } catch (e) { fail(res, 'analysis', e); }
});

router.post('/sessions/:sid/reanalyze', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const job = await one('meeting_processing_jobs', 'id, status', 'session_id', req.params.sid);
    if (!job) return res.status(404).json({ error: 'not_processed' });
    if (!(await currentTranscript(req.params.sid))) return res.status(409).json({ error: 'transcript_not_ready' });
    const r = await pipeline.retry(job.id, { fromStage: 'analyze' });
    res.status(r.status).json(r.body);
  } catch (e) { fail(res, 'reanalyze', e); }
});

router.post('/sessions/:sid/draft-minutes', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const p = await reviewPayload(req.params.sid);
    if (!p) return res.status(409).json({ error: 'analysis_not_ready' });
    if (p.draft) return res.status(200).json({ minutes: p.draft, existing: true });
    const m = p.ctx.meeting;
    const ref = `meeting_analysis:${p.a.id}`;
    const row = {
      management_company_id: p.ctx.community.management_company_id || BEDROCK_MGMT_CO_ID,
      community_id: m.community_id, meeting_date: m.meeting_date, meeting_type: MINUTES_TYPES.has(m.meeting_type) ? m.meeting_type : 'special',
      title: `${m.title} Minutes`, status: 'draft', body_markdown: p.preview.body_markdown, attendees: p.preview.attendees, location: m.location || null,
      called_to_order_at: p.preview.called_to_order_at, adjourned_at: p.preview.adjourned_at, ai_drafted: true, ai_model: p.a.model,
      created_by: 'meeting_recorder', intake_source_ref: ref,
    };
    let { data: minutes, error } = await supabase.from('meeting_minutes').insert(row).select('id, status, title, created_at').single();
    if (error && error.code === '23505') ({ data: minutes, error } = await supabase.from('meeting_minutes').select('id, status, title, created_at').eq('intake_source_ref', ref).single());
    if (error) throw error;
    const { error: aErr } = await supabase.from('meeting_analyses').update({ draft_minutes_id: minutes.id, draft_minutes_created_at: new Date().toISOString(), draft_minutes_created_by: u.user.id }).eq('id', p.a.id);
    if (aErr) throw aErr;
    // Link the meeting to its minutes only if it has none yet (never re-point an existing link).
    const { error: lErr } = await supabase.from('meetings').update({ meeting_minutes_id: minutes.id }).eq('id', m.id).is('meeting_minutes_id', null);
    if (lErr) throw lErr;
    res.status(201).json({ minutes, existing: false, needs_review: p.preview.review_count });
  } catch (e) { fail(res, 'draft minutes', e); }
});

/** Start the background worker (server.js). No-op unless processing is enabled. */
function startMeetingWorker() {
  if (!enabled()) return false;
  pipeline.start();
  console.log(`[meeting-intel] worker started (${pipeline.owner}); stages: ${pipeline.stages.join(' -> ')}`);
  // One log line that proves the deploy has what the stages need.
  require('../lib/meetings/assemble').ffmpegVersion()
    .then((v) => console.log(`[meeting-intel] ${v || 'ffmpeg NOT available: joining audio will fail'}; Deepgram key ${process.env.DEEPGRAM_API_KEY ? 'set' : 'MISSING'}; STT model ${require('../lib/meetings/transcribe').modelName()}; analysis model ${require('../lib/meetings/paige_meeting').MODEL()}`))
    .catch((e) => console.error('[meeting-intel] ffmpeg check failed: ' + e.message));
  return true;
}

module.exports = router;
module.exports.startMeetingWorker = startMeetingWorker;
module.exports._pipeline = pipeline;
module.exports._handlers = handlers;
module.exports._statusExtras = statusExtras;
module.exports._supabase = supabase;
