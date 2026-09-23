// ============================================================================
// lib/meetings/assemble.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Joins a verified recording session's ~30 s pieces into ONE continuous audio
// file (ffmpeg, via the ffmpeg-static binary).
//
// How the pieces overlap: Meeting Recorder starts the next MediaRecorder about
// 0.5 s BEFORE stopping the previous one, so rotation never drops audio. The
// same half second is therefore in both pieces. Joining must remove exactly
// that duplicate, no more (lost words) and no less (repeated words).
//
// Per boundary:
//   1. The recorded wall-clock timestamps give the EXPECTED overlap.
//   2. The audio itself gives the MEASURED overlap: the loudness envelope of
//      the previous piece's tail is matched against the next piece's head
//      (5 ms resolution), then refined sample-by-sample on the waveform.
//      Both pieces heard the same sound, so the match is where it lines up.
//   3. If the overlap is silent (nothing to match) the timestamp is used;
//      a silent overlap cannot duplicate or drop a word.
//   4. The cut is made in the MIDDLE of the overlap (encoder edges are the
//      least reliable audio in each piece).
// Holes between pieces (pause, interruption, a missing piece) are NOT filled
// with audio. They are listed in `gaps` with the audio position where the
// join happened, so the transcript can show "not recorded" there.
//
// Meeting time: ms since the session's client_started_at. Within a run of
// back-to-back pieces the meeting time is chained sample-accurately through
// the measured overlaps; after a hole it re-anchors to the piece's timestamp.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SR = 16000;                 // output / analysis sample rate (speech)
const HOP = 80;                   // 5 ms envelope hop at 16 kHz
const SEARCH_MS = 400;            // +/- search around the timestamp estimate
const MIN_MATCH_MS = 150;         // shorter overlaps: trust the timestamp
const HOLE_MS = 50;               // a hole shorter than this is timing jitter, not a gap
const ENV_MIN_SCORE = 0.6;        // envelope correlation needed to trust the match
const WAVE_MIN_SCORE = 0.5;       // waveform correlation needed to use the sample-level refinement
const TIE_BREAK = 0.05;           // max score handicap for the candidate farthest from the timestamp
const SILENCE_RMS = 60;           // int16 RMS below which the overlap is "silent"
const OPUS_BITRATE = '24k';

function ffmpegPath() {
  const p = process.env.FFMPEG_PATH || require('ffmpeg-static');
  if (!p) throw new Error('ffmpeg binary not available');
  return p;
}
function ffmpegVersion() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-hide_banner', '-version'], { timeout: 15000 }, (err, out) => resolve(err ? null : String(out).split('\n')[0].trim().slice(0, 200)));
  });
}

// Decode any piece (webm/opus, mp4/aac, ogg) to 16 kHz mono int16 PCM.
// Written to a temp file first: MP4 from iOS keeps its index at the end and
// cannot be decoded from a pipe.
async function decodeToPcm(buf, ext = 'bin') {
  const tmp = path.join(os.tmpdir(), `mtg-piece-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  await fs.promises.writeFile(tmp, buf);
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SR), 'pipe:1']);
      const out = [], err = [];
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => err.push(d));
      p.on('error', reject);
      p.on('close', (code) => {
        const b = Buffer.concat(out);
        if (code !== 0 && !b.length) return reject(new Error('ffmpeg decode failed: ' + Buffer.concat(err).toString().slice(0, 300)));
        const pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
        resolve(Int16Array.from(pcm));
      });
    });
  } finally { fs.promises.unlink(tmp).catch(() => {}); }
}

// ---------------------------------------------------------------- matching
function envelope(pcm, from, to) {
  const n = Math.max(0, Math.floor((to - from) / HOP));
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const b = from + i * HOP;
    for (let j = 0; j < HOP; j++) { const v = pcm[b + j] || 0; s += v * v; }
    e[i] = Math.log10(1 + Math.sqrt(s / HOP));
  }
  return e;
}
function pearson(a, ai, b, bi, n) {
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[ai + i]; sb += b[bi + i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[ai + i] - ma, y = b[bi + i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
function rms(pcm, from, to) {
  let s = 0; const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / n);
}

/**
 * How many samples at the START of `next` repeat the END of `prev`.
 * expectedMs comes from the timestamps. Returns { overlap, method, score }.
 */
function measureOverlap(prev, next, expectedMs) {
  const exp = Math.round((expectedMs / 1000) * SR);
  const clampD = (d) => Math.max(0, Math.min(d, prev.length, next.length));
  if (expectedMs < MIN_MATCH_MS) return { overlap: clampD(exp), method: 'timestamp_short', score: null };
  const lo = clampD(exp - Math.round((SEARCH_MS / 1000) * SR));
  const hi = clampD(exp + Math.round((SEARCH_MS / 1000) * SR));
  const minD = Math.round((MIN_MATCH_MS / 1000) * SR);
  // Silent overlap: nothing to match, and nothing to duplicate or lose.
  const tailFrom = Math.max(0, prev.length - hi);
  if (rms(prev, tailFrom, prev.length) < SILENCE_RMS || rms(next, 0, Math.min(next.length, hi)) < SILENCE_RMS) {
    return { overlap: clampD(exp), method: 'timestamp_silent', score: null };
  }
  // 1) envelope match, 5 ms steps
  const pEnvFrom = Math.max(0, prev.length - hi - HOP);
  const pEnv = envelope(prev, pEnvFrom, prev.length);
  const nEnv = envelope(next, 0, Math.min(next.length, hi + HOP));
  // A small preference for the timestamp breaks ties when the sound repeats
  // (a steady beat, HVAC cycling): equally good matches one beat apart must
  // not win over the one the clock says is right.
  const span = Math.max(1, hi - lo);
  let best = { d: clampD(exp), score: -2, adj: -9 };
  for (let d = Math.max(lo, minD); d <= hi; d += HOP) {
    const m = Math.min(Math.floor(d / HOP), 120);                 // compare up to 0.6 s
    const pi = Math.floor((prev.length - d - pEnvFrom) / HOP);
    if (pi < 0 || m < 8 || pi + m > pEnv.length || m > nEnv.length) continue;
    const sc = pearson(pEnv, pi, nEnv, 0, m);
    const adj = sc - TIE_BREAK * (Math.abs(d - exp) / span);
    if (adj > best.adj) best = { d, score: sc, adj };
  }
  if (best.score < ENV_MIN_SCORE) return { overlap: clampD(exp), method: 'timestamp_no_match', score: +best.score.toFixed(3) };
  // 2) waveform refinement, +/- 2 hops, sample steps
  const pf = Float64Array.from(prev), nf = Float64Array.from(next.subarray(0, Math.min(next.length, hi + 2 * HOP)));
  let fine = { d: best.d, score: -2 };
  for (let d = clampD(best.d - 2 * HOP); d <= clampD(best.d + 2 * HOP); d++) {
    const m = Math.min(d, 4000);
    if (m < 400) continue;
    const sc = pearson(pf, prev.length - d, nf, 0, m);
    if (sc > fine.score) fine = { d, score: sc };
  }
  if (fine.score >= WAVE_MIN_SCORE) return { overlap: fine.d, method: 'waveform', score: +fine.score.toFixed(3), envelope_score: +best.score.toFixed(3) };
  return { overlap: best.d, method: 'envelope', score: +best.score.toFixed(3) };
}

// ---------------------------------------------------------------- encoding
function createEncoder(outPath) {
  const p = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', OPUS_BITRATE, '-application', 'voip', '-f', 'webm', outPath]);
  const err = [];
  p.stderr.on('data', (d) => err.push(d));
  const done = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg encode failed: ' + Buffer.concat(err).toString().slice(0, 300)))));
  });
  let samples = 0;
  return {
    get samples() { return samples; },
    write(pcm) {
      if (!pcm.length) return Promise.resolve();
      samples += pcm.length;
      const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
      return new Promise((resolve, reject) => { p.stdin.write(b, (e) => (e ? reject(e) : resolve())); });
    },
    async end() { p.stdin.end(); await done; },
  };
}
async function sha256File(p) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => { fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', resolve).on('error', reject); });
  return h.digest('hex');
}

// ---------------------------------------------------------------- timeline
const ms = (samples) => Math.round((samples / SR) * 1000);
const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

function gapReason(fromMs, toMsV, verification, missing) {
  if (missing) return 'missing_segment';
  const len = toMsV - fromMs;
  let bestReason = null, bestOv = 0;
  for (const g of (verification && verification.gaps) || []) {
    const ov = Math.max(0, Math.min(toMsV, g.to_ms) - Math.max(fromMs, g.from_ms));
    if (ov > bestOv) { bestOv = ov; bestReason = g.reason; }
  }
  return bestOv >= 0.5 * len && bestReason ? bestReason : 'short_gap';
}

// meeting ms -> audio ms using the timeline; `edge` decides where a time
// that falls inside a hole lands ('next' = following audio, 'prev' = end of previous).
function meetingToAudio(timeline, mMs, edge) {
  if (!timeline.length) return 0;
  for (let i = 0; i < timeline.length; i++) {
    const p = timeline[i];
    const pEnd = p.meeting_from_ms + (p.audio_to_ms - p.audio_from_ms);
    if (mMs >= p.meeting_from_ms && mMs <= pEnd) return p.audio_from_ms + (mMs - p.meeting_from_ms);
    if (mMs < p.meeting_from_ms) return edge === 'prev' && i > 0 ? timeline[i - 1].audio_to_ms : p.audio_from_ms;
  }
  return timeline[timeline.length - 1].audio_to_ms;
}
function execRangesFor({ t0, timeline, execIntervals, segments, stoppedMs }) {
  const out = [];
  const lastAudio = timeline.length ? timeline[timeline.length - 1].audio_to_ms : 0;
  const lastMeeting = timeline.length ? timeline[timeline.length - 1].meeting_from_ms + (lastAudio - timeline[timeline.length - 1].audio_from_ms) : 0;
  for (const x of execIntervals || []) {
    const mf = toMs(x.started_at) - t0;
    const mt = x.ended_at ? toMs(x.ended_at) - t0 : Math.max(lastMeeting, stoppedMs != null ? stoppedMs : 0);
    const af = meetingToAudio(timeline, mf, 'next'), at = meetingToAudio(timeline, mt, 'prev');
    out.push({ meeting_from_ms: Math.round(mf), meeting_to_ms: Math.round(mt), audio_from_ms: Math.round(af), audio_to_ms: Math.round(Math.max(af, at)), open_ended: !x.ended_at, source: 'markers' });
  }
  // A piece the device marked executive with no marker interval over it: treat the whole piece as executive (conservative).
  for (const s of segments || []) {
    if (s.session_scope !== 'executive') continue;
    const p = timeline.find((t) => t.seq === s.seq);
    if (!p) continue;
    const covered = out.some((r) => r.audio_from_ms < p.audio_to_ms && r.audio_to_ms > p.audio_from_ms);
    if (!covered) out.push({ meeting_from_ms: p.meeting_from_ms, meeting_to_ms: p.meeting_from_ms + (p.audio_to_ms - p.audio_from_ms), audio_from_ms: p.audio_from_ms, audio_to_ms: p.audio_to_ms, open_ended: false, source: 'segment_flag' });
  }
  return out.sort((a, b) => a.audio_from_ms - b.audio_from_ms);
}

/**
 * Join a session's pieces.
 *   session        { client_started_at, client_stopped_at }
 *   segments       rows sorted or not: { seq, client_started_at, duration_ms, mime, session_scope }
 *   loadPiece(seg) -> Promise<Buffer> of that piece's stored bytes
 *   verification   the session's verification (for gap reasons)
 *   execIntervals  meeting_executive_sessions rows { started_at, ended_at }
 *   outPath        where to write the joined .webm
 * Returns metadata; the caller uploads outPath.
 */
async function assembleSession({ session, segments, loadPiece, verification, execIntervals, outPath }) {
  const t0 = toMs(session.client_started_at);
  const stoppedMs = session.client_stopped_at ? toMs(session.client_stopped_at) - t0 : null;
  const segs = [...segments].sort((a, b) => a.seq - b.seq);
  if (!segs.length) throw new Error('no segments to assemble');
  const enc = createEncoder(outPath);
  const timeline = [], gaps = [], boundaries = [];
  let prev = null;          // { seg, pcm, meetingFrom, keptFrom }
  let audioCursor = 0;      // samples written
  const ext = (m) => (/mp4|aac|m4a/i.test(m || '') ? 'mp4' : /ogg/i.test(m || '') ? 'ogg' : 'webm');
  try {
    for (const seg of segs) {
      const pcm = await decodeToPcm(await loadPiece(seg), ext(seg.mime));
      if (!pcm.length) throw new Error(`piece ${seg.seq} decoded to no audio`);
      const stampMs = toMs(seg.client_started_at) - t0;
      if (!prev) {
        prev = { seg, pcm, meetingFrom: stampMs, keptFrom: 0 };
        continue;
      }
      const prevEndMeeting = prev.meetingFrom + ms(prev.pcm.length);
      const expectedOverlapMs = prevEndMeeting - stampMs;
      const contiguous = seg.seq === prev.seg.seq + 1;
      if (contiguous && expectedOverlapMs > -HOLE_MS) {
        // Back-to-back pieces: remove the duplicated overlap, cut in its middle.
        const m = measureOverlap(prev.pcm, pcm, expectedOverlapMs);
        const keepPrevTo = prev.pcm.length - Math.floor(m.overlap / 2);
        const dropNext = m.overlap - Math.floor(m.overlap / 2);
        await flush(prev, keepPrevTo);
        const nextMeetingFrom = prev.meetingFrom + ms(prev.pcm.length - m.overlap);   // chained, sample-accurate
        boundaries.push({ after_seq: prev.seg.seq, before_seq: seg.seq, expected_overlap_ms: Math.round(expectedOverlapMs), measured_overlap_ms: ms(m.overlap),
          method: m.method, score: m.score, drift_ms: Math.round(nextMeetingFrom - stampMs), at_audio_ms: ms(audioCursor) });
        prev = { seg, pcm, meetingFrom: nextMeetingFrom, keptFrom: dropNext };
      } else {
        // A hole (pause, interruption, missing piece, or a jump in time): never filled with audio.
        await flush(prev, prev.pcm.length);
        const from = prevEndMeeting, to = Math.max(stampMs, prevEndMeeting);
        gaps.push({ at_audio_ms: ms(audioCursor), meeting_from_ms: Math.round(from), meeting_to_ms: Math.round(to), ms: Math.round(to - from),
          reason: gapReason(from, to, verification, !contiguous), after_seq: prev.seg.seq, before_seq: seg.seq });
        prev = { seg, pcm, meetingFrom: stampMs, keptFrom: 0 };
      }
    }
    await flush(prev, prev.pcm.length);
    await enc.end();
  } catch (e) {
    try { await enc.end(); } catch (_) {}
    throw e;
  }

  async function flush(p, keepTo) {
    const part = p.pcm.subarray(p.keptFrom, Math.max(p.keptFrom, keepTo));
    timeline.push({ seq: p.seg.seq, audio_from_ms: ms(audioCursor), audio_to_ms: ms(audioCursor + part.length), meeting_from_ms: Math.round(p.meetingFrom + ms(p.keptFrom)), src_from_ms: ms(p.keptFrom) });
    audioCursor += part.length;
    await enc.write(part);
  }

  const stat = await fs.promises.stat(outPath);
  const last = timeline[timeline.length - 1];
  return {
    bytes: stat.size, sha256: await sha256File(outPath), mime: 'audio/webm;codecs=opus', sample_rate: SR,
    duration_ms: ms(audioCursor), samples: audioCursor,
    meeting_span_ms: Math.round(last.meeting_from_ms + (last.audio_to_ms - last.audio_from_ms) - timeline[0].meeting_from_ms),
    segment_count: segs.length, timeline, gaps, boundaries,
    exec_ranges: execRangesFor({ t0, timeline, execIntervals, segments: segs, stoppedMs }),
    ffmpeg_version: await ffmpegVersion(),
  };
}

module.exports = { assembleSession, measureOverlap, decodeToPcm, meetingToAudio, execRangesFor, ffmpegPath, ffmpegVersion, SR };
