// tests/test_character_registry.js — Trusted Character System, Phase A (migration 467).
// Pure checks always run. Live checks run against the registry when migration 467
// is applied (they read, re-hash stored files, and confirm direct writes are refused).
// Run: node tests/test_character_registry.js
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pgJsonbText, specSha256, sniffMedia, storageKeyFor, sha256Hex } = require('../lib/characters/hash');
const { validateSpec, COMPONENTS } = require('../lib/characters/spec');
const { deriveComponents, diffComponents, releaseSignature, statusFromEvents } = require('../lib/characters/release');
const { planAsset, uploadVerified } = require('../lib/characters/ingest');

const ROOT = path.join(__dirname, '..');
const SEED_DIR = path.join(ROOT, 'scripts', 'character_seed');
const refsSeed = JSON.parse(fs.readFileSync(path.join(SEED_DIR, '_references.json'), 'utf8'));
const seeds = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8')));

let failed = 0;
const results = [];
const t = (name, fn) => results.push((async () => {
  try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
})());

// ---- hashing ---------------------------------------------------------------
t('spec hash ignores key order and matches Postgres jsonb text form', () => {
  assert.strictEqual(pgJsonbText({ bb: 1, a: [true, null], ccc: { z: 'x', y: 2 } }), '{"a": [true, null], "bb": 1, "ccc": {"y": 2, "z": "x"}}');
  assert.strictEqual(specSha256({ b: 1, a: 2 }), specSha256({ a: 2, b: 1 }));
  assert.notStrictEqual(specSha256({ a: 1 }), specSha256({ a: 2 }));
});
t('spec hash refuses non-integer numbers (would not round-trip through Postgres)', () => {
  assert.throws(() => pgJsonbText({ a: 1.5 }));
});
t('media sniffing reads real bytes, not filenames', () => {
  const m = sniffMedia(fs.readFileSync(path.join(ROOT, 'public/assets/presentations/team/paige.jpg')));
  assert.deepStrictEqual([m.media_type, m.width, m.height], ['image/jpeg', 640, 640]);
  assert.strictEqual(sniffMedia(Buffer.from('not an image at all')), null);
});
t('storage keys are content addresses and reject malformed hashes', () => {
  const s = 'ab'.repeat(32);
  assert.strictEqual(storageKeyFor(s, 'png'), `sha256/ab/${s}.png`);
  assert.throws(() => storageKeyFor('xyz', 'png'));
  assert.throws(() => storageKeyFor(s, '../x'));
});

// ---- spec validation --------------------------------------------------------
t('every seed component spec validates', () => {
  for (const s of seeds) for (const c of s.components) {
    const v = validateSpec(c.component, c.spec);
    assert.ok(v.ok, `${s.character.slug} ${c.key}: ${v.errors.join('; ')}`);
  }
});
t('identity specs refuse provider references (keys, ids, signed URLs)', () => {
  const base = { apparent_age_range: [30, 35], hair: { color: 'brown', style: 'bob' }, eyes: 'brown', skin_tone: 'warm' };
  assert.ok(validateSpec('face', base).ok);
  assert.ok(!validateSpec('face', { ...base, heygen_avatar_id: 'x' }).ok, 'provider key accepted');
  assert.ok(!validateSpec('face', { ...base, notes: '55d781b924e642e8b9c5a1224fb170c8' }).ok, 'HeyGen-shaped id accepted');
  assert.ok(!validateSpec('face', { ...base, notes: 'gJx1vCzNCD1EQHT212Ls' }).ok, 'ElevenLabs-shaped id accepted');
  assert.ok(!validateSpec('face', { ...base, canonical_image_notes: 'https://x/y.png?Expires=1&Signature=abc' }).ok, 'signed URL accepted');
  assert.ok(!validateSpec('voice', { status: 'canonical', description: 'd', voice_id: 'abc' }).ok, 'voice_id accepted in voice spec');
});
t('spec validation rejects unknown components, unknown fields, missing required fields, floats', () => {
  assert.ok(!validateSpec('aura', {}).ok);
  assert.ok(!validateSpec('body', { height_range_in: [66, 67], build: 'fit', vibe: 'x' }).ok);
  assert.ok(!validateSpec('body', { build: 'fit' }).ok);
  assert.ok(!validateSpec('body', { height_range_in: [66.5, 67], build: 'fit' }).ok);
  assert.ok(!validateSpec('wardrobe', { contexts: { gala: ['gown'] } }).ok);
  assert.ok(!validateSpec('guardrails', {}).ok);
});

// ---- whole-team scalability --------------------------------------------------
t('no character is special-cased in registry code, API or page', () => {
  const roster = require('../lib/team/roster');
  const names = new Set();
  for (const m of roster.people()) {
    for (const part of String(m.name || '').toLowerCase().split(/\s+/)) if (part.length > 2) names.add(part);
    if (m.persona) names.add(String(m.persona).toLowerCase());
  }
  const files = [...fs.readdirSync(path.join(ROOT, 'lib/characters')).map((f) => path.join(ROOT, 'lib/characters', f)),
    path.join(ROOT, 'api/characters.js'), path.join(ROOT, 'public/characters-admin.html')];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const n of names) {
      assert.ok(!new RegExp(`\\b${n}\\b`).test(text), `${path.relative(ROOT, f)} names "${n}"`);
    }
  }
});

// ---- seeds are internally consistent (mirrors the database rules) -------------
t('seed packages: one current release, legacy before current, references resolve', () => {
  for (const s of seeds) {
    const keys = new Set(s.components.map((c) => c.key));
    const cur = s.releases.filter((r) => r.current);
    assert.strictEqual(cur.length, 1, `${s.character.slug}: exactly one current release`);
    assert.ok(s.releases.indexOf(cur[0]) === s.releases.length - 1, `${s.character.slug}: current release must be last`);
    for (const r of s.releases) for (const [k, v] of Object.entries(r.components)) {
      assert.ok(COMPONENTS.includes(k) && keys.has(v) && v.startsWith(`${k}.`), `${s.character.slug} ${r.key}: bad ${k} -> ${v}`);
    }
    for (const m of s.mappings) for (const src of m.sources) {
      const c = s.components.find((x) => x.key === src.component);
      assert.ok(c, `${s.character.slug}: mapping source ${src.component} missing`);
      if (src.file) assert.ok(c.assets.some((a) => a.file === src.file), `${s.character.slug}: ${src.file} not attached to ${src.component}`);
    }
    assert.ok(/^[a-z][a-z0-9_]{1,62}$/.test(s.character.slug));
  }
});

t('reference imagery: known characters and categories, and never a canonical identity file', () => {
  const slugs = new Set(seeds.map((s) => s.character.slug));
  const canonicalFiles = new Set(seeds.flatMap((s) => s.components.flatMap((c) => c.assets.filter((a) => a.role === 'canonical').map((a) => a.file))));
  assert.ok(refsSeed.references.length > 0);
  for (const r of refsSeed.references) {
    assert.ok(['concept_scene', 'wardrobe_concept', 'drift_reference'].includes(r.category), `${r.file}: bad category`);
    assert.ok(r.characters.length && r.characters.every((c) => slugs.has(c)), `${r.file}: unknown character`);
    assert.ok(!canonicalFiles.has(r.file), `${r.file} is also a canonical identity file`);
    assert.ok(r.label && r.origin, `${r.file}: label and origin required`);
  }
});
t('releases can only reference component versions (reference imagery is structurally outside identity)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'migrations/467_character_registry.sql'), 'utf8');
  const rc = sql.match(/CREATE TABLE IF NOT EXISTS release_components \(([\s\S]*?)\n\);/)[1];
  assert.ok(/component_version_id\s+uuid NOT NULL REFERENCES component_versions\(id\)/.test(rc));
  assert.ok(!/character_reference_assets|reference_asset/i.test(rc), 'release_components can point at reference imagery');
});

// ---- releases ----------------------------------------------------------------
t('derive release swaps only the named component; null removes; unknown refused', () => {
  const base = { face: 'f2', voice: 'v1', wardrobe: 'w3' };
  assert.deepStrictEqual(deriveComponents(base, { wardrobe: 'w1' }), { face: 'f2', voice: 'v1', wardrobe: 'w1' });
  assert.deepStrictEqual(deriveComponents(base, { voice: null }), { face: 'f2', wardrobe: 'w3' });
  assert.throws(() => deriveComponents(base, { aura: 'x' }));
  assert.deepStrictEqual(diffComponents(base, { face: 'f2', voice: 'v2', wardrobe: 'w3' }), [{ component: 'voice', from: 'v1', to: 'v2' }]);
});
t('release signature is order-independent; status is the latest status event', () => {
  const e = [{ component: 'voice', component_version_id: 'b', spec_sha256: '2' }, { component: 'face', component_version_id: 'a', spec_sha256: '1' }];
  assert.strictEqual(releaseSignature(e), releaseSignature([...e].reverse()));
  assert.strictEqual(releaseSignature(e), sha256Hex(Buffer.from('face:a:1;voice:b:2;')));
  const ev = [{ id: 1, subject_id: 'r', event: 'proposed' }, { id: 3, subject_id: 'r', event: 'retired' },
    { id: 2, subject_id: 'r', event: 'promoted' }, { id: 4, subject_id: 'r', event: 'renamed' }, { id: 5, subject_id: 'x', event: 'approved' }];
  assert.strictEqual(statusFromEvents(ev, 'r'), 'retired');
});

// ---- ingest --------------------------------------------------------------------
t('ingest refuses unknown bytes and aborts on a read-back mismatch', async () => {
  assert.throws(() => planAsset(Buffer.from('garbage'), { origin: 'test' }));
  const good = fs.readFileSync(path.join(ROOT, 'public/assets/presentations/team/paige.jpg'));
  const plan = planAsset(good, { origin: 'test' });
  const corrupt = Buffer.from(good); corrupt[corrupt.length - 10] ^= 0xff;
  const fakeClient = { storage: { from: () => ({
    upload: async () => ({ error: null }),
    download: async () => ({ data: { arrayBuffer: async () => corrupt }, error: null }),
  }) } };
  await assert.rejects(() => uploadVerified(good, plan, { client: fakeClient }), /read-back mismatch/);
  const okClient = { storage: { from: () => ({
    upload: async () => ({ error: { message: 'The resource already exists' } }),
    download: async () => ({ data: { arrayBuffer: async () => good }, error: null }),
  }) } };
  assert.deepStrictEqual(await uploadVerified(good, plan, { client: okClient }), { reused: true });
});

// ---- production vs canon ---------------------------------------------------------
t('divergence: runtime ids are classified against the current release', () => {
  const { runtimeDivergence } = require('../lib/characters/registry');
  const detail = {
    versions: [{ id: 'f1', component: 'face', version_no: 1 }, { id: 'f2', component: 'face', version_no: 2 }, { id: 'v1', component: 'voice', version_no: 1 }],
    releases: [{ is_current: true, release_no: 2, components: { face: 'f2', voice: 'v1' } }],
    mappings: [
      { status: 'active', provider: 'heygen', kind: 'look', external_id: 'OLD', channel: 'video', sources: [{ component_version_id: 'f1' }] },
      { status: 'active', provider: 'heygen', kind: 'voice', external_id: 'VO', channel: 'video', sources: [{ component_version_id: 'v1' }] },
    ],
  };
  const r = runtimeDivergence(detail, { avatar_id: 'OLD', video_voice_id: 'VO', tts_voice_id: 'NEW' });
  const by = Object.fromEntries(r.rows.map((x) => [x.label, x]));
  assert.strictEqual(by['HeyGen avatar (video)'].state, 'maps_to_other_version');
  assert.deepStrictEqual(by['HeyGen avatar (video)'].mapped_versions, ['face v1']);
  assert.strictEqual(by['HeyGen voice (video)'].state, 'matches_current');
  assert.strictEqual(by['ElevenLabs voice (portal TTS)'].state, 'unmapped');
});
t('divergence before any promotion reports "no current release", not drift', () => {
  const { runtimeDivergence } = require('../lib/characters/registry');
  const detail = { versions: [{ id: 'f1', component: 'face', version_no: 1 }], releases: [{ is_current: false, release_no: 1, components: { face: 'f1' } }],
    mappings: [{ status: 'active', provider: 'heygen', kind: 'look', external_id: 'L', channel: 'video', sources: [{ component_version_id: 'f1' }] }] };
  const r = runtimeDivergence(detail, { avatar_id: 'L', video_voice_id: 'X' });
  assert.strictEqual(r.rows[0].state, 'no_current_release');
  assert.strictEqual(r.rows[1].state, 'unmapped');
});

// ---- live registry -----------------------------------------------------------------
async function live() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('SKIP  live registry checks (no Supabase credentials)'); return; }
  const registry = require('../lib/characters/registry');
  const probe = await registry.db().from('characters').select('character_id').limit(1);
  if (probe.error && /does not exist|schema cache/i.test(probe.error.message)) {
    console.log('SKIP  live registry checks (migration 467 not applied yet)'); return;
  }
  t('live: direct writes to the registry are refused, even for the service role', async () => {
    const db = registry.db();
    const a = await db.from('characters').insert({ character_slug: 'zz_direct', display_name: 'X', created_by: 'test' });
    assert.ok(a.error && /not allowed/i.test(a.error.message), `direct insert allowed: ${a.error ? a.error.message : 'no error'}`);
    const b = await db.from('character_events').update({ actor: 'tamper' }).gt('id', 0).select('id');
    assert.ok((b.error && /immutable|not allowed/i.test(b.error.message)) || (b.data && b.data.length === 0), 'event update allowed');
    const c = await db.from('component_versions').delete().gt('version_no', 0).select('id');
    assert.ok((c.error && /immutable/i.test(c.error.message)) || (c.data && c.data.length === 0), 'delete allowed');
  });
  const list = await registry.listCharacters();
  if (!list.length) { console.log('SKIP  live data checks (registry is empty; run the ingest)'); return; }
  t('live: every stored file re-hashes to its own name; specs and release signatures verify', async () => {
    for (const c of list) {
      const d = await registry.getCharacterDetail(c.character_id);
      for (const a of d.assets) {
        const v = await registry.verifyAsset(a);
        assert.ok(v.ok, `${c.character_slug} ${a.sha256.slice(0, 12)}: ${v.error || `hash ${String(v.actual).slice(0, 12)}`}`);
        assert.strictEqual(a.storage_key, storageKeyFor(a.sha256, a.storage_key.split('.').pop()));
      }
      for (const v of d.versions) assert.ok(registry.verifySpecHash(v), `${c.character_slug} ${v.component} v${v.version_no} spec hash`);
      for (const r of d.releases) assert.ok(r.signature_ok, `${c.character_slug} release ${r.release_no} signature`);
      for (const m of d.mappings) for (const s of m.sources) {
        if (!s.asset_sha256) continue;
        const v = d.versions.find((x) => x.id === s.component_version_id);
        assert.ok(v && v.assets.some((x) => x.sha256 === s.asset_sha256), `${c.character_slug} mapping source asset not on its component version`);
      }
    }
  });
}

(async () => {
  await Promise.all(results);
  await live();
  await Promise.all(results);
  console.log(failed ? `\n${failed} FAILED` : '\nall character registry checks passed');
  process.exitCode = failed ? 1 : 0; // not process.exit(): open fetch sockets crash libuv on Windows
})();
