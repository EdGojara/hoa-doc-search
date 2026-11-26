// ============================================================================
// lib/characters/identity_drift.js  (Ed 2026-11-22)  Trusted Character System
// ----------------------------------------------------------------------------
// Compares what production actually uses against each character's identity in
// the Character Canon, and reports drift. Read-only: it never changes anything.
//
// Per character (the "identity" is the current release's face when one is
// promoted, otherwise the newest face version, which is the one under review):
//   * production headshot (persona_images._canonical_index[p].canonical) must be
//     an asset of that face version; an asset of an OLDER face = legacy in use
//   * every image in the character's photo folder must be registered to it
//   * the production look (lib/characters/production.js: the one active HeyGen
//     look on channel 'video' built from the current approved face) must exist;
//     a leftover <FACE>_AVATAR_ID env value is reported as stale (renders ignore it)
//   * the video voice (persona_voices override, else <FACE>_VOICE_ID) must be a
//     registered voice and present in the provider's catalog (when given)
//   * the spoken voice (persona_tts_voices) must be registered
//   * named website portraits (persona_images._websites) must still be the
//     exact files approved (sha256)
//
// Generic by construction: no character is named in this module.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const IMG = /\.(jpe?g|png|webp)$/i;

// The face version that defines the identity right now.
function identityFace(detail) {
  const faces = detail.versions.filter((v) => v.component === 'face').sort((a, b) => a.version_no - b.version_no);
  if (!faces.length) return { face: null, older: [] };
  const cur = detail.character && detail.character.current_release_id
    ? detail.releases.find((r) => r.id === detail.character.current_release_id) : null;
  const curFaceId = cur && cur.components && cur.components.face;
  const face = (curFaceId && faces.find((v) => v.id === curFaceId)) || faces[faces.length - 1];
  return { face, older: faces.filter((v) => v.version_no < face.version_no) };
}

function assetShas(version, roles = ['canonical', 'alternate', 'derived']) {
  return new Set((version.assets || []).filter((a) => roles.includes(a.role)).map((a) => a.sha256));
}

// Face versions that share an image are the same face (a re-registration with
// more photos or a higher-resolution copy), not a replacement.
function sameFaceVersions(face, older) {
  const mine = assetShas(face, ['canonical', 'alternate', 'derived', 'provider_copy']);
  const same = new Set([face.version_no]);
  for (const v of [...older].sort((a, b) => b.version_no - a.version_no)) {
    const theirs = assetShas(v, ['canonical', 'alternate', 'derived', 'provider_copy']);
    if ([...theirs].some((h) => mine.has(h))) { same.add(v.version_no); theirs.forEach((h) => mine.add(h)); }
  }
  return same;
}

// A resized copy (name-240.jpg, name-960.jpg, name-square-480.jpg) of an
// approved file in the same folder is approved too: scripts/build_persona_images.js
// produces those sizes from the approved original, never a new face.
const SIZE_SUFFIX = /-(?:square-)?(?:\d{3,4})(\.[a-z]+)$/i;
function sizeVariantBase(name) {
  const sq = /-square(\.[a-z]+)$/i.exec(name);
  if (sq) return [name.slice(0, sq.index) + sq[1]];
  const m = SIZE_SUFFIX.exec(name);
  if (!m) return null;
  const stem = name.slice(0, m.index);
  return [stem + m[1], stem + '-square' + m[1]].filter((x) => x !== name);
}

/**
 * deps: { registry, personaImages, repoRoot, env, faceOf(persona)->'TOKEN'|null,
 *         voiceOverrides: {FACE: voice_id}, ttsOverrides: {FACE: voice_id},
 *         heygenVoiceIds?: Set, fetchImpl?: fetch, checkWebsites?: bool }
 * -> { ok, characters, findings: [{ severity, character, area, message }] }
 */
async function checkIdentityDrift(deps) {
  const { registry, personaImages, repoRoot, env = process.env, faceOf } = deps;
  const findings = [];
  const add = (severity, character, area, message) => findings.push({ severity, character, area, message });
  const idx = (personaImages && personaImages._canonical_index) || {};
  const sites = (personaImages && personaImages._websites) || {};
  const chars = await registry.listCharacters();
  for (const c of chars) {
    const d = await registry.getCharacterDetail(c.character_id);
    d.character = d.character || c;
    const p = c.roster_persona;
    const { face, older } = identityFace(d);
    if (!face) { add('error', c.character_slug, 'face', 'no face version registered'); continue; }
    const same = sameFaceVersions(face, older);
    const approved = new Set(d.versions.filter((v) => v.component === 'face' && same.has(v.version_no)).flatMap((v) => [...assetShas(v)]));
    const legacy = new Set(older.filter((v) => !same.has(v.version_no)).flatMap((v) => [...assetShas(v, ['canonical', 'alternate', 'derived', 'provider_copy'])]));

    // Production headshot.
    const entry = idx[p];
    if (!entry) add('warn', c.character_slug, 'headshot', 'no entry in persona_images._canonical_index');
    else {
      const file = path.join(repoRoot, entry.canonical);
      if (!fs.existsSync(file)) add('error', c.character_slug, 'headshot', `missing file ${entry.canonical}`);
      else {
        const h = sha(fs.readFileSync(file));
        if (!approved.has(h)) add('error', c.character_slug, 'headshot', legacy.has(h)
          ? `${entry.canonical} is a REPLACED face (face v${older.find((v) => assetShas(v, ['canonical', 'alternate', 'derived', 'provider_copy']).has(h)).version_no})`
          : `${entry.canonical} is not registered to face v${face.version_no}`);
      }
    }
    // Photo folder.
    const dir = path.join(repoRoot, 'public', 'assets', 'personas', p || '_none_');
    if (p && fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((x) => IMG.test(x));
      const shaOf = new Map(files.map((f) => [f, sha(fs.readFileSync(path.join(dir, f)))]));
      for (const f of files) {
        const h = shaOf.get(f);
        const bases = sizeVariantBase(f) || [];
        if (!approved.has(h) && bases.some((b) => shaOf.has(b) && approved.has(shaOf.get(b)))) continue;
        if (!approved.has(h)) add(legacy.has(h) ? 'error' : 'warn', c.character_slug, 'photos', `personas/${p}/${f} is ${legacy.has(h) ? 'a replaced face' : 'not registered to the current face'}`);
      }
    }
    const token = faceOf ? faceOf(p) : null;
    const maps = (d.mappings || []).filter((m) => m.status === 'active');
    const sourceFaceVersions = (m) => (m.sources || []).map((s) => d.versions.find((v) => v.id === s.component_version_id))
      .filter((v) => v && v.component === 'face').map((v) => v.version_no);

    // Production avatar: the Character Canon decides (lib/characters/production.js).
    // <FACE>_AVATAR_ID is no longer read by renders; a stale value is only reported.
    const prod = require('./production').resolveDetail(d);
    if (!prod.primary_look) prod.problems.filter((x) => /look|release|face/.test(x)).forEach((x) => add('error', c.character_slug, 'avatar', x));
    if (token && env[`${token}_AVATAR_ID`] && prod.primary_look && env[`${token}_AVATAR_ID`] !== prod.primary_look) {
      add('warn', c.character_slug, 'avatar', `${token}_AVATAR_ID is stale (ignored): the Canon's production look is ${prod.primary_look.slice(0, 8)}`);
    }
    // Video voice.
    if (token) {
      const vid = (deps.voiceOverrides || {})[token] || env[`${token}_VOICE_ID`] || null;
      if (vid) {
        if (!maps.some((x) => x.kind === 'voice' && x.external_id === vid)) add('warn', c.character_slug, 'voice', 'video voice is not a registered voice');
        if (deps.heygenVoiceIds && deps.heygenVoiceIds.size && !deps.heygenVoiceIds.has(vid)) add('error', c.character_slug, 'voice', "video voice is not in HeyGen's voice catalog");
      }
      const tts = (deps.ttsOverrides || {})[token] || null;
      if (tts && !maps.some((x) => x.provider === 'elevenlabs' && x.kind === 'voice' && x.external_id === tts)) add('warn', c.character_slug, 'voice', 'spoken voice is not a registered voice');
    }
    // Websites.
    if (deps.checkWebsites && p && Array.isArray(sites[p])) {
      const f = deps.fetchImpl || fetch;
      for (const s of sites[p]) {
        try {
          const r = await f(s.url);
          if (!r.ok) { add('warn', c.character_slug, 'website', `${s.url} -> ${r.status}`); continue; }
          const h = sha(Buffer.from(await r.arrayBuffer()));
          if (h !== s.sha256) add('error', c.character_slug, 'website', `${s.url} changed since it was approved`);
        } catch (e) { add('warn', c.character_slug, 'website', `${s.url} unreachable: ${e.message}`); }
      }
    }
  }
  return { ok: !findings.some((x) => x.severity === 'error'), characters: chars.length, findings };
}

// Render-time guard: is this avatar the approved production look, or an
// approved variant, of the character's CURRENT approved face? -> { ok, reason }.
async function avatarApproval(registry, avatarId) {
  if (!avatarId) return { ok: false, reason: 'no avatar' };
  const { data, error } = await registry.db().from('provider_mappings').select('id, character_id, kind, retired_at')
    .eq('provider', 'heygen').eq('external_id', avatarId).is('retired_at', null);
  if (error) return { ok: false, reason: `lookup failed: ${error.message}` };
  if (!data || !data.length) return { ok: false, reason: 'avatar is not an active look in the Character Canon (unregistered or legacy)' };
  const d = await registry.getCharacterDetail(data[0].character_id);
  const prod = require('./production').resolveDetail(d);
  if (prod.primary_look === avatarId || prod.variant_looks.includes(avatarId)) return { ok: true, reason: null };
  return { ok: false, reason: prod.problems[0] || 'avatar is not an approved look of the current approved face' };
}

module.exports = { checkIdentityDrift, avatarApproval, identityFace, sameFaceVersions };
