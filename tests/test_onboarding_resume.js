// tests/test_onboarding_resume.js — activity-driven resume of open conversions (Ed 2026-11-01).
// lib/onboarding/resume.js runs the existing operator after an authorized action, with no timer:
// only open batches (never execute / post_proof / complete), one run per batch at a time (a request
// during a run queues exactly one more), failures logged and swallowed, the caller never awaited.
// Also checks the call sites are wired after the actions succeed, and that nothing polls.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/onboarding/resume');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const quiet = { log() {}, warn() {} };
function fakeService(batches, { delay = 0, fail = new Set() } = {}) {
  const s = { calls: [], listed: [] };
  s.listBatches = async (c) => { s.listed.push(c); return batches; };
  s.operate = async (id) => { s.calls.push(id); if (delay) await new Promise((r) => setTimeout(r, delay)); if (fail.has(id)) throw new Error('boom'); return { stopped_at: 'activity_bridge', reason: 'needs_human' }; };
  return s;
}
const B = (id, stage, c = 'c1') => ({ id, stage, community_id: c });

check('resumes only open batches: never execute, post_proof or complete', async () => {
  const s = fakeService([B('a', 'activity_bridge'), B('b', 'preflight'), B('c', 'execute'), B('d', 'post_proof'), B('e', 'complete'), B('f', 'snapshot')]);
  const ids = await R.resumeOpenConversions({ service: s, log: quiet, reason: 't' });
  assert.deepStrictEqual(ids.sort(), ['a', 'b', 'f']);
  assert.deepStrictEqual(s.calls.sort(), ['a', 'b', 'f']);
});

check('a community filter resumes only that community', async () => {
  const s = fakeService([B('a', 'activity_bridge', 'c1'), B('b', 'preflight', 'c2')]);
  const ids = await R.resumeOpenConversions({ communityId: 'c2', service: s, log: quiet });
  assert.deepStrictEqual(ids, ['b']); assert.deepStrictEqual(s.calls, ['b']);
});

check('single flight per batch: overlapping events run once, then exactly one queued rerun', async () => {
  const s = fakeService([], { delay: 20 });
  const p1 = R.operateOnce(s, 'x', 'first', quiet);
  const p2 = R.operateOnce(s, 'x', 'second', quiet);
  const p3 = R.operateOnce(s, 'x', 'third', quiet);
  assert.strictEqual(p1, p2); assert.strictEqual(p2, p3);
  await p1;
  assert.deepStrictEqual(s.calls, ['x', 'x'], 'one run plus one coalesced rerun, never three');
  await R.operateOnce(s, 'x', 'later', quiet);
  assert.strictEqual(s.calls.length, 3, 'a later event runs again');
});

check('a failing run is logged and swallowed; other batches still resume', async () => {
  const warned = []; const log = { log() {}, warn: (m, d) => warned.push(d) };
  const s = fakeService([B('a', 'activity_bridge'), B('b', 'preflight')], { fail: new Set(['a']) });
  const ids = await R.resumeOpenConversions({ service: s, log });
  assert.deepStrictEqual(ids.sort(), ['a', 'b']); assert.strictEqual(warned.length, 1); assert.ok(/boom/.test(warned[0]));
});

check('resumeAfter never throws and returns at once (the caller is not delayed)', async () => {
  let listed = false;
  const s = { listBatches: async () => { listed = true; throw new Error('db down'); }, operate: async () => {} };
  assert.strictEqual(R.resumeAfter({ service: s, log: quiet }), undefined);
  assert.strictEqual(listed, false, 'nothing runs before the caller returns');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(listed, true);
});

check('wiring: each authorized action resumes after it succeeds; execute chains the post-proof after commit', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const legal = read('api/legal_review.js'); assert.ok(/if \(out\.ok\) require\('\.\.\/lib\/onboarding\/resume'\)\.resumeAfter/.test(legal));
  const own = read('api/ownership_proposals.js'); assert.ok(/res\.json\(\{ \.\.\.data, proration \}\);\s*require\('\.\.\/lib\/onboarding\/resume'\)\.resumeAfter/.test(own));
  const ap = read('api/ap.js'); assert.ok(/if \(jeId\) require\('\.\.\/lib\/onboarding\/resume'\)\.resumeAfter/.test(ap));
  const srv = read('server.js'); assert.ok(/if \(r\.status === 'applied'\) require\('\.\/lib\/onboarding\/resume'\)\.resumeAfter/.test(srv));
  const ob = read('api/onboarding.js');
  assert.ok(/res\.json\(\{ execution \}\);[\s\S]{0,600}\['executed', 'already_executed'\]\.includes\(execution\.status\)/.test(ob), 'post-proof only after a committed execution, after the response');
  assert.ok(/to: 'post_proof'/.test(ob) && !/to: 'complete'/.test(ob), 'advances only to post_proof; complete stays the owner\'s');
});

check('no polling: the resume module has no timer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/onboarding/resume.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/setInterval|setTimeout|cron|schedule/.test(src));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
