#!/usr/bin/env node
// ============================================================================
// scripts/character_canon_sync.js  (Ed 2026-11-22)  Trusted Character System, Phase 1 sync
// ----------------------------------------------------------------------------
// Adds NEW records to the Character Canon from a plan file, without touching
// anything already registered. The September ingest
// (scripts/ingest_character_canon.js) needs its original source folder to
// re-run; this script only appends: new characters, new component versions,
// new releases and new provider mappings. Every existing row is matched and
// verified, never changed.
//
//   node scripts/character_canon_sync.js --plan <file.json> [--source <dir>] [--apply]
//
// Default is a DRY RUN that prints the plan and writes nothing. Everything is
// created as PROPOSED; approval and promotion are the owner's, on
// /characters-admin.html. This script never approves or promotes.
//
// Plan file: { "actor": "...", "characters": [ {
//   "slug", "display_name", "roster_persona",           // created if missing
//   "versions": [ { "component", "version_no", "parent_version_no"?, "change_reason", "spec",
//                   "assets": [ { "file"|"repo"|"sha256", "role", "origin", "origin_ref"?, "parent"? } ] } ],
//   "releases": [ { "release_no", "parent_release_no"?, "notes", "components": { "face": 4, ... } } ],
//   "mappings": [ { "provider", "kind", "resolve": {...}, "license_class", "channel"?, "notes"?,
//                   "sources": [ { "component", "version_no", "file"|"repo"|"sha256"? } ] } ] } ] }
//
// resolve (provider ids are never committed to the public repo):
//   { env: NAME }                         a Render/env variable
//   { group_of_env: NAME, look_prefix? }  the HeyGen group (or one look in it) of the look in NAME
//   { heygen_group_named: "..." }         the one private HeyGen avatar group with exactly this name
//   { heygen_voice_for_face: FACE }       persona_voices override, else FACE_VOICE_ID
//   { tts_voice_for_face: FACE }          persona_tts_voices override (ElevenLabs spoken voice)
// A resolve that finds nothing is reported and that mapping is skipped (never guessed).
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { validateSpec } = require('../lib/characters/spec');
const { specSha256, sha256Hex } = require('../lib/characters/hash');
const { planAsset, ingestAsset } = require('../lib/characters/ingest');
const registry = require('../lib/characters/registry');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const PLAN = arg('--plan');
const SOURCE = arg('--source');
const REPO = path.join(__dirname, '..');

async function heygenGet(p) {
  const r = await fetch(`https://api.heygen.com${p}`, { headers: { 'x-api-key': process.env.HEYGEN_API_KEY, accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`HeyGen GET ${p} -> ${r.status}`);
  return j.data;
}

async function resolveExternalId(resolve) {
  if (resolve.env) return process.env[resolve.env] || null;
  if (resolve.group_of_env) {
    const lookId = process.env[resolve.group_of_env];
    if (!lookId) return null;
    const look = await heygenGet(`/v3/avatars/looks/${lookId}`);
    if (!resolve.look_prefix) return look.group_id;
    const looks = await heygenGet(`/v3/avatars/looks?group_id=${look.group_id}&limit=50`);
    const hit = (looks.items || looks).filter((l) => l.id.startsWith(resolve.look_prefix));
    if (hit.length !== 1) throw new Error(`look prefix ${resolve.look_prefix} matched ${hit.length} looks`);
    return hit[0].id;
  }
  if (resolve.heygen_group_named) {
    const d = await heygenGet('/v2/avatar_group.list?include_public=false');
    const hit = (d.avatar_group_list || []).filter((g) => g.name === resolve.heygen_group_named);
    if (hit.length > 1) throw new Error(`HeyGen group name "${resolve.heygen_group_named}" matched ${hit.length} groups`);
    return hit.length ? hit[0].id : null;
  }
  if (resolve.heygen_voice_for_face) {
    const face = resolve.heygen_voice_for_face;
    const { data, error } = await registry.db().from('persona_voices').select('voice_id').eq('face', face).maybeSingle();
    if (error) throw new Error(`persona_voices read failed: ${error.message}`);
    return (data && data.voice_id) || process.env[`${face}_VOICE_ID`] || null;
  }
  if (resolve.tts_voice_for_face) {
    const { data, error } = await registry.db().from('persona_tts_voices').select('voice_id').eq('face', resolve.tts_voice_for_face).maybeSingle();
    if (error) throw new Error(`persona_tts_voices read failed: ${error.message}`);
    return (data && data.voice_id) || null;
  }
  throw new Error(`unknown resolve ${JSON.stringify(resolve)}`);
}

// Bytes for an asset reference: a local file, a repo file, or an asset already in the canon bucket.
async function loadBytes(a) {
  if (a.file) {
    if (!SOURCE) throw new Error(`--source is required for local file ${a.file}`);
    return fs.readFileSync(path.join(SOURCE, a.file));
  }
  if (a.repo) return fs.readFileSync(path.join(REPO, a.repo));
  if (a.sha256) {
    const { data, error } = await registry.db().from('character_assets').select('storage_key').eq('sha256', a.sha256).maybeSingle();
    if (error) throw new Error(`asset lookup failed: ${error.message}`);
    if (!data) throw new Error(`asset ${a.sha256.slice(0, 12)} is not registered`);
    const dl = await registry.db().storage.from(registry.BUCKET).download(data.storage_key);
    if (dl.error) throw new Error(`download ${data.storage_key} failed: ${dl.error.message}`);
    const buf = Buffer.from(await dl.data.arrayBuffer());
    if (sha256Hex(buf) !== a.sha256) throw new Error(`stored asset ${a.sha256.slice(0, 12)} does not match its hash`);
    return buf;
  }
  throw new Error('asset needs file, repo or sha256');
}
const labelOf = (a) => a.file || a.repo || `canon:${a.sha256.slice(0, 12)}`;

async function planCharacter(c) {
  for (const v of c.versions || []) {
    const r = validateSpec(v.component, v.spec);
    if (!r.ok) throw new Error(`${c.slug} ${v.component}.v${v.version_no}: ${r.errors.join('; ')}`);
  }
  const files = new Map(); // label -> { buf, sha, def }
  const load = async (a) => {
    const l = labelOf(a);
    if (!files.has(l)) { const buf = await loadBytes(a); files.set(l, { buf, sha: sha256Hex(buf), def: a }); }
    return files.get(l);
  };
  for (const v of c.versions || []) for (const a of v.assets || []) await load(a);
  for (const m of c.mappings || []) for (const s of m.sources || []) if (s.file || s.repo || s.sha256) await load(s);
  const shaOfLabel = (l) => { const f = files.get(l); if (!f) throw new Error(`${c.slug}: unknown parent ${l}`); return f.sha; };
  const assets = new Map();
  for (const [l, f] of files) {
    if (f.def.sha256) continue; // already registered
    const p = planAsset(f.buf, { origin: f.def.origin || 'repo', originRef: f.def.origin_ref, parentSha256: f.def.parent ? shaOfLabel(f.def.parent) : null });
    if (p.parent_sha256 === p.sha256) p.parent_sha256 = null;
    assets.set(p.sha256, { ...p, label: l, buf: f.buf });
  }
  // One link per (asset, role): two repo paths can hold byte-identical files.
  const versions = (c.versions || []).map((v) => {
    const seen = new Set();
    const links = [];
    for (const a of v.assets || []) {
      const l = { sha256: files.get(labelOf(a)).sha, role: a.role, label: labelOf(a) };
      if (seen.has(`${l.sha256}|${l.role}`)) continue;
      seen.add(`${l.sha256}|${l.role}`); links.push(l);
    }
    return { ...v, spec_sha256: specSha256(v.spec), links };
  });
  const mappings = [];
  const unresolved = [];
  for (const m of c.mappings || []) {
    const id = await resolveExternalId(m.resolve);
    if (!id) { unresolved.push(`${m.provider}:${m.kind} ${JSON.stringify(m.resolve)}`); continue; }
    mappings.push({ ...m, external_id: id,
      sourceLinks: (m.sources || []).map((s) => ({ component: s.component, version_no: s.version_no, sha256: (s.file || s.repo || s.sha256) ? files.get(labelOf(s)).sha : null })) });
  }
  return { c, assets, versions, mappings, unresolved };
}

function printPlan(p) {
  const { c, assets, versions, mappings, unresolved } = p;
  console.log(`\n=== ${c.display_name} (${c.slug}, roster: ${c.roster_persona || '-'}) ===`);
  if (assets.size) {
    console.log('  new assets:');
    for (const a of assets.values()) console.log(`    ${a.sha256.slice(0, 12)}  ${a.width}x${a.height} ${String(a.ext).padEnd(4)} ${String(Math.round(a.bytes / 1024)).padStart(5)}KB  ${a.label}`);
  }
  for (const v of versions) {
    console.log(`  ${v.component}.v${v.version_no}${v.parent_version_no ? ` (parent v${v.parent_version_no})` : ''}  spec ${v.spec_sha256.slice(0, 12)}${(v.spec.open_questions || []).length ? `  OPEN QUESTIONS: ${v.spec.open_questions.length}` : ''}`);
    for (const l of v.links) console.log(`      ${l.role.padEnd(18)} ${l.sha256.slice(0, 12)}  ${l.label}`);
  }
  for (const r of c.releases || []) console.log(`  release ${r.release_no}: ${Object.entries(r.components).map(([k, n]) => `${k}=v${n}`).join(' ')}  ${r.notes}`);
  for (const m of mappings) console.log(`  map ${`${m.provider}:${m.kind}`.padEnd(20)} ${m.external_id.slice(0, 8)}…  ${m.license_class}${m.channel ? `/${m.channel}` : ''}  <- ${m.sourceLinks.map((s) => `${s.component}.v${s.version_no}`).join(', ')}  ${m.notes || ''}`);
  for (const u of unresolved) console.log(`  UNRESOLVED (skipped): ${u}`);
}

async function applyCharacter(p, actor) {
  const { c, assets, versions, mappings } = p;
  const ordered = [...assets.values()].sort((x, y) => (x.parent_sha256 ? 1 : 0) - (y.parent_sha256 ? 1 : 0));
  for (const a of ordered) await ingestAsset(a.buf, { origin: a.origin, originRef: a.origin_ref, parentSha256: a.parent_sha256 }, { actor, apply: true });

  let ch = await registry.findCharacter(c.slug);
  if (!ch) {
    await registry.createCharacter({ slug: c.slug, displayName: c.display_name, rosterPersona: c.roster_persona, actor,
      reason: 'Phase 1 identity sync (Ed 2026-11-22): register the approved production identity for review' });
    ch = await registry.findCharacter(c.slug);
  }
  let d = await registry.getCharacterDetail(ch.character_id);
  const vid = (component, n) => { const v = d.versions.find((x) => x.component === component && x.version_no === n); return v ? v.id : null; };
  for (const v of versions) {
    const existing = d.versions.find((x) => x.component === v.component && x.version_no === v.version_no);
    if (existing) {
      if (existing.spec_sha256 !== v.spec_sha256) throw new Error(`${c.slug} ${v.component}.v${v.version_no} exists with a different spec (refusing to guess)`);
      continue;
    }
    const prior = d.versions.filter((x) => x.component === v.component).length;
    if (prior !== v.version_no - 1) throw new Error(`${c.slug} ${v.component}.v${v.version_no}: expected ${v.version_no - 1} prior versions, found ${prior}`);
    await registry.createComponentVersion({ characterId: ch.character_id, component: v.component, spec: v.spec,
      parentVersionId: v.parent_version_no ? vid(v.component, v.parent_version_no) : null, changeReason: v.change_reason, actor,
      assets: v.links.map((l) => ({ sha256: l.sha256, role: l.role })) });
    d = await registry.getCharacterDetail(ch.character_id);
  }
  for (const r of c.releases || []) {
    const want = Object.fromEntries(Object.entries(r.components).map(([k, n]) => {
      const id = vid(k, n); if (!id) throw new Error(`${c.slug} release ${r.release_no}: no ${k}.v${n}`); return [k, id];
    }));
    const existing = d.releases.find((x) => x.release_no === r.release_no);
    if (existing) {
      const same = JSON.stringify(Object.entries(existing.components).sort()) === JSON.stringify(Object.entries(want).sort());
      if (!same) throw new Error(`${c.slug} release ${r.release_no} exists with different components`);
      continue;
    }
    const parent = r.parent_release_no ? (d.releases.find((x) => x.release_no === r.parent_release_no) || {}).id : null;
    await registry.createRelease({ characterId: ch.character_id, components: want, notes: r.notes, actor, parentReleaseId: parent || null });
    d = await registry.getCharacterDetail(ch.character_id);
  }
  for (const m of mappings) {
    const exists = d.mappings.find((x) => x.status === 'active' && x.provider === m.provider && x.kind === m.kind
      && x.external_id === m.external_id && (x.channel || null) === (m.channel || null));
    if (exists) continue;
    await registry.createProviderMapping({ characterId: ch.character_id, provider: m.provider, kind: m.kind, externalId: m.external_id,
      licenseClass: m.license_class, channel: m.channel, notes: m.notes, actor,
      sources: m.sourceLinks.map((s) => {
        const id = vid(s.component, s.version_no); if (!id) throw new Error(`${c.slug} mapping source ${s.component}.v${s.version_no} missing`);
        return { component_version_id: id, asset_sha256: s.sha256, role: 'source' };
      }) });
  }
  return ch.character_id;
}

(async () => {
  if (!PLAN) throw new Error('--plan <file.json> is required');
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  const actor = plan.actor || 'phase1_identity_sync';
  const plans = [];
  for (const c of plan.characters) plans.push(await planCharacter(c));
  plans.forEach(printPlan);
  const unresolved = plans.reduce((s, p) => s + p.unresolved.length, 0);
  console.log(`\n${plans.length} characters; ${plans.reduce((s, p) => s + p.versions.length, 0)} component versions; ${plans.reduce((s, p) => s + p.mappings.length, 0)} provider mappings; ${unresolved} unresolved.`);
  if (!APPLY) { console.log('DRY RUN: nothing was uploaded or written. Re-run with --apply.'); return; }
  for (const p of plans) console.log(`applied ${p.c.slug} -> ${await applyCharacter(p, actor)}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
