// tests/test_media_phase0.js  (Issue #10 Media Studio, Phase 0) — pure checks, no network, no spend
const assert = require('assert');
const { freezeShotSpec, validateShotSpec } = require('../lib/media/shotspec');
const { ADAPTERS, CATALOG, probeAll, hasCredentials } = require('../lib/media/providers');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const pin = (c) => c.repeat(64);
const base = () => ({ shot_key: 'p0_test', segment_class: 'brand', duration_seconds: 8, cast: [{ character_slug: 'amanda_albright', components: { face: { version: 3, spec_sha256: pin('a') } } }],
  camera: { lens_mm: 50, move: 'slow push-in' }, references: [{ sha256: pin('b'), use: 'identity' }] });

check('a ShotSpec freezes to the same sha256 regardless of key order', () => {
  const a = freezeShotSpec(base());
  const b = freezeShotSpec({ references: base().references, camera: { move: 'slow push-in', lens_mm: 50 }, cast: base().cast, duration_seconds: 8, segment_class: 'brand', shot_key: 'p0_test' });
  assert.strictEqual(a.shotspec_sha256, b.shotspec_sha256); assert.ok(/^[0-9a-f]{64}$/.test(a.shotspec_sha256));
  assert.notStrictEqual(freezeShotSpec({ ...base(), duration_seconds: 6 }).shotspec_sha256, a.shotspec_sha256, 'any change is a different spec');
});
check('provider IDs, model names and signed URLs are refused in a ShotSpec (providers map, never define)', () => {
  assert.ok(!validateShotSpec({ ...base(), heygen_avatar_id: 'x' }).ok);
  assert.ok(!validateShotSpec({ ...base(), camera: { model_id: 'veo-3.1' } }).ok);
  assert.ok(!validateShotSpec({ ...base(), references: [{ sha256: pin('b'), url: 'https://x/y.png?X-Amz-Signature=abc' }] }).ok);
  assert.throws(() => freezeShotSpec({ ...base(), seedance_preset: 'cine' }), /INVALID_SHOTSPEC|provider/);
});
check('cast must be pinned by approved spec_sha256; references must be content-addressed; segment class required', () => {
  assert.ok(!validateShotSpec({ ...base(), cast: [{ character_slug: 'amanda_albright', components: { face: { version: 3 } } }] }).ok);
  assert.ok(!validateShotSpec({ ...base(), references: [{ use: 'identity' }] }).ok);
  assert.ok(!validateShotSpec({ ...base(), segment_class: 'cinematic' }).ok);
});
check('quotes use the documented price per second and the provider minimum', () => {
  const spec = { ...base(), audio: { ambient: true } };
  assert.strictEqual(ADAPTERS.veo_3_1.quote(spec, { resolution: '1080p' }).per_attempt, 3.2);
  assert.strictEqual(ADAPTERS.omni_flash_1_1.quote(spec, { resolution: '360p' }).per_attempt, 0.24);
  assert.strictEqual(ADAPTERS.seedance_2_5.quote({ ...spec, duration_seconds: 1 }, { resolution: '1080p' }).per_attempt, 0.8, 'the $0.80 minimum applies');
  assert.strictEqual(ADAPTERS.veo_3_1.quote(spec, { resolution: '360p' }).usable, false);
  for (const a of CATALOG) assert.ok(a.sources.length && a.channels.every((c) => c.source && c.as_of), 'every adapter and channel cites its source and date');
});
check('credentials: any one group satisfies, unless the adapter needs all of them; names only', () => {
  assert.ok(hasCredentials(ADAPTERS.omni_flash_1_1, { GOOGLE_API_KEY: 'x' }));
  assert.ok(!hasCredentials(ADAPTERS.kling_3, { KLING_ACCESS_KEY: 'x' }), 'Kling needs both keys');
  assert.ok(hasCredentials(ADAPTERS.kling_3, { KLING_ACCESS_KEY: 'x', KLING_SECRET_KEY: 'y' }));
});
check('probe with no credentials makes NO network call and reports exactly what is needed', async () => {
  let calls = 0; const fetchStub = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  const r = await probeAll({}, fetchStub);
  assert.strictEqual(calls, 0);
  assert.ok(Object.values(r).every((x) => x.reachable === false && x.reason === 'no credential configured' && x.needs.length));
});
check('probe with a Gemini key only reads the model list (no generation endpoint) and never echoes the key', async () => {
  const seen = []; const fetchStub = async (u, o) => { seen.push({ u, o }); return { ok: true, json: async () => ({ models: [{ name: 'models/veo-3.1-generate-preview' }, { name: 'models/gemini-omni-1.1-flash' }] }) }; };
  const r = await probeAll({ GEMINI_API_KEY: 'SECRET123' }, fetchStub);
  assert.ok(seen.every((s) => /\/v1beta\/models\?/.test(s.u) && !(s.o && s.o.method === 'POST')));
  assert.strictEqual(r.veo_3_1.reachable, true); assert.strictEqual(r.omni_flash_1_1.reachable, true);
  assert.ok(!JSON.stringify(r).includes('SECRET123'));
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Media Studio Phase 0: acceptance harness (Issue #10)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
