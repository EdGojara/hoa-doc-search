// ============================================================================
// api/meeting_spike.js  (Phase 0 recording-feasibility spike, Ed 2026-09-22)
// ----------------------------------------------------------------------------
// THROWAWAY. Isolated test endpoint behind public/meeting-recorder-spike.html,
// used to prove that phones can record long in-person meetings as standalone,
// independently playable audio segments that upload progressively.
//
// Isolation / reversibility:
//   - OFF unless MEETING_SPIKE_ENABLED === 'true' (404 otherwise), so merging
//     this changes nothing in production until someone flips the env var.
//   - Touches NO database table. Writes only to its own private storage
//     bucket 'meeting-spike' (created on first use). Deleting the bucket,
//     this file, the page, and one mount line in server.js removes the spike.
//   - Behind the existing staff gate (not in _STAFF_GATE_PUBLIC).
//
// Routes (mounted at /api/meeting-spike):
//   POST /segment   raw audio body; headers x-spike-session, x-spike-seq,
//                   x-spike-sha256, x-spike-meta (JSON). Verifies sha256 and
//                   acks only after the storage write succeeds. Idempotent:
//                   same seq + same sha = re-ack; same seq + different sha =
//                   409 (never overwrite).
//   POST /report    JSON device report (segments, decode results, gap markers)
//   GET  /session/:id  what the server holds for a session (+ signed URLs)
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'meeting-spike';
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

router.use((req, res, next) => {
  if (process.env.MEETING_SPIKE_ENABLED !== 'true') return res.status(404).json({ error: 'not_found' });
  next();
});

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error('bucket list failed: ' + error.message);
  if (!(buckets || []).find((b) => b.name === BUCKET)) {
    const { error: cErr } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (cErr && !/already exists/i.test(cErr.message)) throw new Error('bucket create failed: ' + cErr.message);
  }
  bucketReady = true;
}

function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'mp4';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

router.post('/segment', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
  try {
    const session = String(req.get('x-spike-session') || '');
    const seq = Number(req.get('x-spike-seq'));
    const claimedSha = String(req.get('x-spike-sha256') || '').toLowerCase();
    const mime = String(req.get('content-type') || 'application/octet-stream');
    if (!SAFE_ID.test(session)) return res.status(400).json({ error: 'bad_session' });
    if (!Number.isInteger(seq) || seq < 0 || seq > 100000) return res.status(400).json({ error: 'bad_seq' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(400).json({ error: 'empty_body' });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (claimedSha && claimedSha !== sha) return res.status(422).json({ error: 'sha_mismatch', server_sha256: sha });

    await ensureBucket();
    const path = `${session}/${String(seq).padStart(6, '0')}.${extFor(mime)}`;
    const shaPath = `${path}.sha256`;
    // Idempotency: if this seq already landed, compare fingerprints.
    const { data: existing, error: exErr } = await supabase.storage.from(BUCKET).download(shaPath);
    if (!exErr && existing) {
      const prior = (await existing.text()).trim();
      if (prior === sha) return res.json({ ok: true, seq, sha256: sha, duplicate: true });
      return res.status(409).json({ error: 'seq_conflict', seq, existing_sha256: prior, received_sha256: sha });
    }
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message)) return res.status(502).json({ error: 'storage_write_failed', detail: upErr.message });
    const { error: shaErr } = await supabase.storage.from(BUCKET).upload(shaPath, Buffer.from(sha), { contentType: 'text/plain', upsert: false });
    if (shaErr && !/exists|duplicate/i.test(shaErr.message)) return res.status(502).json({ error: 'storage_write_failed', detail: shaErr.message });
    let meta = null;
    try { meta = JSON.parse(req.get('x-spike-meta') || 'null'); } catch (_) { /* optional */ }
    if (meta) {
      await supabase.storage.from(BUCKET).upload(`${path}.json`, Buffer.from(JSON.stringify({ ...meta, server_received_at: new Date().toISOString(), bytes: buf.length, sha256: sha })), { contentType: 'application/json', upsert: true });
    }
    res.json({ ok: true, seq, sha256: sha, bytes: buf.length });
  } catch (err) {
    console.error('[meeting-spike] segment failed:', err.message);
    res.status(500).json({ error: 'segment_failed' });
  }
});

router.post('/report', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const session = String((req.body && req.body.session_id) || '');
    if (!SAFE_ID.test(session)) return res.status(400).json({ error: 'bad_session' });
    await ensureBucket();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const { error } = await supabase.storage.from(BUCKET)
      .upload(`${session}/report-${stamp}.json`, Buffer.from(JSON.stringify(req.body, null, 2)), { contentType: 'application/json', upsert: false });
    if (error) return res.status(502).json({ error: 'storage_write_failed', detail: error.message });
    res.json({ ok: true });
  } catch (err) {
    console.error('[meeting-spike] report failed:', err.message);
    res.status(500).json({ error: 'report_failed' });
  }
});

router.get('/session/:id', async (req, res) => {
  try {
    const session = String(req.params.id || '');
    if (!SAFE_ID.test(session)) return res.status(400).json({ error: 'bad_session' });
    await ensureBucket();
    const { data: files, error } = await supabase.storage.from(BUCKET).list(session, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error) return res.status(502).json({ error: 'list_failed', detail: error.message });
    const audio = (files || []).filter((f) => /^\d{6}\.(webm|mp4|ogg|wav)$/.test(f.name));
    const segments = [];
    for (const f of audio) {
      const { data: su } = await supabase.storage.from(BUCKET).createSignedUrl(`${session}/${f.name}`, 3600);
      segments.push({ seq: Number(f.name.slice(0, 6)), name: f.name, bytes: f.metadata && f.metadata.size, url: su && su.signedUrl });
    }
    const seqs = segments.map((s) => s.seq);
    const max = seqs.length ? Math.max(...seqs) : -1;
    const missing = [];
    for (let i = 0; i <= max; i++) if (!seqs.includes(i)) missing.push(i);
    res.json({ session, count: segments.length, max_seq: max, missing, segments });
  } catch (err) {
    console.error('[meeting-spike] session read failed:', err.message);
    res.status(500).json({ error: 'session_failed' });
  }
});

module.exports = router;
