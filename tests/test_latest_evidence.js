// ============================================================================
// tests/test_latest_evidence.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// A violation notice must show the property as it looks NOW. A 2nd notice for
// 527 Shady Brook rendered the Aug 3 photo though the property was re-driven
// Sept 1 — because every letter path pulled the OPENING observation's photo.
// This locks the fix: latestEvidence() prefers the most recent continuation's
// inspection photo + date, and only falls back to the opening observation when
// there has been no re-inspection. Ed thought this was fixed once; a test makes
// it impossible to regress silently (CLAUDE.md: scars become checks).
// ============================================================================
const assert = require('assert');
const { latestEvidence } = require('../lib/enforcement/latest_evidence');

let passed = 0, failed = 0;
function check(name, fn) {
  Promise.resolve().then(fn).then(() => { console.log('  PASS ', name); passed++; })
    .catch((e) => { console.log('  FAIL ', name, '\n        ' + e.message); failed++; });
}

// Minimal fake supabase covering the two tables latestEvidence reads.
function fakeSupabase({ continuation, photo }) {
  return {
    from(table) {
      const q = {
        _table: table, _filters: {},
        select() { return q; },
        eq(col, val) { q._filters[col] = val; return q; },
        order() { return q; },
        limit() {
          if (table === 'violation_continuations') return Promise.resolve({ data: continuation ? [continuation] : [] });
          return q;
        },
        maybeSingle() {
          if (table === 'inspection_photos') return Promise.resolve({ data: photo || null });
          return Promise.resolve({ data: null });
        },
      };
      return q;
    },
  };
}

const openingObs = {
  created_at: '2026-08-03T19:42:33Z',
  inspection_photo_id: 'opening-photo-id',
  inspection_photos: { captured_at: '2026-08-03T19:42:33Z', storage_path: 'inspections/aug3/photo.jpg', paired_wide_photo_id: 'wide-aug3' },
};

check('prefers the latest continuation photo over the opening observation', async () => {
  const s = fakeSupabase({
    continuation: { inspection_photo_id: 'sept1-photo-id', noted_at: '2026-09-01T20:09:00Z' },
    photo: { storage_path: 'inspections/sept1/photo.jpg', captured_at: '2026-09-01T16:06:34Z', paired_wide_photo_id: 'wide-sept1' },
  });
  const ev = await latestEvidence(s, 'viol-1', openingObs);
  assert.strictEqual(ev.source, 'continuation', 'should use the continuation');
  assert.strictEqual(ev.storage_path, 'inspections/sept1/photo.jpg', 'should be the Sept 1 photo, not Aug 3');
  assert.strictEqual(ev.captured_at, '2026-09-01T16:06:34Z', 'date must be Sept 1');
  assert.strictEqual(ev.inspection_photo_id, 'sept1-photo-id');
});

check('falls back to the opening observation when there has been no re-inspection', async () => {
  const s = fakeSupabase({ continuation: null, photo: null });
  const ev = await latestEvidence(s, 'viol-1', openingObs);
  assert.strictEqual(ev.source, 'opening');
  assert.strictEqual(ev.storage_path, 'inspections/aug3/photo.jpg');
  assert.strictEqual(ev.captured_at, '2026-08-03T19:42:33Z');
});

check('falls back to opening when the continuation has no usable photo row', async () => {
  const s = fakeSupabase({ continuation: { inspection_photo_id: 'missing', noted_at: '2026-09-01T20:09:00Z' }, photo: null });
  const ev = await latestEvidence(s, 'viol-1', openingObs);
  assert.strictEqual(ev.source, 'opening', 'a dangling continuation photo must not blank the letter');
  assert.strictEqual(ev.storage_path, 'inspections/aug3/photo.jpg');
});

process.on('exit', () => {
  console.log(`\nlatest_evidence: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
