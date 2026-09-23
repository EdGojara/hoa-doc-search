// tests/test_meeting_transcript.js  (Ed 2026-09-23)
// Offline unit tests for transcript normalization (lib/meetings/transcribe.js)
// and speaker labels (lib/meetings/roster.js). A Deepgram-shaped response is
// normalized against an assembly with a recording gap and an executive
// session: utterances must split at both, carry audio + meeting time, speaker
// number, confidence and scope. No network.
const assert = require('assert');
const { normalizeTranscript, audioToMeeting, deepgramTranscribe } = require('../lib/meetings/transcribe');
const { speakerLabel } = require('../lib/meetings/roster');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

// words helper: [text, start_s, end_s, speaker, conf]
const W = (list) => list.map(([w, s, e, sp, c = 0.95]) => ({ word: w.toLowerCase().replace(/[^a-z0-9]/g, ''), punctuated_word: w, start: s, end: e, speaker: sp, confidence: c }));
const utt = (words) => ({ start: words[0].start, end: words[words.length - 1].end, speaker: words[0].speaker, transcript: words.map((w) => w.punctuated_word).join(' '), confidence: 0.9, words });

// Joined audio: piece A 0-60 s = meeting 0-60 s; 8 s pause; piece B audio 60-120 s = meeting 68-128 s.
// Executive session: audio 90-100 s.
const assembly = {
  timeline: [{ seq: 0, audio_from_ms: 0, audio_to_ms: 60000, meeting_from_ms: 0 }, { seq: 2, audio_from_ms: 60000, audio_to_ms: 120000, meeting_from_ms: 68000 }],
  gaps: [{ at_audio_ms: 60000, meeting_from_ms: 60000, meeting_to_ms: 68000, ms: 8000, reason: 'pause' }],
  exec_ranges: [{ audio_from_ms: 90000, audio_to_ms: 100000, meeting_from_ms: 98000, meeting_to_ms: 108000 }],
};
const raw = { metadata: { duration: 120, request_id: 'r1' }, results: { utterances: [
  utt(W([['Good', 1.0, 1.2, 0], ['evening.', 1.2, 1.6, 0]])),
  // straddles the pause join at 60 s: must become two segments
  utt(W([['The', 58.0, 58.2, 1], ['treasurer', 58.2, 58.8, 1], ['reports', 59.0, 59.5, 1], ['forty', 60.5, 60.9, 1], ['thousand.', 60.9, 61.4, 1]])),
  // straddles the executive-session start at 90 s
  utt(W([['Moving', 88.5, 88.9, 0], ['into', 89.0, 89.3, 0], ['executive', 89.4, 89.9, 0], ['The', 90.2, 90.4, 0], ['owner', 90.5, 90.9, 0], ['owes', 91.0, 91.3, 0, 0.5]])),
  utt(W([['Back', 101.0, 101.3, 2], ['in', 101.3, 101.5, 2], ['open', 101.5, 101.8, 2], ['session.', 101.8, 102.3, 2]])),
] } };

(async () => {
  console.log('transcribe.js normalization');
  const n = normalizeTranscript(raw, assembly);
  const S = n.segments;
  await t('utterance across the recording gap is split into two segments', () => {
    const parts = S.filter((s) => s.speaker === 1);
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[0].text, 'The treasurer reports');
    assert.strictEqual(parts[1].text, 'forty thousand.');
  });
  await t('the first segment after the gap is marked after_gap', () => {
    assert.strictEqual(S.find((s) => s.text === 'forty thousand.').after_gap, true);
    assert.strictEqual(S.filter((s) => s.after_gap).length, 1);
  });
  await t('meeting time skips the 8 s pause (audio 60.5 s -> meeting 68.5 s)', () => {
    const s = S.find((x) => x.text === 'forty thousand.');
    assert.strictEqual(s.start_ms, 60500);
    assert.strictEqual(s.meeting_start_ms, 68500);
    assert.strictEqual(audioToMeeting(assembly.timeline, 30000), 30000);
  });
  await t('utterance across the executive-session start splits; the inside part is scope executive', () => {
    const before = S.find((x) => x.text === 'Moving into executive'), inside = S.find((x) => x.text === 'The owner owes');
    assert.ok(before && inside, JSON.stringify(S.map((x) => x.text)));
    assert.strictEqual(before.scope, 'open');
    assert.strictEqual(inside.scope, 'executive');
    assert.strictEqual(S.find((x) => x.text === 'Back in open session.').scope, 'open');
  });
  await t('confidence is the mean word confidence; speaker numbers kept; idx sequential', () => {
    const inside = S.find((x) => x.text === 'The owner owes');
    assert.strictEqual(inside.confidence, +((0.95 + 0.95 + 0.5) / 3).toFixed(4));
    assert.deepStrictEqual(S.map((x) => x.idx), S.map((_, i) => i));
    assert.strictEqual(n.stats.speaker_count, 3);
    assert.strictEqual(n.stats.word_count, 17);
  });
  await t('speaker labels: unmapped "Speaker N" (1-based); board member from roster; role labels', () => {
    const roster = [{ id: 'b1', name: 'Sunny Meadows', position: 'President' }];
    const maps = [{ speaker: 0, role: 'board_member', board_member_id: 'b1' }, { speaker: 1, role: 'manager', display_name: 'Jordan Ellis' }, { speaker: 2, role: 'homeowner' }];
    assert.strictEqual(speakerLabel(0, maps, roster), 'Sunny Meadows (President)');
    assert.strictEqual(speakerLabel(1, maps, roster), 'Jordan Ellis (Manager)');
    assert.strictEqual(speakerLabel(2, maps, roster), 'Homeowner');
    assert.strictEqual(speakerLabel(3, maps, roster), 'Speaker 4');
  });
  await t('Deepgram request: prerecorded /v1/listen with diarize, utterances, punctuate, smart_format; bad key is permanent', async () => {
    let seen;
    const ok = await deepgramTranscribe(Buffer.from('x'), { apiKey: 'k', model: 'nova-3', fetchImpl: async (url, o) => { seen = { url, o }; return { ok: true, status: 200, text: async () => JSON.stringify(raw), headers: { get: () => null } }; } });
    const u = new URL(seen.url);
    assert.strictEqual(u.origin + u.pathname, 'https://api.deepgram.com/v1/listen');
    for (const [k, v] of Object.entries({ model: 'nova-3', diarize: 'true', utterances: 'true', punctuate: 'true', smart_format: 'true' })) assert.strictEqual(u.searchParams.get(k), v, k);
    assert.strictEqual(seen.o.headers.Authorization, 'Token k');
    assert.strictEqual(ok.requestId, 'r1');
    await assert.rejects(deepgramTranscribe(Buffer.from('x'), { apiKey: 'bad', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid credentials', headers: { get: () => null } }) }), (e) => e.permanent === true);
    await assert.rejects(deepgramTranscribe(Buffer.from('x'), { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'busy', headers: { get: () => null } }) }), (e) => !e.permanent);
    await assert.rejects(deepgramTranscribe(Buffer.from('x'), { apiKey: '' }), (e) => e.permanent === true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
