// tests/test_meeting_assembly.js  (Ed 2026-09-23)
// Proves the audio join (lib/meetings/assemble.js) neither repeats nor drops
// audio at segment boundaries, using KNOWN TONES.
//
// Ground truth: a beep every 250 ms (60 ms long), its pitch cycling through 7
// notes, over a faint noise floor. The test cuts it into pieces exactly the
// way Meeting Recorder does (next piece starts 0.5 s before the previous one
// stops), with realistic timestamp jitter and encoder start latency, encodes
// each piece independently as WebM/Opus (what the browser produces), joins
// them, decodes the result and finds every beep.
//   - a repeated half second would add 2 beeps and break the pitch cycle
//   - a lost stretch would remove beeps or shift every later beep
// Every beep must be present exactly once, in order, within +/-15 ms of where
// it belongs. Also covers a user pause (a hole that must NOT be filled) and a
// silent overlap. Needs the ffmpeg-static binary (npm install); no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assembleSession, decodeToPcm, ffmpegPath, SR } = require('../lib/meetings/assemble');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); } }

const FREQS = [523, 659, 784, 880, 1047, 1319, 1568];
const BEEP_EVERY = 0.25, BEEP_LEN = 0.06;
// Deterministic PRNG so failures reproduce.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function groundTruth(seconds, { silentFrom = null, silentTo = null } = {}) {
  const n = Math.round(seconds * SR), pcm = new Int16Array(n), r = rng(7);
  const beeps = [];
  for (let k = 0; (k + 1) * BEEP_EVERY < seconds; k++) {
    const t0 = k * BEEP_EVERY;
    if (silentFrom != null && t0 >= silentFrom && t0 < silentTo) continue;
    beeps.push({ k, t: t0, f: FREQS[k % FREQS.length] });
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const quiet = silentFrom != null && t >= silentFrom && t < silentTo;
    let v = quiet ? 0 : (r() - 0.5) * 300;                     // faint noise floor
    const k = Math.floor(t / BEEP_EVERY), dt = t - k * BEEP_EVERY;
    if (!quiet && dt < BEEP_LEN && (k + 1) * BEEP_EVERY < seconds) {
      const env = Math.min(1, dt / 0.005, (BEEP_LEN - dt) / 0.005);
      v += 9000 * env * Math.sin(2 * Math.PI * FREQS[k % FREQS.length] * t);
    }
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return { pcm, beeps };
}

function encodeWebm(pcm) {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'], { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2), maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('encode failed: ' + r.stderr.toString());
  return r.stdout;
}

// Goertzel power of one frequency over a window.
function goertzel(pcm, from, n, f) {
  const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = (pcm[from + i] || 0) + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
// Find beep onsets: 2.5 ms hops, 10 ms windows, threshold on the strongest note.
function findBeeps(pcm) {
  const hop = 40, win = 160, out = [];
  let on = false;
  const noise = goertzel(new Int16Array(win).fill(0), 0, win, 523) + 1;
  let peakRef = 0;
  const powers = [];
  for (let i = 0; i + win < pcm.length; i += hop) {
    let best = 0, bf = 0;
    for (const f of FREQS) { const p = goertzel(pcm, i, win, f); if (p > best) { best = p; bf = f; } }
    powers.push({ i, best, bf });
    if (best > peakRef) peakRef = best;
  }
  const thr = peakRef * 0.05 + noise;
  for (const p of powers) {
    if (!on && p.best > thr) { on = true; out.push({ t: (p.i + win / 2) / SR, f: p.bf, fAt: p.i }); }
    else if (on && p.best < thr * 0.3) on = false;
  }
  // Settle each beep's pitch 20 ms after onset (onset window can straddle).
  for (const b of out) {
    let best = 0, bf = 0;
    for (const f of FREQS) { const p = goertzel(pcm, b.fAt + 320, win, f); if (p > best) { best = p; bf = f; } }
    b.f = bf;
  }
  return out;
}

/**
 * Cut ground truth into recorder-style pieces.
 * spans: [{from, to}] seconds of real recording (a pause splits spans).
 */
function recordPieces(gt, spans, { segS = 30, overlapS = 0.5, jitterMs = 60, latencyMs = 40, seed = 3 } = {}) {
  const r = rng(seed), pieces = [];
  let seq = 0;
  for (const sp of spans) {
    for (let a = sp.from; a < sp.to - 0.01; a += segS) {
      const end = Math.min(sp.to, a + segS + (a + segS < sp.to ? overlapS : 0));
      const lat = r() * latencyMs / 1000;                       // encoder starts a little after onstart
      const from = a + lat;
      const pcm = gt.pcm.subarray(Math.round(from * SR), Math.round(end * SR));
      const stamp = a + (r() - 0.5) * 2 * jitterMs / 1000;      // Date.now() in onstart is not exact
      pieces.push({ seq: seq++, trueFrom: from, trueTo: end, stampS: stamp, buf: encodeWebm(pcm), durMs: Math.round((end - a) * 1000) });
    }
  }
  return pieces;
}

const T0 = Date.parse('2026-09-30T23:00:00Z');
async function join(pieces, extra = {}) {
  const out = path.join(os.tmpdir(), `asm-test-${process.pid}-${Math.random().toString(36).slice(2)}.webm`);
  const segments = pieces.map((p) => ({ seq: p.seq, client_started_at: new Date(T0 + p.stampS * 1000).toISOString(), duration_ms: p.durMs, mime: 'audio/webm;codecs=opus', session_scope: p.scope || 'open', _buf: p.buf }));
  const meta = await assembleSession({
    session: { client_started_at: new Date(T0).toISOString(), client_stopped_at: new Date(T0 + (pieces[pieces.length - 1].trueTo) * 1000).toISOString() },
    segments, loadPiece: async (s) => s._buf, verification: extra.verification || { gaps: [] }, execIntervals: extra.execIntervals || [], outPath: out,
  });
  const pcm = await decodeToPcm(fs.readFileSync(out), 'webm');
  fs.unlinkSync(out);
  return { meta, pcm };
}

// Where each ground-truth beep must land in the joined audio (holes removed).
function expectedBeeps(gt, pieces) {
  // Kept real-time ranges: union of piece ranges.
  const ranges = [];
  for (const p of [...pieces].sort((a, b) => a.trueFrom - b.trueFrom)) {
    const last = ranges[ranges.length - 1];
    if (last && p.trueFrom <= last.to + 0.05) last.to = Math.max(last.to, p.trueTo);
    else ranges.push({ from: p.trueFrom, to: p.trueTo });
  }
  const out = []; let audioAt = 0;
  for (const r of ranges) {
    for (const b of gt.beeps) if (b.t >= r.from + 0.01 && b.t + BEEP_LEN <= r.to - 0.01) out.push({ t: audioAt + (b.t - r.from), f: b.f, k: b.k });
    audioAt += r.to - r.from;
  }
  return { beeps: out, audioS: audioAt, ranges };
}

function compare(found, expected, tolS = 0.015) {
  const problems = [];
  if (found.length !== expected.length) problems.push(`beep count ${found.length} != expected ${expected.length}`);
  const n = Math.min(found.length, expected.length);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(found[i].t - expected[i].t);
    worst = Math.max(worst, d);
    if (d > tolS || found[i].f !== expected[i].f) { problems.push(`beep #${i} (source beep ${expected[i].k}) at ${found[i].t.toFixed(3)}s/${found[i].f}Hz, expected ${expected[i].t.toFixed(3)}s/${expected[i].f}Hz`); if (problems.length > 4) break; }
  }
  return { problems, worstMs: Math.round(worst * 1000) };
}

module.exports = { groundTruth, findBeeps, compare, encodeWebm, recordPieces, expectedBeeps, FREQS, BEEP_EVERY, BEEP_LEN };
if (require.main === module) (async () => {
  console.log('assemble.js (known tones)');
  if (!fs.existsSync(ffmpegPath())) { console.log('  SKIP ffmpeg binary missing (run npm install)'); process.exit(1); }

  const gt = groundTruth(100);
  await t('control: the beep finder recovers every beep from the untouched ground truth', async () => {
    const found = findBeeps(gt.pcm);
    const c = compare(found, gt.beeps.map((b) => ({ t: b.t, f: b.f, k: b.k })), 0.006);
    assert.deepStrictEqual(c.problems, [], JSON.stringify(c.problems));
  });

  await t('control: joining pieces WITHOUT removing the overlap is caught (the test can fail)', async () => {
    const pieces = recordPieces(gt, [{ from: 0.1, to: 70 }]);
    const parts = [];
    for (const p of pieces) parts.push(await decodeToPcm(p.buf, 'webm'));
    const naive = new Int16Array(parts.reduce((t, x) => t + x.length, 0));
    let at = 0; for (const x of parts) { naive.set(x, at); at += x.length; }
    const found = findBeeps(naive);
    const c = compare(found, expectedBeeps(gt, pieces).beeps);
    assert.ok(c.problems.length > 0, 'naive concatenation should repeat audio at every boundary');
  });

  await t('3 continuous pieces (0-70 s): every beep once, in order, within 15 ms; overlaps measured from the audio', async () => {
    const pieces = recordPieces(gt, [{ from: 0.1, to: 70 }]);
    const { meta, pcm } = await join(pieces);
    const exp = expectedBeeps(gt, pieces);
    const c = compare(findBeeps(pcm), exp.beeps);
    assert.deepStrictEqual(c.problems, [], JSON.stringify(c.problems) + JSON.stringify(meta.boundaries));
    assert.strictEqual(meta.boundaries.length, 2);
    for (const b of meta.boundaries) assert.ok(['waveform', 'envelope'].includes(b.method), 'boundary matched from audio: ' + JSON.stringify(b));
    assert.ok(Math.abs(meta.duration_ms - exp.audioS * 1000) < 40, `duration ${meta.duration_ms} vs ${Math.round(exp.audioS * 1000)}`);
    assert.strictEqual(meta.gaps.length, 0);
    console.log(`       worst beep error ${c.worstMs} ms; boundaries ${meta.boundaries.map((b) => `${b.method}:${b.measured_overlap_ms}ms(exp ${b.expected_overlap_ms})`).join(', ')}`);
  });

  await t('user pause 62-70 s: the hole is NOT filled with audio, is listed as a gap, and timing after it is exact', async () => {
    const pieces = recordPieces(gt, [{ from: 0.1, to: 62 }, { from: 70.1, to: 100 }], { seed: 11 });
    const verification = { gaps: [{ from_ms: 62000, to_ms: 70000, ms: 8000, reason: 'pause' }] };
    const { meta, pcm } = await join(pieces, { verification });
    const exp = expectedBeeps(gt, pieces);
    const c = compare(findBeeps(pcm), exp.beeps);
    assert.deepStrictEqual(c.problems, [], JSON.stringify(c.problems));
    assert.strictEqual(meta.gaps.length, 1);
    assert.strictEqual(meta.gaps[0].reason, 'pause');
    assert.ok(Math.abs(meta.gaps[0].ms - 8000) < 200, 'gap length ' + meta.gaps[0].ms);
    assert.ok(Math.abs(meta.duration_ms - exp.audioS * 1000) < 60, `joined audio ${meta.duration_ms} ms is the recorded audio only (${Math.round(exp.audioS * 1000)} ms)`);
    // meeting time of the piece after the pause re-anchors near 70 s
    const after = meta.timeline.find((x) => x.seq === meta.gaps[0].before_seq);
    assert.ok(Math.abs(after.meeting_from_ms - 70100) < 120, 'meeting time after the pause ' + after.meeting_from_ms);
    console.log(`       worst beep error ${c.worstMs} ms; gap ${meta.gaps[0].ms} ms at audio ${meta.gaps[0].at_audio_ms} ms`);
  });

  await t('silent overlap (room quiet at the boundary): falls back to timestamps, still no repeated/lost beeps', async () => {
    const quiet = groundTruth(70, { silentFrom: 28.5, silentTo: 31.5 });
    const pieces = recordPieces(quiet, [{ from: 0.1, to: 70 }], { seed: 5 });
    const { meta, pcm } = await join(pieces);
    const c = compare(findBeeps(pcm), expectedBeeps(quiet, pieces).beeps, 0.08);   // timestamp accuracy (jitter up to 60 ms)
    assert.deepStrictEqual(c.problems, [], JSON.stringify(c.problems));
    assert.strictEqual(meta.boundaries[0].method, 'timestamp_silent');
    console.log(`       worst beep error ${c.worstMs} ms (timestamp-only boundary)`);
  });

  await t('executive-session interval maps to audio time; a device-flagged piece with no interval is kept executive', async () => {
    const pieces = recordPieces(gt, [{ from: 0.1, to: 100 }], { seed: 9 });
    pieces[3].scope = 'executive';                      // piece at 90-100 s flagged, no markers cover it
    const execIntervals = [{ started_at: new Date(T0 + 40000).toISOString(), ended_at: new Date(T0 + 55000).toISOString() }];
    const { meta } = await join(pieces, { execIntervals });
    assert.strictEqual(meta.exec_ranges.length, 2);
    const m = meta.exec_ranges[0];
    assert.ok(Math.abs(m.audio_from_ms - 40000) < 120 && Math.abs(m.audio_to_ms - 55000) < 120, JSON.stringify(m));
    assert.strictEqual(meta.exec_ranges[1].source, 'segment_flag');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
