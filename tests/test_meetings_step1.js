// tests/test_meetings_step1.js  (Ed 2026-09-23)
// Offline unit tests for Meeting Recorder Step 1: completeness/gap verification
// (lib/meetings/verify.js) and the per-session upload key
// (lib/meetings/upload_token.js). No network, no database.
const assert = require('assert');
const { verifySession } = require('../lib/meetings/verify');
const { issueUploadToken, parseUploadToken, checkUploadToken } = require('../lib/meetings/upload_token');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

const T0 = Date.parse('2026-09-30T23:00:00Z');
// n back-to-back 30 s segments with the recorder's ~0.45 s overlap
function segs(n, { skip = [], startSeq = 0, offsetMs = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const seq = startSeq + i;
    if (skip.includes(seq)) continue;
    out.push({ seq, client_started_at: new Date(T0 + offsetMs + i * 29550).toISOString(), duration_ms: 30000, bytes: 115000, sha256: 'a'.repeat(64), is_partial: false, audible: true });
  }
  return out;
}
const sess = (o = {}) => ({ client_started_at: new Date(T0).toISOString(), client_stopped_at: null, expected_segment_count: null, highest_seq_seen: null, pauses: [], ...o });
const stopAt = (ms) => new Date(T0 + ms).toISOString();

console.log('verify.js');
t('complete 5-minute session -> verified, 100% coverage, no gaps', () => {
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(10 * 29550 + 450), expected_segment_count: 10 }), segments: segs(10) });
  assert.strictEqual(r.status, 'verified'); assert.strictEqual(r.missing_seqs.length, 0); assert.strictEqual(r.gaps.length, 0);
  assert.ok(r.coverage_pct >= 99, 'coverage ' + r.coverage_pct);
});
t('not yet stopped -> in_progress (never "verified" early)', () => {
  const r = verifySession({ session: sess({ highest_seq_seen: 4 }), segments: segs(5) });
  assert.strictEqual(r.status, 'in_progress');
});
t('missing middle piece -> incomplete, exact seq and time range', () => {
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(10 * 29550 + 450), expected_segment_count: 10 }), segments: segs(10, { skip: [4] }) });
  assert.strictEqual(r.status, 'incomplete');
  assert.deepStrictEqual(r.missing_seqs, [4]);
  assert.strictEqual(r.missing_ranges[0].from_ms, 3 * 29550 + 30000);   // end of #3
  assert.strictEqual(r.missing_ranges[0].to_ms, 5 * 29550);             // start of #5
  assert.ok(r.gaps.some((g) => g.reason === 'missing_segment'), JSON.stringify(r.gaps));
});
t('missing LAST piece is caught via expected_segment_count', () => {
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(10 * 29550 + 450), expected_segment_count: 10 }), segments: segs(9) });
  assert.strictEqual(r.status, 'incomplete'); assert.deepStrictEqual(r.missing_seqs, [9]);
});
t('device died before Stop: heartbeat highest_seq sets the expected count', () => {
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(8 * 29550), highest_seq_seen: 7 }), segments: segs(6) });
  assert.strictEqual(r.expected_count, 8); assert.deepStrictEqual(r.missing_seqs, [6, 7]);
});
t('deliberate pause -> gap reason "pause", still verified', () => {
  // 3 pieces, 60 s pause, 3 more pieces (seq continues)
  const a = segs(3), b = segs(3, { startSeq: 3, offsetMs: 3 * 29550 + 60000 });
  const pauseFrom = T0 + 2 * 29550 + 30000, pauseTo = pauseFrom + 60000 - 450;
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(3 * 29550 + 60000 + 3 * 29550 + 450), expected_segment_count: 6, pauses: [{ from: pauseFrom, to: pauseTo }] }), segments: [...a, ...b] });
  assert.strictEqual(r.status, 'verified', JSON.stringify(r.gaps));
  assert.strictEqual(r.gaps.length, 1); assert.strictEqual(r.gaps[0].reason, 'pause');
  assert.ok(Math.abs(r.paused_ms - 59550) < 5);
});
t('reload interruption (markers) -> gap reason "interruption", reported, still verified', () => {
  const a = segs(3), b = segs(2, { startSeq: 3, offsetMs: 3 * 29550 + 8000 });
  const from = T0 + 2 * 29550 + 30000;
  const markers = [{ kind: 'interrupted', occurred_at: new Date(from).toISOString() }, { kind: 'resumed_after_interruption', occurred_at: new Date(from + 8000 - 450).toISOString() }];
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(3 * 29550 + 8000 + 2 * 29550 + 450), expected_segment_count: 5 }), segments: [...a, ...b], markers });
  assert.strictEqual(r.status, 'verified'); assert.strictEqual(r.gaps[0].reason, 'interruption'); assert.ok(r.interrupted_ms > 7000);
});
t('hole with no explanation -> "unexplained" -> incomplete', () => {
  const a = segs(3), b = segs(3, { startSeq: 3, offsetMs: 3 * 29550 + 20000 });
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(3 * 29550 + 20000 + 3 * 29550 + 450), expected_segment_count: 6 }), segments: [...a, ...b] });
  assert.strictEqual(r.status, 'incomplete'); assert.strictEqual(r.gaps[0].reason, 'unexplained'); assert.ok(r.unexplained_gap_ms > 19000);
});
t('rotation overlap is not a gap; sub-second jitter ignored', () => {
  const s = segs(4); s[2].client_started_at = new Date(Date.parse(s[2].client_started_at) + 600).toISOString(); // 150 ms hole
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(4 * 29550 + 1000), expected_segment_count: 4 }), segments: s });
  assert.strictEqual(r.gaps.length, 0); assert.strictEqual(r.status, 'verified');
});
t('silent and partial pieces are listed (informational)', () => {
  const s = segs(3); s[1].audible = false; s[2].is_partial = true;
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(3 * 29550 + 450), expected_segment_count: 3 }), segments: s });
  assert.deepStrictEqual(r.silent_segments, [1]); assert.deepStrictEqual(r.partial_segments, [2]);
});
t('4-hour session (487 pieces), 3 missing -> exact list', () => {
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(487 * 29550 + 450), expected_segment_count: 487 }), segments: segs(487, { skip: [10, 250, 486] }) });
  assert.deepStrictEqual(r.missing_seqs, [10, 250, 486]); assert.strictEqual(r.received_count, 484); assert.strictEqual(r.status, 'incomplete');
});
t('duplicate rows for the same seq are counted once', () => {
  const s = segs(3); s.push({ ...s[1] });
  const r = verifySession({ session: sess({ client_stopped_at: stopAt(3 * 29550 + 450), expected_segment_count: 3 }), segments: s });
  assert.strictEqual(r.received_count, 3); assert.strictEqual(r.status, 'verified');
});

console.log('upload_token.js');
const SID = '11111111-2222-4333-8444-555555555555';
t('issued key verifies for its session', () => {
  const k = issueUploadToken(SID);
  assert.strictEqual(checkUploadToken(k.token, { id: SID, upload_token_hash: k.hash, upload_token_expires_at: k.expires_at }, SID), 'ok');
});
t('key is ~12 h and only its hash is stored', () => {
  const now = Date.now(); const k = issueUploadToken(SID, now);
  assert.ok(Math.abs(Date.parse(k.expires_at) - now - 12 * 3600e3) < 1000); assert.ok(!k.token.includes(k.hash));
});
t('expired key -> expired', () => {
  const k = issueUploadToken(SID, Date.now() - 13 * 3600e3);
  assert.strictEqual(checkUploadToken(k.token, { id: SID, upload_token_hash: k.hash, upload_token_expires_at: k.expires_at }, SID), 'expired');
});
t('tampered secret -> invalid', () => {
  const k = issueUploadToken(SID);
  assert.strictEqual(checkUploadToken(k.token.slice(0, -2) + 'xx', { id: SID, upload_token_hash: k.hash, upload_token_expires_at: k.expires_at }, SID), 'invalid');
});
t("another session's key -> wrong_session", () => {
  const other = '99999999-2222-4333-8444-555555555555'; const k = issueUploadToken(other);
  assert.strictEqual(checkUploadToken(k.token, { id: SID, upload_token_hash: k.hash, upload_token_expires_at: k.expires_at }, SID), 'wrong_session');
});
t('renewal invalidates the old key', () => {
  const k1 = issueUploadToken(SID), k2 = issueUploadToken(SID);
  assert.strictEqual(checkUploadToken(k1.token, { id: SID, upload_token_hash: k2.hash, upload_token_expires_at: k2.expires_at }, SID), 'invalid');
});
t('garbage / missing key -> invalid', () => {
  assert.strictEqual(parseUploadToken('nope'), null);
  assert.strictEqual(checkUploadToken('', { id: SID, upload_token_hash: 'x', upload_token_expires_at: new Date().toISOString() }, SID), 'invalid');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
