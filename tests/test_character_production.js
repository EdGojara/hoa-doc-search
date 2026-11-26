// tests/test_character_production.js — lib/characters/production.js and the
// render path in lib/video/heygen.js (Ed 2026-11-26: "The Character Canon must
// govern production programmatically"). Fake registry; no network, no database.
'use strict';
const assert = require('assert');
const production = require('../lib/characters/production');

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };

// persona "x": face v1 (replaced), face v2 (approved, current), voice v1.
function detail({ release = { face: 'f2' }, faceStatus = 'approved', voiceStatus = null, mappings }) {
  const versions = [
    { id: 'f1', component: 'face', version_no: 1, status: 'rejected', assets: [{ sha256: 'a'.repeat(64), role: 'canonical' }] },
    { id: 'f2', component: 'face', version_no: 2, status: faceStatus, assets: [{ sha256: 'b'.repeat(64), role: 'canonical' }] },
    { id: 'p1', component: 'persona', version_no: 1, status: 'approved', assets: [] },
    { id: 'v1', component: 'voice', version_no: 1, status: voiceStatus || 'proposed', assets: [] },
  ];
  return {
    character: { character_id: 'c1', character_slug: 'x_y', display_name: 'Xena Y', roster_persona: 'x', current_release_id: release ? 'r1' : null },
    versions, releases: release ? [{ id: 'r1', release_no: 3, components: release }] : [],
    mappings: mappings || [
      { status: 'active', provider: 'heygen', kind: 'look', external_id: 'LOOK_NEW', channel: 'video', sources: [{ component_version_id: 'f2' }] },
      { status: 'active', provider: 'heygen', kind: 'look', external_id: 'LOOK_VAR', channel: 'video_variant', sources: [{ component_version_id: 'f2' }] },
      { status: 'retired', provider: 'heygen', kind: 'look', external_id: 'LOOK_OLD', channel: 'video', sources: [{ component_version_id: 'f1' }] },
      { status: 'active', provider: 'heygen', kind: 'look', external_id: 'LOOK_F1', channel: 'video', sources: [{ component_version_id: 'f1' }] },
      { status: 'active', provider: 'elevenlabs', kind: 'voice', external_id: 'EL_X', channel: 'portal_tts', sources: [{ component_version_id: 'v1' }] },
      { status: 'active', provider: 'heygen', kind: 'voice', external_id: 'HG_STOCK', channel: 'video', sources: [{ component_version_id: 'v1' }] },
    ],
  };
}
const reg = (d) => ({ listCharacters: async () => [d.character], getCharacterDetail: async () => d });

(async () => {
  await t('resolves the one production look of the approved current face; variants listed; looks from a replaced face ignored', async () => {
    const r = production.resolveDetail(detail({}));
    assert.strictEqual(r.primary_look, 'LOOK_NEW');
    assert.deepStrictEqual(r.variant_looks, ['LOOK_VAR']);
    assert.strictEqual(r.face.version_no, 2);
    assert.ok(r.problems.some((p) => /no approved voice/.test(p)));
  });
  await t('an unapproved face, no current release, or two production looks yields no look and says why', async () => {
    assert.strictEqual(production.resolveDetail(detail({ faceStatus: 'proposed' })).primary_look, null);
    assert.ok(production.resolveDetail(detail({ release: null })).problems[0].includes('no current approved release'));
    const two = detail({}); two.mappings.push({ status: 'active', provider: 'heygen', kind: 'look', external_id: 'LOOK_2', channel: 'video', sources: [{ component_version_id: 'f2' }] });
    const r = production.resolveDetail(two);
    assert.strictEqual(r.primary_look, null);
    assert.ok(r.problems.some((p) => /2 production HeyGen looks/.test(p)));
  });
  await t('an approved voice resolves to its ElevenLabs voice only (never the stock HeyGen voice)', async () => {
    const r = production.resolveDetail(detail({ release: { face: 'f2', voice: 'v1' }, voiceStatus: 'approved' }));
    assert.deepStrictEqual(r.voice, { version_no: 1, elevenlabs_voice_id: 'EL_X' });
  });
  await t('resolveForRender stops with the reason when the voice is not approved; nothing falls back', async () => {
    const d = detail({});
    await production.load(reg(d));
    await assert.rejects(production.resolveForRender(reg(d), 'x'), (e) => e.code === 'IDENTITY_NOT_APPROVED' && /Production stopped for Xena Y/.test(e.message) && /voice/.test(e.message));
    const ok = await production.resolveForRender(reg(d), 'x', { requireVoice: false });
    assert.strictEqual(ok.avatar_id, 'LOOK_NEW');
  });
  await t('an explicit look must be an approved look of the same current face', async () => {
    const d = detail({ release: { face: 'f2', voice: 'v1' }, voiceStatus: 'approved' });
    await production.load(reg(d));
    assert.strictEqual((await production.resolveForRender(reg(d), 'x', { lookId: 'LOOK_VAR' })).avatar_id, 'LOOK_VAR');
    await assert.rejects(production.resolveForRender(reg(d), 'x', { lookId: 'LOOK_OLD' }), /not an approved look/);
    await assert.rejects(production.resolveForRender(reg(d), 'x', { lookId: 'LOOK_F1' }), /not an approved look/);
    await assert.rejects(production.resolveForRender(reg(d), 'nobody'), /not in the Character Canon/);
  });

  // ---- the render path ------------------------------------------------------
  const heygen = require('../lib/video/heygen');
  await t('renderExplainer: no approved voice -> refuses before any audio or HeyGen call', async () => {
    const d = detail({});
    await production.load(reg(d));
    let calls = 0;
    const deps = { registry: reg(d), speakOnce: async () => { calls++; return Buffer.from('x'); }, uploadAudio: async () => { calls++; return 'A'; }, heygenFetch: async () => { calls++; return { video_id: 'V' }; } };
    await assert.rejects(heygen.renderExplainer({ script: 'Hello', persona: 'x' }, deps), (e) => e.code === 'IDENTITY_NOT_APPROVED');
    assert.strictEqual(calls, 0);
  });
  await t('renderExplainer: speaks the script in the canonical ElevenLabs voice and lip-syncs the production look to that audio', async () => {
    const d = detail({ release: { face: 'f2', voice: 'v1' }, voiceStatus: 'approved' });
    await production.load(reg(d));
    const seen = {};
    const deps = {
      registry: reg(d),
      speakOnce: async (text, o) => { seen.tts = { text, voiceId: o.voiceId, fmt: o.outputFormat }; return Buffer.from('mp3'); },
      uploadAudio: async (buf) => { seen.upload = buf.toString(); return 'AUDIO1'; },
      heygenFetch: async (p, o) => { seen.post = { p, body: JSON.parse(o.body) }; return { video_id: 'VID1' }; },
    };
    const id = await heygen.renderExplainer({ script: ' Hello there ', persona: 'x', title: 'T' }, deps);
    assert.strictEqual(id, 'VID1');
    assert.deepStrictEqual(seen.tts, { text: 'Hello there', voiceId: 'EL_X', fmt: 'mp3_44100_128' });
    assert.strictEqual(seen.upload, 'mp3');
    assert.strictEqual(seen.post.p, '/v3/videos');
    assert.strictEqual(seen.post.body.avatar_id, 'LOOK_NEW');
    assert.strictEqual(seen.post.body.audio_asset_id, 'AUDIO1');
    assert.ok(!('voice_id' in seen.post.body) && !('script' in seen.post.body), 'no HeyGen voice, no HeyGen text-to-speech');
  });
  await t('renderExplainer: a caller cannot pass a voice id', async () => {
    await assert.rejects(heygen.renderExplainer({ script: 'Hi', persona: 'x', voiceId: 'HG_STOCK' }, { registry: reg(detail({})) }), /voice id cannot be passed/);
  });

  if (failed) { console.log(`\n${failed} character production check(s) FAILED`); process.exit(1); }
  console.log('\nall character production checks passed');
})();
