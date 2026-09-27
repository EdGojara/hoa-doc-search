#!/usr/bin/env node
// ============================================================================
// scripts/backfill_render_provenance.js  (Ed 2026-09-26)  Trusted Character System, Phase A
// ----------------------------------------------------------------------------
// Attributes EXISTING videos (claire_explainers, video_shares) to the character
// version that produced them, in render_log. Read-only against the videos
// themselves: files are downloaded only to hash them; nothing is re-rendered,
// moved or modified.
//
// Honesty rules:
//   recorded  never used here (these renders predate provenance logging)
//   inferred  avatar id recorded on the row -> mapped look -> face version;
//             voice = the HeyGen voice mapped for that character today
//   unknown   uploaded files (generator not recorded) or no avatar on the row
// Rows for characters not yet in the registry are skipped and counted.
//
//   node scripts/backfill_render_provenance.js [--apply]
// ============================================================================
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const registry = require('../lib/characters/registry');

const APPLY = process.argv.includes('--apply');
const ACTOR = 'phase_a_backfill';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function must(q, what) {
  const { data, error } = await q;
  if (error) throw new Error(`${what} failed: ${error.message}`);
  return data;
}

async function bytesOfExplainer(e) {
  if (!e.video_url) return null;
  const r = await fetch(e.video_url);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}
async function bytesOfShare(v) {
  if (!v.storage_path) return null;
  const { data, error } = await registry.db().storage.from('videos').download(v.storage_path);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

(async () => {
  const db = registry.db();
  const characters = await registry.listCharacters();
  const details = await Promise.all(characters.map((c) => registry.getCharacterDetail(c.character_id)));

  // look external id -> { detail, faceVersion, mapping }
  const byLook = new Map();
  const byPersona = new Map();
  for (const d of details) {
    if (d.character.roster_persona) byPersona.set(d.character.roster_persona, d);
    for (const m of d.mappings) {
      if (m.provider !== 'heygen' || m.kind !== 'look') continue;
      const src = m.sources[0]; const fv = src && d.versions.find((v) => v.id === src.component_version_id);
      if (fv) byLook.set(m.external_id, { d, faceVersion: fv, mapping: m, sourceSha: src.asset_sha256 });
    }
  }
  const voiceFor = (d) => {
    const m = d.mappings.find((x) => x.status === 'active' && x.provider === 'heygen' && x.kind === 'voice');
    const src = m && m.sources[0];
    return m ? { mapping: m, version: d.versions.find((v) => v.id === src.component_version_id) } : null;
  };
  // Earliest release containing this face version: the bundle in force when it rendered.
  const releaseFor = (d, faceVersionId) => d.releases.filter((r) => r.components.face === faceVersionId)
    .sort((a, b) => a.release_no - b.release_no)[0] || null;

  const existing = new Set((await must(db.from('render_log').select('source_table, source_id').limit(5000), 'render_log'))
    .map((r) => `${r.source_table}:${r.source_id}`));

  const plans = []; const skipped = [];
  const explainers = await must(db.from('claire_explainers').select('id, topic, language, script, avatar_id, provider_video_id, video_url, created_at')
    .eq('status', 'ready').order('created_at').limit(1000), 'claire_explainers');
  for (const e of explainers) {
    const hit = e.avatar_id && byLook.get(e.avatar_id);
    if (!hit) { skipped.push(`explainer ${e.topic}/${e.language}: ${e.avatar_id ? 'character not in registry yet' : 'no avatar recorded'}`); continue; }
    plans.push({ src: ['claire_explainers', e.id], label: `explainer ${e.topic}/${e.language}`, row: e, kind: 'explainer', hit });
  }
  const shares = await must(db.from('video_shares').select('id, token, persona, source, script, provider_video_id, storage_path, created_at')
    .order('created_at').limit(1000), 'video_shares');
  for (const v of shares) {
    const d = byPersona.get(String(v.persona || '').toLowerCase());
    if (!d) { skipped.push(`share ${v.token.slice(0, 8)} (${v.persona}): character not in registry yet`); continue; }
    plans.push({ src: ['video_shares', v.id], label: `share ${v.token.slice(0, 8)} (${v.source})`, row: v, kind: v.source === 'generated' ? 'generated' : 'upload', d });
  }

  let written = 0;
  for (const p of plans) {
    const key = `${p.src[0]}:${p.src[1]}`;
    if (existing.has(key)) { console.log(`= ${p.label}: already recorded`); continue; }
    let payload;
    if (p.kind === 'upload') {
      payload = { renderer: 'unknown', provenance_quality: 'unknown', notes: 'Uploaded file; the generator and settings were not recorded.',
        participants: [{ character_id: p.d.character.character_id, speaking: true, components: [] }] };
    } else {
      const d = p.hit ? p.hit.d : p.d;
      let face = p.hit;
      if (!face) { // generated share: the look production used is the one mapped for video today
        const look = d.mappings.find((m) => m.status === 'active' && m.provider === 'heygen' && m.kind === 'look' && m.channel === 'video');
        face = look && byLook.get(look.external_id);
      }
      const voice = voiceFor(d);
      const rel = face && releaseFor(d, face.faceVersion.id);
      payload = {
        renderer: 'heygen', provider_job_id: p.row.provider_video_id || null, provenance_quality: 'inferred',
        provider_asset_ids: { look: face ? face.mapping.external_id : null, voice: voice ? voice.mapping.external_id : null },
        notes: p.kind === 'explainer' ? 'Avatar id recorded on the explainer row; voice inferred from the current HeyGen voice mapping.'
          : 'Generated share; avatar and voice inferred from the current HeyGen mappings.',
        participants: [{ character_id: d.character.character_id, release_id: rel ? rel.id : null, speaking: true, components: [
          ...(face ? [{ component: 'face', component_version_id: face.faceVersion.id, provider_mapping_id: face.mapping.id,
            assets: face.sourceSha ? [{ sha256: face.sourceSha, role: 'face_source' }] : [] }] : []),
          ...(voice ? [{ component: 'voice', component_version_id: voice.version.id, provider_mapping_id: voice.mapping.id, assets: [] }] : []),
        ] }],
      };
    }
    const bytes = p.kind === 'explainer' ? await bytesOfExplainer(p.row) : await bytesOfShare(p.row);
    Object.assign(payload, {
      source_table: p.src[0], source_id: String(p.src[1]), rendered_at: p.row.created_at,
      script_sha256: p.row.script ? sha(Buffer.from(p.row.script, 'utf8')) : null,
      output_sha256: bytes ? sha(bytes) : null,
      output_bucket: p.kind === 'explainer' ? 'explainers' : 'videos',
      output_key: p.kind === 'explainer' ? null : p.row.storage_path,
    });
    const face = payload.participants[0].components.find((c) => c.component === 'face');
    console.log(`${APPLY ? '+' : '~'} ${p.label.padEnd(34)} ${payload.provenance_quality.padEnd(8)} face:${face ? face.component_version_id.slice(0, 8) : '-'} output:${payload.output_sha256 ? payload.output_sha256.slice(0, 12) : 'not hashed'}`);
    if (APPLY) { await registry.recordRender(payload, ACTOR); written++; }
  }
  console.log(`\n${plans.length} attributable, ${skipped.length} skipped:`);
  skipped.forEach((s) => console.log(`  - ${s}`));
  console.log(APPLY ? `\nwrote ${written} render_log row(s)` : '\nDRY RUN: nothing written. Re-run with --apply.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
