// ============================================================================
// lib/meetings/transcribe.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Deepgram PRERECORDED transcription of a joined meeting file, and
// normalization of the response into transcript segments.
//
// Request features: diarize, utterances, punctuate, smart_format; word-level
// start/end/confidence are always in the prerecorded response.
// The model is configurable (MEETING_STT_MODEL); the default was chosen by a
// side-by-side test on real and synthetic board-meeting audio (see
// tmp/mi/model_compare.js and the Step 2 report).
//
// Normalization (pure, no I/O):
//   - each Deepgram utterance becomes one or more segments
//   - utterances are SPLIT at recording gaps (audio joined across a pause must
//     not read as one sentence) and at executive-session boundaries (no
//     segment is partly executive)
//   - each segment gets audio start/end, meeting-time start/end (via the
//     assembly timeline), speaker number, text, mean word confidence, scope
// ============================================================================
const { meetingToAudio } = require('./assemble');

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const DEFAULT_MODEL = 'nova-3';
const REQUEST_PARAMS = { diarize: 'true', utterances: 'true', punctuate: 'true', smart_format: 'true', language: 'en' };

function modelName() { return process.env.MEETING_STT_MODEL || DEFAULT_MODEL; }

/** POST the audio bytes to Deepgram. Returns { raw (parsed), rawText, params, requestId }. */
async function deepgramTranscribe(buf, { mime = 'audio/webm', model = modelName(), apiKey = process.env.DEEPGRAM_API_KEY, fetchImpl = fetch, timeoutMs = 15 * 60 * 1000 } = {}) {
  if (!apiKey) { const e = new Error('DEEPGRAM_API_KEY is not set on the server'); e.permanent = true; throw e; }
  const params = { model, ...REQUEST_PARAMS };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try {
    r = await fetchImpl(`${DEEPGRAM_URL}?${new URLSearchParams(params)}`, { method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mime }, body: buf, signal: ctl.signal });
  } catch (e) {
    throw new Error('Deepgram could not be reached: ' + (e.name === 'AbortError' ? 'timed out' : e.message));
  } finally { clearTimeout(timer); }
  const rawText = await r.text();
  if (!r.ok) {
    const e = new Error(`Deepgram returned HTTP ${r.status}: ${rawText.slice(0, 300)}`);
    if ([400, 401, 402, 403].includes(r.status)) e.permanent = true;   // bad key / bad audio / out of credit: retrying will not help
    throw e;
  }
  let raw;
  try { raw = JSON.parse(rawText); } catch (_) { throw new Error('Deepgram returned a response that is not JSON'); }
  if (!raw.results || !Array.isArray(raw.results.utterances)) throw new Error('Deepgram response has no utterances (was utterances=true honored?)');
  return { raw, rawText, params, requestId: (raw.metadata && raw.metadata.request_id) || r.headers.get('dg-request-id') || null };
}

// audio ms -> meeting ms using the assembly timeline
function audioToMeeting(timeline, aMs) {
  for (const p of timeline || []) if (aMs >= p.audio_from_ms && aMs <= p.audio_to_ms) return Math.round(p.meeting_from_ms + (aMs - p.audio_from_ms));
  const last = (timeline || [])[timeline.length - 1];
  return last ? Math.round(last.meeting_from_ms + (aMs - last.audio_from_ms)) : Math.round(aMs);
}

/**
 * raw: Deepgram response; assembly: { timeline, gaps, exec_ranges }.
 * Returns { segments:[{idx, speaker, start_ms, end_ms, meeting_start_ms, meeting_end_ms, text, confidence, word_count, scope, after_gap}], stats }
 */
function normalizeTranscript(raw, assembly) {
  const cuts = new Set();
  for (const g of assembly.gaps || []) cuts.add(Math.round(g.at_audio_ms));
  for (const r of assembly.exec_ranges || []) { cuts.add(Math.round(r.audio_from_ms)); cuts.add(Math.round(r.audio_to_ms)); }
  const cutList = [...cuts].sort((a, b) => a - b);
  const gapAt = new Set((assembly.gaps || []).map((g) => Math.round(g.at_audio_ms)));
  const execRanges = assembly.exec_ranges || [];
  const isExec = (aMs) => execRanges.some((r) => aMs >= r.audio_from_ms && aMs < r.audio_to_ms);
  // which cut region a time falls in
  const region = (aMs) => { let i = 0; while (i < cutList.length && aMs >= cutList[i]) i++; return i; };

  const out = [];
  const utts = (raw.results && raw.results.utterances) || [];
  for (const u of utts) {
    const words = (u.words && u.words.length ? u.words : [{ word: u.transcript, punctuated_word: u.transcript, start: u.start, end: u.end, confidence: u.confidence, speaker: u.speaker }]);
    let group = [], groupRegion = null;
    const flush = () => {
      if (!group.length) return;
      const startMs = Math.round(group[0].start * 1000), endMs = Math.round(group[group.length - 1].end * 1000);
      const mid = (startMs + endMs) / 2;
      const conf = group.reduce((t, w) => t + (Number(w.confidence) || 0), 0) / group.length;
      const text = group.map((w) => w.punctuated_word || w.word).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
      const speakers = group.map((w) => w.speaker).filter((x) => Number.isInteger(x));
      const speaker = speakers.length ? mode(speakers) : (Number.isInteger(u.speaker) ? u.speaker : null);
      out.push({
        speaker, start_ms: startMs, end_ms: Math.max(startMs, endMs),
        meeting_start_ms: audioToMeeting(assembly.timeline, startMs), meeting_end_ms: audioToMeeting(assembly.timeline, endMs),
        text, confidence: +conf.toFixed(4), word_count: group.length, scope: isExec(mid) ? 'executive' : 'open', after_gap: false,
      });
      group = [];
    };
    for (const w of words) {
      const reg = region(Math.round(((w.start + w.end) / 2) * 1000));
      if (groupRegion !== null && reg !== groupRegion) flush();
      groupRegion = reg;
      group.push(w);
    }
    flush();
  }
  out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  out.forEach((s, i) => { s.idx = i; });
  for (const at of gapAt) { const first = out.find((s) => s.start_ms >= at); if (first) first.after_gap = true; }
  const words = out.reduce((t, s) => t + s.word_count, 0);
  const speakers = new Set(out.map((s) => s.speaker).filter((x) => x != null));
  return {
    segments: out,
    stats: { segment_count: out.length, word_count: words, speaker_count: speakers.size,
      avg_confidence: words ? +(out.reduce((t, s) => t + s.confidence * s.word_count, 0) / words).toFixed(4) : null },
  };
}
function mode(arr) { const m = new Map(); let best = arr[0], n = 0; for (const x of arr) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } } return best; }

module.exports = { deepgramTranscribe, normalizeTranscript, audioToMeeting, modelName, REQUEST_PARAMS, DEFAULT_MODEL, meetingToAudio };
