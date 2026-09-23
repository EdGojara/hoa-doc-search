// ============================================================================
// lib/meetings/verify.js  (Ed 2026-09-23)
// ----------------------------------------------------------------------------
// Deterministic completeness / gap verification for a meeting recording
// session. Pure function: no I/O, no AI. Answers "did every recorded piece
// reach Trusted intact, and where is the audio timeline missing sound?"
//
// Inputs (plain rows):
//   session  { client_started_at, client_stopped_at, expected_segment_count,
//              highest_seq_seen, pauses:[{from,to}] }   (times: ISO or ms)
//   segments [{ seq, client_started_at, duration_ms, bytes, sha256,
//              is_partial, audible }]
//   markers  [{ kind, occurred_at }]
//
// Timeline gaps are holes in the union of segment intervals, classified as
//   pause          - deliberate user pause (session.pauses / pause markers)
//   interruption   - device/browser interruption or reload (markers)
//   missing_segment- a recorded piece that has not reached the server
//   unexplained    - none of the above (a real problem)
// status: 'in_progress' until the session is stopped; then 'verified' when
// every expected piece is present and no gap is unexplained, else 'incomplete'.
// Known interruptions are reported (audio was not captured) but are not upload
// failures, so they do not make a session 'incomplete'.
// ============================================================================

const GAP_MIN_MS = 1000;          // holes shorter than this are rotation jitter, not gaps
const EXPLAINED_OVERLAP = 0.8;    // a gap is "explained" if >=80% is covered by a pause/interruption

const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

function mergeIntervals(list) {
  const s = list.filter((i) => i && i.to > i.from).sort((a, b) => a.from - b.from);
  const out = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else out.push({ from: i.from, to: i.to });
  }
  return out;
}
const overlapMs = (a, list) => list.reduce((t, b) => t + Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from)), 0);

function verifySession({ session, segments = [], markers = [] }) {
  const t0 = toMs(session.client_started_at);
  const stopped = toMs(session.client_stopped_at);
  const byMs = (x) => (x == null ? null : x - t0);

  // ---- expected pieces
  const seqs = [...new Set(segments.map((s) => s.seq))].sort((a, b) => a - b);
  const maxSeq = seqs.length ? seqs[seqs.length - 1] : -1;
  const expected = Math.max(
    Number.isInteger(session.expected_segment_count) ? session.expected_segment_count : 0,
    Number.isInteger(session.highest_seq_seen) ? session.highest_seq_seen + 1 : 0,
    maxSeq + 1,
  );
  const have = new Set(seqs);
  const missingSeqs = [];
  for (let i = 0; i < expected; i++) if (!have.has(i)) missingSeqs.push(i);

  // ---- intervals (ms from session start)
  const segIv = segments
    .filter((s) => toMs(s.client_started_at) != null && s.duration_ms != null)
    .map((s) => ({ seq: s.seq, from: toMs(s.client_started_at) - t0, to: toMs(s.client_started_at) - t0 + s.duration_ms }));
  const covered = mergeIntervals(segIv);

  const pauseIv = mergeIntervals([
    ...(Array.isArray(session.pauses) ? session.pauses : []).map((p) => ({ from: toMs(p.from) - t0, to: toMs(p.to) - t0 })),
    ...pairs(markers, 'pause', 'resume').map((p) => ({ from: p.from - t0, to: p.to - t0 })),
  ]);
  const interruptIv = mergeIntervals(pairs(markers, 'interrupted', 'resumed_after_interruption').map((p) => ({ from: p.from - t0, to: p.to - t0 })));

  // Missing pieces: estimate each one's position from its present neighbours.
  const bySeq = new Map(segIv.map((i) => [i.seq, i]));
  const missingRanges = missingSeqs.map((q) => {
    let prev = null, next = null;
    for (let k = q - 1; k >= 0; k--) if (bySeq.has(k)) { prev = bySeq.get(k); break; }
    for (let k = q + 1; k < expected; k++) if (bySeq.has(k)) { next = bySeq.get(k); break; }
    return { seq: q, from_ms: prev ? prev.to : 0, to_ms: next ? next.from : (stopped != null ? stopped - t0 : prev ? prev.to : 0) };
  });

  // ---- holes in coverage between session start and stop (or last audio)
  const endMs = stopped != null ? stopped - t0 : (covered.length ? covered[covered.length - 1].to : 0);
  const holes = [];
  let cursor = 0;
  for (const c of covered) { if (c.from - cursor >= GAP_MIN_MS) holes.push({ from: cursor, to: c.from }); cursor = Math.max(cursor, c.to); }
  if (endMs - cursor >= GAP_MIN_MS) holes.push({ from: cursor, to: endMs });
  const missIv = missingRanges.map((r) => ({ from: r.from_ms, to: r.to_ms }));
  const gaps = holes.map((h) => {
    const len = h.to - h.from;
    const reason = overlapMs(h, missIv) >= EXPLAINED_OVERLAP * len ? 'missing_segment'
      : overlapMs(h, pauseIv) >= EXPLAINED_OVERLAP * len ? 'pause'
      : overlapMs(h, interruptIv) >= EXPLAINED_OVERLAP * len ? 'interruption'
      : overlapMs(h, pauseIv) + overlapMs(h, interruptIv) >= EXPLAINED_OVERLAP * len ? 'pause_or_interruption'
      : 'unexplained';
    return { from_ms: Math.round(h.from), to_ms: Math.round(h.to), ms: Math.round(len), reason };
  });

  const audioMs = covered.reduce((t, c) => t + (c.to - c.from), 0);
  const pausedMs = pauseIv.reduce((t, p) => t + (p.to - p.from), 0);
  const interruptedMs = gaps.filter((g) => g.reason === 'interruption').reduce((t, g) => t + g.ms, 0);
  const unexplained = gaps.filter((g) => g.reason === 'unexplained');
  const recordableMs = Math.max(0, endMs - pausedMs - interruptedMs);

  const checks = {
    stopped: stopped != null,
    all_segments_present: missingSeqs.length === 0,
    no_unexplained_gaps: unexplained.length === 0,
  };
  const status = !checks.stopped ? 'in_progress' : (checks.all_segments_present && checks.no_unexplained_gaps ? 'verified' : 'incomplete');

  return {
    status, checks,
    expected_count: expected, received_count: seqs.length,
    missing_seqs: missingSeqs, missing_ranges: missingRanges.map((r) => ({ ...r, from_ms: Math.round(r.from_ms), to_ms: Math.round(r.to_ms) })),
    gaps, unexplained_gap_ms: unexplained.reduce((t, g) => t + g.ms, 0),
    audio_ms: Math.round(audioMs), wall_ms: Math.round(endMs), paused_ms: Math.round(pausedMs), interrupted_ms: Math.round(interruptedMs),
    coverage_pct: recordableMs ? +Math.min(100, (100 * audioMs) / recordableMs).toFixed(1) : null,
    received_bytes: segments.reduce((t, s) => t + (s.bytes || 0), 0),
    partial_segments: segments.filter((s) => s.is_partial).map((s) => s.seq),
    silent_segments: segments.filter((s) => s.audible === false).map((s) => s.seq),
  };
}

// Pair start/end markers into intervals (an unclosed start runs to the next start or is dropped).
function pairs(markers, startKind, endKind) {
  const ev = markers.filter((m) => m.kind === startKind || m.kind === endKind).map((m) => ({ kind: m.kind, at: toMs(m.occurred_at) })).sort((a, b) => a.at - b.at);
  const out = []; let open = null;
  for (const e of ev) {
    if (e.kind === startKind) { if (open == null) open = e.at; }
    else if (open != null) { out.push({ from: open, to: e.at }); open = null; }
  }
  return out;
}

module.exports = { verifySession, mergeIntervals, GAP_MIN_MS };
