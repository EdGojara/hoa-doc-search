// tests/test_identity_drift.js — lib/characters/identity_drift.js (Ed 2026-11-22).
// Fake registry and a temp repo folder; no network, no database.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { checkIdentityDrift } = require('../lib/characters/identity_drift');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idrift-'));
  for (const [p, body] of Object.entries(files)) { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
  return root;
}
// One character, persona "x": face v1 (old image A), face v2 (new image B + photo C).
// Release r2 (face v2, approved) is current unless noRelease.
function fakeRegistry({ v2Assets, mappings = [], noRelease = false }) {
  const versions = [
    { id: 'f1', component: 'face', version_no: 1, status: 'rejected', assets: [{ sha256: sha('A'), role: 'canonical' }] },
    { id: 'f2', component: 'face', version_no: 2, status: 'approved', assets: v2Assets },
    { id: 'vo', component: 'voice', version_no: 1, status: 'proposed', assets: [] },
  ];
  const releases = noRelease ? [] : [{ id: 'r2', release_no: 2, components: { face: 'f2' } }];
  const d = { character: { character_id: 'c1', character_slug: 'x_y', roster_persona: 'x', current_release_id: noRelease ? null : 'r2' }, versions, releases, mappings };
  return { listCharacters: async () => [d.character], getCharacterDetail: async () => d };
}
const prodLook = (src, id = 'L1', channel = 'video') => ({ status: 'active', provider: 'heygen', kind: 'look', external_id: id, channel, sources: [{ component_version_id: src }] });
const base = (reg, root, extra = {}) => checkIdentityDrift({
  registry: reg, repoRoot: root, faceOf: () => 'X',
  personaImages: { _canonical_index: { x: { canonical: 'public/assets/presentations/team/x.jpg' } } },
  env: {}, ...extra,
});

(async () => {
  await t('clean: current headshot, photo and its sized copies pass; legacy face in the headshot slot is an error', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B', 'public/assets/personas/x/x-photo.jpg': 'C', 'public/assets/personas/x/x-photo-480.jpg': 'C480', 'public/assets/personas/x/x-photo-square.jpg': 'Csq' });
    const reg = fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }, { sha256: sha('C'), role: 'derived' }], mappings: [prodLook('f2')] });
    let r = await base(reg, root);
    assert.deepStrictEqual(r.findings, []);
    fs.writeFileSync(path.join(root, 'public/assets/presentations/team/x.jpg'), 'A');
    r = await base(reg, root);
    assert.ok(r.findings.some((f) => f.area === 'headshot' && f.severity === 'error' && /REPLACED face \(face v1\)/.test(f.message)));
  });
  await t('unregistered image in the photo folder is a warning', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B', 'public/assets/personas/x/new-generated.jpg': 'Z' });
    const r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }] }), root);
    assert.ok(r.findings.some((f) => f.area === 'photos' && f.severity === 'warn' && /new-generated/.test(f.message)));
  });
  await t('the Canon decides the production look: a look only from a replaced face is an error; from the current face it passes; a stale env avatar is only a warning; no current release is an error', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const v2 = [{ sha256: sha('B'), role: 'canonical' }];
    let r = await base(fakeRegistry({ v2Assets: v2, mappings: [prodLook('f1')] }), root);
    assert.ok(r.findings.some((f) => f.area === 'avatar' && f.severity === 'error' && /no production HeyGen look is mapped to face v2/.test(f.message)), JSON.stringify(r.findings));
    r = await base(fakeRegistry({ v2Assets: v2, mappings: [prodLook('f2')] }), root);
    assert.ok(!r.findings.some((f) => f.area === 'avatar'));
    r = await base(fakeRegistry({ v2Assets: v2, mappings: [prodLook('f2')] }), root, { env: { X_AVATAR_ID: 'OLD' } });
    assert.ok(r.findings.some((f) => f.area === 'avatar' && f.severity === 'warn' && /stale \(ignored\)/.test(f.message)));
    assert.ok(r.ok, 'a stale env value is not an error: renders no longer read it');
    r = await base(fakeRegistry({ v2Assets: v2, mappings: [prodLook('f2')], noRelease: true }), root);
    assert.ok(r.findings.some((f) => f.area === 'avatar' && /no current approved release/.test(f.message)));
  });
  await t('a face version that shares an image with the current one is the same face (no false replaced-face alarm)', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }, { sha256: sha('A'), role: 'derived' }], mappings: [prodLook('f1')] }), root);
    assert.ok(!r.findings.some((f) => f.area === 'avatar'), JSON.stringify(r.findings));
  });
  await t('no approved canonical voice is a warning (not an avatar error); HeyGen library voices are no longer checked', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }], mappings: [prodLook('f2')] }), root,
      { env: { X_VOICE_ID: 'v-gone' }, heygenVoiceIds: new Set(['v-ok']) });
    assert.ok(r.findings.some((f) => f.area === 'voice' && f.severity === 'warn' && /no approved canonical voice/.test(f.message)));
    assert.ok(!r.findings.some((f) => /catalog/.test(f.message)));
    assert.ok(!r.findings.some((f) => f.area === 'avatar'), 'a missing voice is not reported as an avatar problem');
    assert.ok(r.ok);
  });
  await t('a changed website portrait is an error', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('changed') });
    const r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }] }), root, {
      checkWebsites: true, fetchImpl,
      personaImages: { _canonical_index: { x: { canonical: 'public/assets/presentations/team/x.jpg' } }, _websites: { x: [{ url: 'https://example.test/x.webp', sha256: sha('orig') }] } },
    });
    assert.ok(r.findings.some((f) => f.area === 'website' && f.severity === 'error'));
  });
  if (failed) { console.log(`\n${failed} identity drift check(s) FAILED`); process.exit(1); }
  console.log('\nall identity drift checks passed');
})();
