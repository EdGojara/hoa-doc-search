// tests/test_voices_routes.js — api/voices.js route order (Ed 2026-11-26).
// POST /api/voices/tts-sample must reach its own handler, not the
// '/:persona' voice-picker route registered in the same router.
'use strict';
const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const { router } = require('../api/voices');

function firstPostMatch(path) {
  return router.stack.find((l) => l.route && l.route.methods.post && l.match(path));
}
let failed = 0;
const check = (name, fn) => { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };

check('POST /tts-sample reaches the sample route, not /:persona', () => {
  assert.strictEqual(firstPostMatch('/tts-sample').route.path, '/tts-sample');
});
check('POST /kat still reaches the voice picker; POST /tts/kat the spoken-voice picker', () => {
  assert.strictEqual(firstPostMatch('/kat').route.path, '/:persona');
  assert.strictEqual(firstPostMatch('/tts/kat').route.path, '/tts/:persona');
});
if (failed) { console.log(`\n${failed} voices route check(s) FAILED`); process.exit(1); }
console.log('\nall voices route checks passed');
