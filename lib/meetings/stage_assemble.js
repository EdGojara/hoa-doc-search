// ============================================================================
// lib/meetings/stage_assemble.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Pipeline stage 1: join a verified session's stored pieces into one file
// (lib/meetings/assemble.js), store it next to the pieces, and record its
// checksum, duration, timeline, gaps and executive-session ranges in
// meeting_audio_assemblies. Idempotent: a re-run rebuilds and replaces both.
//
// Storage: meeting-audio/<community>/<meeting>/<session>/processed/combined.webm
// (the pieces live in the same <session>/ folder).
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fetchAll } = require('../db/fetch_all');
const { assembleSession } = require('./assemble');
const { PermanentError } = require('./pipeline');

const BUCKET = 'meeting-audio';
const combinedPath = (s) => `${s.community_id}/${s.meeting_id}/${s.id}/processed/combined.webm`;

async function downloadBuffer(supabase, p) {
  const { data, error } = await supabase.storage.from(BUCKET).download(p);
  if (error || !data) throw new Error(`could not read stored piece ${p}: ${error ? error.message : 'empty'}`);
  return Buffer.from(await data.arrayBuffer());
}

async function assembleStage({ job, supabase }) {
  const { data: s, error } = await supabase.from('meeting_recording_sessions').select('*').eq('id', job.session_id).single();
  if (error) throw error;
  if (s.status !== 'verified') throw new PermanentError(`recording session is ${s.status}, not verified`);
  const segments = await fetchAll(supabase, 'meeting_recording_segments', {
    select: 'seq, client_started_at, duration_ms, mime, session_scope, storage_path, sha256, bytes', filters: { session_id: s.id }, orderBy: 'seq',
  });
  if (!segments.length) throw new PermanentError('recording session has no stored pieces');
  const execIntervals = await fetchAll(supabase, 'meeting_executive_sessions', { select: 'started_at, ended_at', filters: { session_id: s.id }, orderBy: 'started_at' });

  const out = path.join(os.tmpdir(), `mtg-combined-${s.id}-${crypto.randomBytes(3).toString('hex')}.webm`);
  try {
    const meta = await assembleSession({
      session: s, segments, verification: s.verification, execIntervals, outPath: out,
      loadPiece: async (seg) => {
        const buf = await downloadBuffer(supabase, seg.storage_path);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha !== seg.sha256) throw new PermanentError(`stored piece ${seg.seq} does not match its checksum`);
        return buf;
      },
    });
    const storagePath = combinedPath(s);
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, await fs.promises.readFile(out), { contentType: 'audio/webm', upsert: true });
    if (upErr) throw new Error('storing the joined audio failed: ' + upErr.message);
    const row = {
      session_id: s.id, meeting_id: s.meeting_id, community_id: s.community_id, status: 'ready', storage_path: storagePath,
      mime: meta.mime, bytes: meta.bytes, sha256: meta.sha256, duration_ms: meta.duration_ms, meeting_span_ms: meta.meeting_span_ms,
      sample_rate: meta.sample_rate, segment_count: meta.segment_count, timeline: meta.timeline, gaps: meta.gaps, exec_ranges: meta.exec_ranges,
      boundaries: meta.boundaries, source_verification: s.verification || null, ffmpeg_version: meta.ffmpeg_version, record_ownership: s.record_ownership || 'undetermined',
    };
    const { data: saved, error: aErr } = await supabase.from('meeting_audio_assemblies').upsert(row, { onConflict: 'session_id' }).select('id').single();
    if (aErr) throw aErr;
    const matched = meta.boundaries.filter((b) => b.method === 'waveform' || b.method === 'envelope').length;
    return { assembly_id: saved.id, duration_ms: meta.duration_ms, segments: meta.segment_count, boundaries: meta.boundaries.length, boundaries_matched_from_audio: matched, gaps: meta.gaps.length, exec_ranges: meta.exec_ranges.length };
  } finally {
    fs.promises.unlink(out).catch(() => {});
  }
}

module.exports = { assembleStage, combinedPath, BUCKET };
