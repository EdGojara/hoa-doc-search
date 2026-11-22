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
function fakeRegistry({ v2Assets, mappings = [] }) {
  const versions = [
    { id: 'f1', component: 'face', version_no: 1, assets: [{ sha256: sha('A'), role: 'canonical' }] },
    { id: 'f2', component: 'face', version_no: 2, assets: v2Assets },
    { id: 'vo', component: 'voice', version_no: 1, assets: [] },
  ];
  const d = { character: { character_id: 'c1', character_slug: 'x_y', roster_persona: 'x', current_release_id: null }, versions, releases: [], mappings };
  return { listCharacters: async () => [d.character], getCharacterDetail: async () => d };
}
const base = (reg, root, extra = {}) => checkIdentityDrift({
  registry: reg, repoRoot: root, faceOf: () => 'X',
  personaImages: { _canonical_index: { x: { canonical: 'public/assets/presentations/team/x.jpg' } } },
  env: {}, ...extra,
});

(async () => {
  await t('clean: current headshot, photo and its sized copies pass; legacy face in the headshot slot is an error', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B', 'public/assets/personas/x/x-photo.jpg': 'C', 'public/assets/personas/x/x-photo-480.jpg': 'C480', 'public/assets/personas/x/x-photo-square.jpg': 'Csq' });
    const reg = fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }, { sha256: sha('C'), role: 'derived' }] });
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
  await t('avatar built from a replaced face is an error; from the current face it passes; unregistered avatar is an error', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const look = (src) => ({ status: 'active', provider: 'heygen', kind: 'look', external_id: 'L1', sources: [{ component_version_id: src }] });
    let r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }], mappings: [look('f1')] }), root, { env: { X_AVATAR_ID: 'L1' } });
    assert.ok(r.findings.some((f) => f.area === 'avatar' && /replaced face v1/.test(f.message)));
    r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }], mappings: [look('f2')] }), root, { env: { X_AVATAR_ID: 'L1' } });
    assert.ok(!r.findings.some((f) => f.area === 'avatar'));
    r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }] }), root, { env: { X_AVATAR_ID: 'L9' } });
    assert.ok(r.findings.some((f) => f.area === 'avatar' && /not a registered look/.test(f.message)));
  });
  await t('a face version that shares an image with the current one is the same face (no false replaced-face alarm)', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const look = { status: 'active', provider: 'heygen', kind: 'look', external_id: 'L1', sources: [{ component_version_id: 'f1' }] };
    const r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }, { sha256: sha('A'), role: 'derived' }], mappings: [look] }), root, { env: { X_AVATAR_ID: 'L1' } });
    assert.ok(!r.findings.some((f) => f.area === 'avatar'), JSON.stringify(r.findings));
  });
  await t('video voice missing from the provider catalog is an error', async () => {
    const root = repo({ 'public/assets/presentations/team/x.jpg': 'B' });
    const r = await base(fakeRegistry({ v2Assets: [{ sha256: sha('B'), role: 'canonical' }] }), root,
      { env: { X_VOICE_ID: 'v-gone' }, heygenVoiceIds: new Set(['v-ok']) });
    assert.ok(r.findings.some((f) => f.area === 'voice' && f.severity === 'error' && /catalog/.test(f.message)));
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
