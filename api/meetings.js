// ============================================================================
// api/meetings.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Meeting Intelligence, Step 1: server-side persistence for Meeting Recorder.
// Schema: migrations/447_meetings_and_recordings.sql. Mounted at /api/meetings.
//
// OFF unless MEETING_UPLOADS_ENABLED === 'true' (every route 404s), so this
// can ship dark and Meeting Recorder keeps recording on the device only.
//
// Auth:
//   - Staff routes: real staff login (Supabase JWT, role admin|staff). Every
//     write is attributed to that user. Policy changes: admin only.
//   - Upload routes (segments, heartbeat, markers, stop): a per-session upload
//     key (lib/meetings/upload_token.js), because a 4-hour meeting outlives the
//     hourly login token. The key only works for its own session.
//   - Board members / homeowners: no access (not in the staff-gate allowlist).
//
// Segment upload is idempotent and write-once: the server recomputes sha256;
// same seq + same bytes = 200 (duplicate), same seq + different bytes = 409
// (never overwritten), claimed sha != actual = 422.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireStaff, requireAdmin } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const { fetchAll } = require('../lib/db/fetch_all');
const { verifySession } = require('../lib/meetings/verify');
const { issueUploadToken, checkUploadToken } = require('../lib/meetings/upload_token');
const { BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID } = require('../lib/company');
// Meetings may be recorded for Bedrock communities and for the demo company's
// communities (Drama Creek), so controlled tests never touch a real HOA's records.
const MEETING_MGMT_COS = [BEDROCK_MGMT_CO_ID, DEMO_MGMT_CO_ID].filter(Boolean);

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUCKET = 'meeting-audio';
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_MARKERS_PER_CALL = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9:_-]{6,120}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEETING_TYPES = new Set(['regular', 'annual', 'special', 'executive', 'organizational', 'budget', 'emergency']);
const MEETING_STATUSES = new Set(['scheduled', 'in_progress', 'recorded', 'closed', 'canceled']);
const RETENTION = new Set(['retain', 'delete_after_minutes_approved', 'delete_after_days']);
const OWNERSHIP = new Set(['undetermined', 'association_record', 'workpaper', 'mixed']);
const EXEC_POLICY = new Set(['allowed', 'not_allowed', 'ask_each_time']);
const PURPOSES = new Set(['drafting_aid', 'official_record', 'test']);
const MARKER_KINDS = new Set(['minutes', 'action_item', 'important', 'exec_start', 'exec_end', 'pause', 'resume', 'interrupted',
  'resumed_after_interruption', 'recording_started', 'recording_stopped', 'mic_muted', 'no_sound', 'notice_ack']);
const LIVE_STATUSES = new Set(['recording', 'paused', 'interrupted']);
const DEFAULT_POLICY = { recording_enabled: true, exec_session_recording: 'ask_each_time', default_retention_policy: 'retain', default_retention_days: null,
  default_record_ownership: 'undetermined', default_recording_purpose: 'drafting_aid', recording_notice_text: null };

// ---------------------------------------------------------------- guards
router.use((req, res, next) => {
  if (process.env.MEETING_UPLOADS_ENABLED !== 'true') return res.status(404).json({ error: 'meeting_uploads_disabled' });
  next();
});

async function staffOnly(req, res) {
  const u = await requireStaff(req, res);
  if (!u) return null;
  if (!['admin', 'staff'].includes(u.role)) { res.status(403).json({ error: 'staff_only' }); return null; }
  return u;
}
const fail = (res, tag, err) => { console.error(`[meetings] ${tag}:`, err && err.message ? err.message : err); res.status(500).json({ error: safeErrorMessage(err) }); };
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

async function communityExists(id) {
  if (!UUID.test(String(id || ''))) return false;
  const { data, error } = await supabase.from('communities').select('id').eq('id', id).in('management_company_id', MEETING_MGMT_COS).maybeSingle();
  if (error) throw error;
  return !!data;
}
async function policyFor(communityId) {
  const { data, error } = await supabase.from('community_meeting_policies').select('*').eq('community_id', communityId).maybeSingle();
  if (error) throw error;
  return data ? { ...DEFAULT_POLICY, ...data, is_default: false } : { ...DEFAULT_POLICY, community_id: communityId, is_default: true };
}

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new Error('bucket list failed: ' + error.message);
  if (!(data || []).some((b) => b.name === BUCKET)) {
    const { error: cErr } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (cErr && !/already exists/i.test(cErr.message)) throw new Error('bucket create failed: ' + cErr.message);
  }
  bucketReady = true;
}
const extFor = (mime) => (/mp4|aac|m4a/i.test(mime || '') ? 'mp4' : /ogg/i.test(mime || '') ? 'ogg' : 'webm');
const segPath = (s, seq, mime) => `${s.community_id}/${s.meeting_id}/${s.id}/${String(seq).padStart(6, '0')}.${extFor(mime)}`;
const publicSession = (s) => { if (!s) return s; const { upload_token_hash, ...rest } = s; return rest; };

// ------------------------------------------------------- meeting creation
function validateMeetingInput(b) {
  const errors = [];
  if (!UUID.test(String(b.community_id || ''))) errors.push('community_id');
  if (!String(b.title || '').trim()) errors.push('title');
  if (!DATE.test(String(b.meeting_date || ''))) errors.push('meeting_date (YYYY-MM-DD, Central date)');
  if (b.meeting_type && !MEETING_TYPES.has(b.meeting_type)) errors.push('meeting_type');
  if (b.scheduled_at && !iso(b.scheduled_at)) errors.push('scheduled_at');
  if (b.meeting_agenda_id && !UUID.test(String(b.meeting_agenda_id))) errors.push('meeting_agenda_id');
  return errors;
}
// Find the meeting already linked to this agenda, or create one with the
// community's policy defaults copied in.
async function findOrCreateMeeting(b, userId) {
  if (!(await communityExists(b.community_id))) return { status: 404, body: { error: 'community_not_found' } };
  if (b.meeting_agenda_id) {
    const { data: ex, error } = await supabase.from('meetings').select('*').eq('community_id', b.community_id).eq('meeting_agenda_id', b.meeting_agenda_id).order('created_at').limit(1);
    if (error) throw error;
    if (ex && ex[0]) return { status: 200, body: { meeting: ex[0], existing: true } };
  }
  const p = await policyFor(b.community_id);
  const row = {
    community_id: b.community_id, title: String(b.title).trim().slice(0, 200), meeting_type: b.meeting_type || 'regular',
    meeting_date: b.meeting_date, scheduled_at: b.scheduled_at ? iso(b.scheduled_at) : null, location: b.location ? String(b.location).slice(0, 200) : null,
    meeting_agenda_id: b.meeting_agenda_id || null,
    retention_policy: p.default_retention_policy, retention_days: p.default_retention_days,
    record_ownership: p.default_record_ownership, exec_session_recording: p.exec_session_recording,
    created_by_user_id: userId,
  };
  const { data, error } = await supabase.from('meetings').insert(row).select('*').single();
  if (error) throw error;
  return { status: 201, body: { meeting: data, existing: false } };
}

// ================================================================ ROUTES
router.get('/config', async (req, res) => {
  const u = await staffOnly(req, res); if (!u) return;
  res.json({ enabled: true, max_segment_bytes: MAX_SEGMENT_BYTES, bucket: BUCKET });
});

// Communities a meeting can be recorded for (Bedrock + demo), for the recorder's picker.
router.get('/communities', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    const { data, error } = await supabase.from('communities').select('id, name, slug, active, management_company_id')
      .in('management_company_id', MEETING_MGMT_COS).order('name').limit(500);
    if (error) throw error;
    res.json({ communities: (data || []).filter((c) => c.active !== false)
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, is_demo: c.management_company_id === DEMO_MGMT_CO_ID })) });
  } catch (e) { fail(res, 'communities', e); }
});

// ---- meetings
router.get('/', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    const cid = req.query.community_id;
    if (!UUID.test(String(cid || ''))) return res.status(400).json({ error: 'community_id_required' });
    const { data, error } = await supabase.from('meetings').select('*').eq('community_id', cid).order('meeting_date', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ meetings: data || [] });
  } catch (e) { fail(res, 'list', e); }
});

router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    const errs = validateMeetingInput(req.body || {});
    if (errs.length) return res.status(400).json({ error: 'invalid_meeting', fields: errs });
    const r = await findOrCreateMeeting(req.body, u.user.id);
    res.status(r.status).json(r.body);
  } catch (e) { fail(res, 'create', e); }
});

router.get('/policies/:communityId', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!(await communityExists(req.params.communityId))) return res.status(404).json({ error: 'community_not_found' });
    res.json({ policy: await policyFor(req.params.communityId) });
  } catch (e) { fail(res, 'policy get', e); }
});

router.put('/policies/:communityId', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const a = await requireAdmin(req, res); if (!a) return;
    const cid = req.params.communityId;
    if (!(await communityExists(cid))) return res.status(404).json({ error: 'community_not_found' });
    const b = req.body || {}, patch = {}, bad = [];
    if ('recording_enabled' in b) { if (typeof b.recording_enabled !== 'boolean') bad.push('recording_enabled'); else patch.recording_enabled = b.recording_enabled; }
    if ('exec_session_recording' in b) { if (!EXEC_POLICY.has(b.exec_session_recording)) bad.push('exec_session_recording'); else patch.exec_session_recording = b.exec_session_recording; }
    if ('default_retention_policy' in b) { if (!RETENTION.has(b.default_retention_policy)) bad.push('default_retention_policy'); else patch.default_retention_policy = b.default_retention_policy; }
    if ('default_retention_days' in b) { const d = intOrNull(b.default_retention_days); if (Number.isNaN(d) || (d !== null && d <= 0)) bad.push('default_retention_days'); else patch.default_retention_days = d; }
    if ('default_record_ownership' in b) { if (!OWNERSHIP.has(b.default_record_ownership)) bad.push('default_record_ownership'); else patch.default_record_ownership = b.default_record_ownership; }
    if ('default_recording_purpose' in b) { if (!PURPOSES.has(b.default_recording_purpose)) bad.push('default_recording_purpose'); else patch.default_recording_purpose = b.default_recording_purpose; }
    if ('recording_notice_text' in b) patch.recording_notice_text = b.recording_notice_text ? String(b.recording_notice_text).slice(0, 2000) : null;
    if (bad.length) return res.status(400).json({ error: 'invalid_policy', fields: bad });
    const { data, error } = await supabase.from('community_meeting_policies')
      .upsert({ community_id: cid, ...patch, updated_by_user_id: a.user.id }, { onConflict: 'community_id' }).select('*').single();
    if (error) {
      if (/check constraint/i.test(error.message)) return res.status(400).json({ error: 'invalid_policy', detail: 'delete_after_days needs default_retention_days' });
      throw error;
    }
    res.json({ policy: data });
  } catch (e) { fail(res, 'policy put', e); }
});

// ---- recording sessions (registered by the device; idempotent on client_session_id)
router.post('/sessions', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    const b = req.body || {};
    if (!CLIENT_ID.test(String(b.client_session_id || ''))) return res.status(400).json({ error: 'client_session_id_required' });
    const purpose = b.recording_purpose || 'drafting_aid';
    if (!PURPOSES.has(purpose)) return res.status(400).json({ error: 'invalid_recording_purpose' });
    const startedAt = iso(b.client_started_at);
    if (!startedAt) return res.status(400).json({ error: 'client_started_at_required' });

    // Already registered (retry / reload / offline start that finally got through)?
    const { data: prior, error: pErr } = await supabase.from('meeting_recording_sessions').select('*').eq('client_session_id', b.client_session_id).maybeSingle();
    if (pErr) throw pErr;
    if (prior) {
      const k = issueUploadToken(prior.id);
      const { error: kErr } = await supabase.from('meeting_recording_sessions').update({ upload_token_hash: k.hash, upload_token_expires_at: k.expires_at }).eq('id', prior.id);
      if (kErr) throw kErr;
      return res.json({ session: publicSession(prior), meeting_id: prior.meeting_id, upload_token: k.token, upload_token_expires_at: k.expires_at, existing: true });
    }

    let meeting;
    if (b.meeting_id) {
      if (!UUID.test(String(b.meeting_id))) return res.status(400).json({ error: 'invalid_meeting_id' });
      const { data, error } = await supabase.from('meetings').select('*').eq('id', b.meeting_id).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'meeting_not_found' });
      meeting = data;
    } else if (b.meeting) {
      const errs = validateMeetingInput(b.meeting);
      if (errs.length) return res.status(400).json({ error: 'invalid_meeting', fields: errs });
      const r = await findOrCreateMeeting(b.meeting, u.user.id);
      if (r.status === 404) return res.status(404).json(r.body);
      meeting = r.body.meeting;
    } else return res.status(400).json({ error: 'meeting_id_or_meeting_required' });

    const policy = await policyFor(meeting.community_id);
    if (!policy.recording_enabled) return res.status(403).json({ error: 'recording_disabled_for_community' });

    const id = crypto.randomUUID();
    const k = issueUploadToken(id);
    const row = {
      id, meeting_id: meeting.id, community_id: meeting.community_id, client_session_id: b.client_session_id,
      recording_purpose: purpose, record_ownership: meeting.record_ownership,
      mic_name: b.mic_name ? String(b.mic_name).slice(0, 200) : null, noise_reduction: typeof b.noise_reduction === 'boolean' ? b.noise_reduction : null,
      mime: b.mime ? String(b.mime).slice(0, 100) : null, audio_constraints: b.audio_constraints && typeof b.audio_constraints === 'object' ? b.audio_constraints : null,
      segment_target_ms: Number.isInteger(b.segment_target_ms) ? b.segment_target_ms : null, overlap_ms: Number.isInteger(b.overlap_ms) ? b.overlap_ms : null,
      device_summary: b.device_summary ? String(b.device_summary).slice(0, 300) : null, client_started_at: startedAt,
      upload_token_hash: k.hash, upload_token_expires_at: k.expires_at, started_by_user_id: u.user.id,
    };
    const { data: created, error: cErr } = await supabase.from('meeting_recording_sessions').insert(row).select('*').single();
    if (cErr) {
      if (cErr.code === '23505') return res.status(409).json({ error: 'session_registration_race_retry' });   // concurrent retry won; the next retry gets the existing row
      throw cErr;
    }
    if (meeting.status === 'scheduled') await supabase.from('meetings').update({ status: 'in_progress' }).eq('id', meeting.id).eq('status', 'scheduled');
    res.status(201).json({ session: publicSession(created), meeting_id: meeting.id, upload_token: k.token, upload_token_expires_at: k.expires_at, existing: false });
  } catch (e) { fail(res, 'session register', e); }
});

router.post('/sessions/:sid/token', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const k = issueUploadToken(req.params.sid);
    const { data, error } = await supabase.from('meeting_recording_sessions').update({ upload_token_hash: k.hash, upload_token_expires_at: k.expires_at })
      .eq('id', req.params.sid).select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'session_not_found' });
    res.json({ upload_token: k.token, upload_token_expires_at: k.expires_at });
  } catch (e) { fail(res, 'token', e); }
});

// Upload-key auth for the device routes. Sends the error and returns null on failure.
async function sessionByKey(req, res) {
  const sid = req.params.sid;
  if (!UUID.test(String(sid || ''))) { res.status(400).json({ error: 'invalid_session' }); return null; }
  const { data: s, error } = await supabase.from('meeting_recording_sessions').select('*').eq('id', sid).maybeSingle();
  if (error) throw error;
  const verdict = checkUploadToken(req.get('x-upload-token'), s, sid);
  if (verdict !== 'ok') { res.status(401).json({ error: `upload_key_${verdict}` }); return null; }
  if (s.status === 'abandoned') { res.status(409).json({ error: 'session_abandoned' }); return null; }
  return s;
}

// ---- segment upload (idempotent, write-once)
router.put('/sessions/:sid/segments/:seq', express.raw({ type: () => true, limit: MAX_SEGMENT_BYTES }), async (req, res) => {
  try {
    const s = await sessionByKey(req, res); if (!s) return;
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq > 100000) return res.status(400).json({ error: 'invalid_seq' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(400).json({ error: 'empty_segment' });
    const claimed = String(req.get('x-segment-sha256') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(claimed)) return res.status(400).json({ error: 'sha256_header_required' });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== claimed) return res.status(422).json({ error: 'sha256_mismatch', server_sha256: sha });

    const respondExisting = (row) => (row.sha256 === sha
      ? res.status(200).json({ ok: true, seq, sha256: sha, duplicate: true })
      : res.status(409).json({ error: 'seq_conflict', seq, existing_sha256: row.sha256, received_sha256: sha }));
    const { data: ex, error: exErr } = await supabase.from('meeting_recording_segments').select('sha256').eq('session_id', s.id).eq('seq', seq).maybeSingle();
    if (exErr) throw exErr;
    if (ex) return respondExisting(ex);

    await ensureBucket();
    const mime = String(req.get('content-type') || 'application/octet-stream').slice(0, 100);
    const path = segPath(s, seq, mime);
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: false });
    if (upErr) {
      if (!/exist|duplicate/i.test(upErr.message)) return res.status(502).json({ error: 'storage_write_failed' });
      // A previous attempt stored the file but crashed before the DB row: confirm it is the same bytes.
      const { data: blob, error: dErr } = await supabase.storage.from(BUCKET).download(path);
      if (dErr || !blob) return res.status(502).json({ error: 'storage_check_failed' });
      const storedSha = crypto.createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
      if (storedSha !== sha) return res.status(409).json({ error: 'storage_conflict', seq, existing_sha256: storedSha, received_sha256: sha });
    }
    const num = (h) => { const v = req.get(h); return v == null || v === '' ? null : Number(v); };
    const row = {
      session_id: s.id, meeting_id: s.meeting_id, community_id: s.community_id, seq, storage_path: path, bytes: buf.length, sha256: sha, mime,
      client_started_at: iso(req.get('x-segment-started-at')), duration_ms: Number.isInteger(num('x-segment-duration-ms')) ? num('x-segment-duration-ms') : null,
      is_partial: req.get('x-segment-partial') === 'true', session_scope: req.get('x-segment-scope') === 'executive' ? 'executive' : 'open',
      audible: req.get('x-segment-audible') === 'true' ? true : req.get('x-segment-audible') === 'false' ? false : null,
      peak: Number.isFinite(num('x-segment-peak')) ? num('x-segment-peak') : null, rms: Number.isFinite(num('x-segment-rms')) ? num('x-segment-rms') : null,
      uploaded_by_user_id: s.started_by_user_id,
    };
    const { error: insErr } = await supabase.from('meeting_recording_segments').insert(row);
    if (insErr) {
      if (insErr.code === '23505') {   // concurrent retry inserted first
        const { data: again } = await supabase.from('meeting_recording_segments').select('sha256').eq('session_id', s.id).eq('seq', seq).maybeSingle();
        if (again) return respondExisting(again);
      }
      throw insErr;
    }
    await supabase.from('meeting_recording_sessions').update({ last_upload_at: new Date().toISOString() }).eq('id', s.id);
    await supabase.from('meeting_recording_sessions').update({ highest_seq_seen: seq }).eq('id', s.id).or(`highest_seq_seen.is.null,highest_seq_seen.lt.${seq}`);
    res.status(201).json({ ok: true, seq, sha256: sha, bytes: buf.length, duplicate: false });
  } catch (e) { fail(res, 'segment upload', e); }
});

// ---- heartbeat
router.post('/sessions/:sid/heartbeat', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const s = await sessionByKey(req, res); if (!s) return;
    const b = req.body || {};
    const patch = { last_heartbeat_at: new Date().toISOString() };
    if (b.status && LIVE_STATUSES.has(b.status) && LIVE_STATUSES.has(s.status)) patch.status = b.status;
    const { error } = await supabase.from('meeting_recording_sessions').update(patch).eq('id', s.id);
    if (error) throw error;
    const hs = Number(b.highest_seq);
    if (Number.isInteger(hs) && hs >= 0) await supabase.from('meeting_recording_sessions').update({ highest_seq_seen: hs }).eq('id', s.id).or(`highest_seq_seen.is.null,highest_seq_seen.lt.${hs}`);
    res.json({ ok: true });
  } catch (e) { fail(res, 'heartbeat', e); }
});

// ---- markers (batch, idempotent) -> also rebuilds executive-session intervals
async function rebuildExecSessions(s) {
  const markers = await fetchAll(supabase, 'meeting_markers', { select: 'id, kind, occurred_at', filters: { session_id: s.id }, orderBy: 'occurred_at' });
  const { data: m, error: mErr } = await supabase.from('meetings').select('exec_session_recording').eq('id', s.meeting_id).single();
  if (mErr) throw mErr;
  const rows = []; let open = null;
  for (const k of markers.filter((x) => x.kind === 'exec_start' || x.kind === 'exec_end')) {
    if (k.kind === 'exec_start' && !open) open = k;
    else if (k.kind === 'exec_end' && open) { rows.push({ start: open, end: k }); open = null; }
  }
  if (open) rows.push({ start: open, end: null });
  const { error: dErr } = await supabase.from('meeting_executive_sessions').delete().eq('session_id', s.id);
  if (dErr) throw dErr;
  if (!rows.length) return 0;
  const { error: iErr } = await supabase.from('meeting_executive_sessions').insert(rows.map((r) => ({
    meeting_id: s.meeting_id, session_id: s.id, community_id: s.community_id, started_at: r.start.occurred_at, ended_at: r.end ? r.end.occurred_at : null,
    start_marker_id: r.start.id, end_marker_id: r.end ? r.end.id : null, audio_recorded: true, policy_at_time: m.exec_session_recording,
  })));
  if (iErr) throw iErr;
  return rows.length;
}

router.post('/sessions/:sid/markers', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const s = await sessionByKey(req, res); if (!s) return;
    const list = Array.isArray(req.body && req.body.markers) ? req.body.markers : [];
    if (!list.length) return res.status(400).json({ error: 'markers_required' });
    if (list.length > MAX_MARKERS_PER_CALL) return res.status(413).json({ error: 'too_many_markers', max: MAX_MARKERS_PER_CALL });
    const rows = [], rejected = [];
    for (const k of list) {
      const occurred = iso(k && k.occurred_at);
      if (!k || !CLIENT_ID.test(String(k.client_marker_id || '')) || !MARKER_KINDS.has(k.kind) || !occurred) { rejected.push({ client_marker_id: k && k.client_marker_id, kind: k && k.kind }); continue; }
      rows.push({ meeting_id: s.meeting_id, session_id: s.id, community_id: s.community_id, client_marker_id: k.client_marker_id, kind: k.kind,
        offset_ms: Number.isInteger(k.offset_ms) ? k.offset_ms : null, occurred_at: occurred, note: k.note ? String(k.note).slice(0, 1000) : null, created_by_user_id: s.started_by_user_id });
    }
    if (rows.length) {
      const { error } = await supabase.from('meeting_markers').upsert(rows, { onConflict: 'session_id,client_marker_id', ignoreDuplicates: true });
      if (error) throw error;
    }
    const execCount = rows.some((r) => r.kind === 'exec_start' || r.kind === 'exec_end') ? await rebuildExecSessions(s) : null;
    res.json({ ok: true, accepted: rows.length, rejected, executive_sessions: execCount });
  } catch (e) { fail(res, 'markers', e); }
});

// ---- completeness verification
async function runVerification(s) {
  const segments = await fetchAll(supabase, 'meeting_recording_segments', { select: 'seq, client_started_at, duration_ms, bytes, sha256, is_partial, audible', filters: { session_id: s.id }, orderBy: 'seq' });
  const markers = await fetchAll(supabase, 'meeting_markers', { select: 'kind, occurred_at', filters: { session_id: s.id }, orderBy: 'occurred_at' });
  const v = verifySession({ session: s, segments, markers });
  const patch = { verification: v, received_segment_count: v.received_count, received_bytes: v.received_bytes };
  if (s.client_stopped_at && ['stopped', 'verified', 'incomplete'].includes(s.status)) {
    patch.status = v.status;
    patch.verified_at = v.status === 'verified' ? new Date().toISOString() : null;
  }
  const { error } = await supabase.from('meeting_recording_sessions').update(patch).eq('id', s.id);
  if (error) throw error;
  if (patch.status) await supabase.from('meetings').update({ status: 'recorded' }).eq('id', s.meeting_id).eq('status', 'in_progress');
  return v;
}

router.post('/sessions/:sid/stop', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const s = await sessionByKey(req, res); if (!s) return;
    const b = req.body || {};
    const expected = Number(b.expected_segment_count);
    if (!Number.isInteger(expected) || expected < 0) return res.status(400).json({ error: 'expected_segment_count_required' });
    const stoppedAt = iso(b.stopped_at) || new Date().toISOString();
    const pauses = (Array.isArray(b.pauses) ? b.pauses : []).slice(0, 1000)
      .map((p) => ({ from: iso(p && p.from), to: iso(p && p.to) })).filter((p) => p.from && p.to && p.to >= p.from);
    const patch = { client_stopped_at: stoppedAt, expected_segment_count: expected, pauses, status: ['verified', 'incomplete'].includes(s.status) ? s.status : 'stopped' };
    const { data: upd, error } = await supabase.from('meeting_recording_sessions').update(patch).eq('id', s.id).select('*').single();
    if (error) throw error;
    const v = await runVerification(upd);
    res.json({ ok: true, verification: v });
  } catch (e) { fail(res, 'stop', e); }
});

router.get('/sessions/:sid/verification', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const { data: s, error } = await supabase.from('meeting_recording_sessions').select('*').eq('id', req.params.sid).maybeSingle();
    if (error) throw error;
    if (!s) return res.status(404).json({ error: 'session_not_found' });
    const v = await runVerification(s);
    // Report the status AFTER re-verification (a late-arriving piece can turn incomplete -> verified).
    const status = s.client_stopped_at && ['stopped', 'verified', 'incomplete'].includes(s.status) ? v.status : s.status;
    res.json({ session_id: s.id, status, verification: v });
  } catch (e) { fail(res, 'verification', e); }
});

router.get('/sessions/:sid', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const { data: s, error } = await supabase.from('meeting_recording_sessions').select('*').eq('id', req.params.sid).maybeSingle();
    if (error) throw error;
    if (!s) return res.status(404).json({ error: 'session_not_found' });
    res.json({ session: publicSession(s) });
  } catch (e) { fail(res, 'session get', e); }
});

router.get('/sessions/:sid/segments/:seq/audio', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.sid)) return res.status(400).json({ error: 'invalid_session' });
    const { data: row, error } = await supabase.from('meeting_recording_segments').select('storage_path').eq('session_id', req.params.sid).eq('seq', Number(req.params.seq)).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'segment_not_found' });
    const { data: su, error: sErr } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, 600);
    if (sErr || !su) return res.status(502).json({ error: 'signed_url_failed' });
    res.redirect(302, su.signedUrl);
  } catch (e) { fail(res, 'segment audio', e); }
});

router.get('/:id', async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid_meeting' });
    const { data: m, error } = await supabase.from('meetings').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'meeting_not_found' });
    const sessions = await fetchAll(supabase, 'meeting_recording_sessions', { filters: { meeting_id: m.id }, orderBy: 'client_started_at' });
    res.json({ meeting: m, sessions: sessions.map(publicSession) });
  } catch (e) { fail(res, 'meeting get', e); }
});

router.patch('/:id', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const u = await staffOnly(req, res); if (!u) return;
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid_meeting' });
    const b = req.body || {}, patch = {}, bad = [];
    if ('title' in b) { if (!String(b.title || '').trim()) bad.push('title'); else patch.title = String(b.title).trim().slice(0, 200); }
    if ('meeting_type' in b) { if (!MEETING_TYPES.has(b.meeting_type)) bad.push('meeting_type'); else patch.meeting_type = b.meeting_type; }
    if ('meeting_date' in b) { if (!DATE.test(String(b.meeting_date || ''))) bad.push('meeting_date'); else patch.meeting_date = b.meeting_date; }
    if ('scheduled_at' in b) { if (b.scheduled_at && !iso(b.scheduled_at)) bad.push('scheduled_at'); else patch.scheduled_at = b.scheduled_at ? iso(b.scheduled_at) : null; }
    if ('location' in b) patch.location = b.location ? String(b.location).slice(0, 200) : null;
    if ('status' in b) { if (!MEETING_STATUSES.has(b.status)) bad.push('status'); else patch.status = b.status; }
    for (const f of ['meeting_agenda_id', 'meeting_minutes_id', 'meeting_broadcast_id']) if (f in b) { if (b[f] && !UUID.test(String(b[f]))) bad.push(f); else patch[f] = b[f] || null; }
    if ('retention_policy' in b) { if (!RETENTION.has(b.retention_policy)) bad.push('retention_policy'); else patch.retention_policy = b.retention_policy; }
    if ('retention_days' in b) { const d = intOrNull(b.retention_days); if (Number.isNaN(d) || (d !== null && d <= 0)) bad.push('retention_days'); else patch.retention_days = d; }
    if ('record_ownership' in b) { if (!OWNERSHIP.has(b.record_ownership)) bad.push('record_ownership'); else patch.record_ownership = b.record_ownership; }
    if ('exec_session_recording' in b) { if (!EXEC_POLICY.has(b.exec_session_recording)) bad.push('exec_session_recording'); else patch.exec_session_recording = b.exec_session_recording; }
    if (bad.length) return res.status(400).json({ error: 'invalid_fields', fields: bad });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('meetings').update(patch).eq('id', req.params.id).select('*').maybeSingle();
    if (error) {
      if (/check constraint|foreign key/i.test(error.message)) return res.status(400).json({ error: 'invalid_fields', detail: 'a value or link was rejected' });
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'meeting_not_found' });
    res.json({ meeting: data });
  } catch (e) { fail(res, 'meeting patch', e); }
});

module.exports = router;
