// ============================================================================
// lib/meetings/stage_transcribe.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Pipeline stage 2: send the joined audio (stage 1) to Deepgram prerecorded,
// keep the raw response verbatim in storage, and save normalized,
// speaker-numbered transcript segments. A re-run makes a NEW transcript and
// marks the previous one not-current (nothing is overwritten in place).
// Speaker mappings belong to a transcript (Deepgram's speaker numbers can
// differ between runs), so a new transcript starts unmapped.
// ============================================================================
const crypto = require('crypto');
const { deepgramTranscribe, normalizeTranscript } = require('./transcribe');
const { PermanentError } = require('./pipeline');
const { BUCKET } = require('./stage_assemble');

const INSERT_BATCH = 500;

async function transcribeStage({ job, supabase, transcribe = deepgramTranscribe }) {
  const { data: a, error } = await supabase.from('meeting_audio_assemblies').select('*').eq('session_id', job.session_id).maybeSingle();
  if (error) throw error;
  if (!a) throw new PermanentError('the joined audio is missing; retry from "Joining audio"');
  const { data: s, error: sErr } = await supabase.from('meeting_recording_sessions').select('id, meeting_id, community_id, record_ownership').eq('id', job.session_id).single();
  if (sErr) throw sErr;

  const { data: blob, error: dErr } = await supabase.storage.from(BUCKET).download(a.storage_path);
  if (dErr || !blob) throw new Error('could not read the joined audio: ' + (dErr ? dErr.message : 'empty'));
  const buf = Buffer.from(await blob.arrayBuffer());
  const audioSha = crypto.createHash('sha256').update(buf).digest('hex');
  if (audioSha !== a.sha256) throw new PermanentError('the joined audio does not match its checksum; retry from "Joining audio"');

  const dg = await transcribe(buf, { mime: 'audio/webm' });
  const norm = normalizeTranscript(dg.raw, a);
  if (!norm.segments.length) throw new PermanentError('Deepgram heard no speech in this recording');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = `${s.community_id}/${s.meeting_id}/${s.id}/processed/deepgram-${stamp}.json`;
  const rawBuf = Buffer.from(dg.rawText, 'utf8');
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(rawPath, rawBuf, { contentType: 'application/json', upsert: true });
  if (upErr) throw new Error('storing the raw Deepgram response failed: ' + upErr.message);

  const own = s.record_ownership || 'undetermined';
  const { error: oldErr } = await supabase.from('meeting_transcripts').update({ is_current: false }).eq('session_id', s.id).eq('is_current', true);
  if (oldErr) throw oldErr;
  const { data: t, error: tErr } = await supabase.from('meeting_transcripts').insert({
    session_id: s.id, assembly_id: a.id, meeting_id: s.meeting_id, community_id: s.community_id, is_current: true, status: 'ready', provider: 'deepgram',
    model: dg.params.model, request_params: dg.params, provider_request_id: dg.requestId, raw_storage_path: rawPath,
    raw_sha256: crypto.createHash('sha256').update(rawBuf).digest('hex'), raw_bytes: rawBuf.length, audio_sha256: audioSha,
    duration_ms: dg.raw.metadata && dg.raw.metadata.duration != null ? Math.round(dg.raw.metadata.duration * 1000) : a.duration_ms,
    speaker_count: norm.stats.speaker_count, segment_count: norm.stats.segment_count, word_count: norm.stats.word_count, avg_confidence: norm.stats.avg_confidence,
    record_ownership: own,
  }).select('id').single();
  if (tErr) throw tErr;
  for (let i = 0; i < norm.segments.length; i += INSERT_BATCH) {
    const rows = norm.segments.slice(i, i + INSERT_BATCH).map((x) => ({ ...x, transcript_id: t.id, session_id: s.id, community_id: s.community_id, record_ownership: own }));
    const { error: gErr } = await supabase.from('meeting_transcript_segments').insert(rows);
    if (gErr) throw gErr;
  }
  return { transcript_id: t.id, model: dg.params.model, ...norm.stats, executive_segments: norm.segments.filter((x) => x.scope === 'executive').length };
}

module.exports = { transcribeStage };
