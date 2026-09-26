#!/usr/bin/env node
// ============================================================================
// scripts/ingest_character_canon.js  (Ed 2026-09-26)  Trusted Character System, Phase A
// ----------------------------------------------------------------------------
// Ingests the canonical character packages in scripts/character_seed/*.json:
//   1. validate every spec (fail fast, write nothing)
//   2. hash every source file (local source folder, repo files, explainers bucket)
//   3. resolve provider ids at run time (env, HeyGen read-only GETs, persona_voices)
//   4. print the plan (DEFAULT: dry run, nothing written)
//   5. --apply: upload to private bucket character-canon (read-back verified),
//      register assets, then create characters / component versions / releases /
//      provider mappings through the registry functions
//   6. --backup <dir>: copy every ingested file to <dir>/sha256/<aa>/<sha>.<ext>
//
// Everything is created as PROPOSED. Approval happens on /admin/characters.
// Re-runnable: existing rows are matched and verified (spec hash, components,
// external ids). Anything that differs aborts instead of being "fixed".
//
//   node scripts/ingest_character_canon.js --source <dir> [--only <slug>] [--apply] [--backup <dir>]
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { validateSpec } = require('../lib/characters/spec');
const { specSha256, sha256Hex } = require('../lib/characters/hash');
const { planAsset, ingestAsset } = require('../lib/characters/ingest');
const registry = require('../lib/characters/registry');

const ACTOR = 'phase_a_ingest';
const SEED_DIR = path.join(__dirname, 'character_seed');
const REPO = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const SOURCE = arg('--source');
const ONLY = arg('--only');
const BACKUP = arg('--backup');

async function heygenGet(p) {
  const r = await fetch(`https://api.heygen.com${p}`, { headers: { 'x-api-key': process.env.HEYGEN_API_KEY, accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`HeyGen GET ${p} -> ${r.status}`);
  return j.data;
}

const _cache = new Map();
async function resolveExternalId(resolve) {
  const key = JSON.stringify(resolve);
  if (_cache.has(key)) return _cache.get(key);
  let id = null;
  if (resolve.env) id = process.env[resolve.env] || null;
  else if (resolve.group_of_env) {
    const look = await heygenGet(`/v3/avatars/looks/${process.env[resolve.group_of_env]}`);
    if (!resolve.look_prefix) id = look.group_id;
    else {
      const looks = await heygenGet(`/v3/avatars/looks?group_id=${look.group_id}&limit=50`);
      const items = looks.items || looks;
      const hit = items.filter((l) => l.id.startsWith(resolve.look_prefix));
      if (hit.length !== 1) throw new Error(`look prefix ${resolve.look_prefix} matched ${hit.length} looks`);
      id = hit[0].id;
    }
  } else if (resolve.heygen_voice_for_face) {
    const face = resolve.heygen_voice_for_face;
    const { data, error } = await registry.db().from('persona_voices').select('voice_id').eq('face', face).maybeSingle();
    if (error) throw new Error(`persona_voices read failed: ${error.message}`);
    id = (data && data.voice_id) || process.env[`${face}_VOICE_ID`] || null;
  } else if (resolve.phone_voice) {
    id = require('../lib/voice/persona').PERSONA.tts.voice_id;
  }
  if (!id) throw new Error(`could not resolve provider id for ${key}`);
  _cache.set(key, id);
  return id;
}

async function loadBytes(a) {
  if (a.file) {
    if (!SOURCE) throw new Error('--source is required for local files');
    return fs.readFileSync(path.join(SOURCE, a.file));
  }
  if (a.repo) return fs.readFileSync(path.join(REPO, a.repo));
  if (a.bucket) {
    const { data, error } = await registry.db().storage.from(a.bucket).download(a.key);
    if (error) throw new Error(`read ${a.bucket}/${a.key} failed: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  throw new Error('asset needs file, repo or bucket');
}
const assetLabel = (a) => a.file || a.repo || `${a.bucket}/${a.key}`;

async function planPackage(seed) {
  const errors = [];
  for (const c of seed.components) {
    const v = validateSpec(c.component, c.spec);
    if (!v.ok) errors.push(`${c.key}: ${v.errors.join('; ')}`);
  }
  if (errors.length) throw new Error(`invalid specs in ${seed.character.slug}:\n  ${errors.join('\n  ')}`);

  // Hash every file once; parents resolved by file label.
  const byLabel = new Map();
  const load = async (a) => {
    const label = assetLabel(a);
    if (!byLabel.has(label)) byLabel.set(label, { buf: await loadBytes(a), def: a });
    return byLabel.get(label);
  };
  for (const c of seed.components) for (const a of c.assets) await load(a);
  const shaOf = (label) => { const x = byLabel.get(label); if (!x) throw new Error(`unknown parent file ${label}`); return sha256Hex(x.buf); };
  const assets = new Map(); // sha -> plan
  for (const [label, { buf, def }] of byLabel) {
    const p = planAsset(buf, { origin: def.origin, originRef: def.origin_ref, parentSha256: def.parent_file ? shaOf(def.parent_file) : null, notes: null });
    if (p.parent_sha256 === p.sha256) p.parent_sha256 = null; // a derived copy that is byte-identical to its parent
    if (!assets.has(p.sha256)) assets.set(p.sha256, { ...p, label, buf });
  }
  const components = seed.components.map((c) => ({
    ...c,
    spec_sha256: specSha256(c.spec),
    assetLinks: c.assets.map((a) => ({ sha256: sha256Hex(byLabel.get(assetLabel(a)).buf), role: a.role, label: assetLabel(a) })),
  }));
  const mappings = [];
  for (const m of seed.mappings) {
    mappings.push({ ...m, external_id: await resolveExternalId(m.resolve),
      sourceLinks: m.sources.map((s) => ({ component: s.component, sha256: s.file ? shaOf(s.file) : null })) });
  }
  return { seed, assets, components, mappings };
}

function printPlan(plan) {
  const { seed, assets, components, mappings } = plan;
  console.log(`\n=== ${seed.character.display_name} (${seed.character.slug}, roster: ${seed.character.roster_persona}) ===`);
  console.log('  assets:');
  for (const a of assets.values()) {
    console.log(`    ${a.sha256.slice(0, 12)}  ${String(a.width || '')}x${String(a.height || '')} ${a.ext.padEnd(4)} ${String(Math.round(a.bytes / 1024)).padStart(5)}KB  ${a.label}${a.parent_sha256 ? `  (parent ${a.parent_sha256.slice(0, 12)})` : ''}`);
  }
  console.log('  component versions (all created as PROPOSED):');
  for (const c of components) {
    console.log(`    ${c.key.padEnd(14)} spec ${c.spec_sha256.slice(0, 12)}  ${c.assetLinks.map((l) => `${l.role}:${l.sha256.slice(0, 8)}`).join(' ') || '(no assets)'}`);
  }
  console.log('  releases:');
  for (const r of seed.releases) {
    console.log(`    ${r.key}${r.current ? ' [current]' : ''}${r.legacy ? ' [legacy]' : ''}  ${Object.entries(r.components).map(([k, v]) => `${k}=${v.split('.')[1]}`).join(' ')}`);
  }
  console.log('  provider mappings:');
  for (const m of mappings) {
    console.log(`    ${`${m.provider}:${m.kind}`.padEnd(20)} ${m.external_id.slice(0, 8)}…  ${m.license_class.padEnd(9)} ${(m.channel || '').padEnd(9)} <- ${m.sourceLinks.map((s) => `${s.component}${s.sha256 ? `@${s.sha256.slice(0, 8)}` : ''}`).join(', ')}`);
  }
}

// Reconcile one package into the registry. Existing rows must match exactly.
async function applyPackage(plan) {
  const { seed, assets, components, mappings } = plan;
  // Parents first: an asset's parent_sha256 must already be registered.
  const ordered = [...assets.values()].sort((x, y) => (x.parent_sha256 ? 1 : 0) - (y.parent_sha256 ? 1 : 0));
  for (const a of ordered) {
    await ingestAsset(a.buf, { origin: a.origin, originRef: a.origin_ref, parentSha256: a.parent_sha256 }, { actor: ACTOR, apply: true });
  }
  let character = await registry.findCharacter(seed.character.slug);
  if (!character) {
    await registry.createCharacter({ slug: seed.character.slug, displayName: seed.character.display_name,
      rosterPersona: seed.character.roster_persona, actor: ACTOR, reason: 'Phase A canonical ingest (approved by Ed 2026-09-26)' });
    character = await registry.findCharacter(seed.character.slug);
  }
  let detail = await registry.getCharacterDetail(character.character_id);
  const versionIdByKey = {};
  for (const c of components) {
    const n = Number(c.key.split('.v')[1]);
    const existing = detail.versions.find((v) => v.component === c.component && v.version_no === n);
    if (existing) {
      if (existing.spec_sha256 !== c.spec_sha256) throw new Error(`${seed.character.slug} ${c.key} exists with a different spec (refusing to guess)`);
      versionIdByKey[c.key] = existing.id; continue;
    }
    const prior = detail.versions.filter((v) => v.component === c.component).length;
    if (prior !== n - 1) throw new Error(`${seed.character.slug} ${c.key}: expected ${n - 1} prior ${c.component} versions, found ${prior}`);
    versionIdByKey[c.key] = await registry.createComponentVersion({
      characterId: character.character_id, component: c.component, spec: c.spec,
      parentVersionId: c.parent ? versionIdByKey[c.parent] : null, changeReason: c.change_reason, actor: ACTOR,
      assets: c.assetLinks.map((l) => ({ sha256: l.sha256, role: l.role })),
    });
    detail = await registry.getCharacterDetail(character.character_id);
  }
  const releaseIdByKey = {};
  for (const [i, r] of seed.releases.entries()) {
    const want = Object.fromEntries(Object.entries(r.components).map(([k, v]) => [k, versionIdByKey[v]]));
    const existing = detail.releases.find((x) => x.release_no === i + 1);
    if (existing) {
      const same = JSON.stringify(Object.entries(existing.components).sort()) === JSON.stringify(Object.entries(want).sort());
      if (!same) throw new Error(`${seed.character.slug} release ${i + 1} exists with different components`);
      releaseIdByKey[r.key] = existing.id; continue;
    }
    releaseIdByKey[r.key] = await registry.createRelease({ characterId: character.character_id, components: want, notes: r.notes,
      actor: ACTOR, parentReleaseId: r.parent ? releaseIdByKey[r.parent] : null });
  }
  detail = await registry.getCharacterDetail(character.character_id);
  for (const m of mappings) {
    const exists = detail.mappings.find((x) => x.status === 'active' && x.provider === m.provider && x.kind === m.kind
      && x.external_id === m.external_id && (x.channel || null) === (m.channel || null));
    if (exists) continue;
    await registry.createProviderMapping({ characterId: character.character_id, provider: m.provider, kind: m.kind,
      externalId: m.external_id, licenseClass: m.license_class, channel: m.channel, notes: m.notes, actor: ACTOR,
      sources: m.sourceLinks.map((s) => ({ component_version_id: versionIdByKey[`${s.component}`], asset_sha256: s.sha256, role: 'source' })) });
  }
  return character.character_id;
}

function backup(plan, dir) {
  let n = 0;
  for (const a of plan.assets.values()) {
    const dest = path.join(dir, a.storage_key);
    if (fs.existsSync(dest) && sha256Hex(fs.readFileSync(dest)) === a.sha256) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, a.buf);
    if (sha256Hex(fs.readFileSync(dest)) !== a.sha256) throw new Error(`backup verify failed for ${dest}`);
    n++;
  }
  return n;
}

(async () => {
  const files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json') && (!ONLY || f === `${ONLY}.json`)).sort();
  if (!files.length) throw new Error('no seed files matched');
  const plans = [];
  for (const f of files) plans.push(await planPackage(JSON.parse(fs.readFileSync(path.join(SEED_DIR, f), 'utf8'))));
  plans.forEach(printPlan);
  const total = new Set(plans.flatMap((p) => [...p.assets.keys()])).size;
  console.log(`\n${plans.length} characters, ${total} unique files, ${plans.reduce((s, p) => s + p.components.length, 0)} component versions.`);
  if (!APPLY) { console.log('DRY RUN: nothing was uploaded or written. Re-run with --apply.'); return; }
  for (const p of plans) {
    const id = await applyPackage(p);
    console.log(`applied ${p.seed.character.slug} -> ${id}`);
    if (BACKUP) console.log(`  backup: ${backup(p, BACKUP)} new file(s) in ${BACKUP}`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
