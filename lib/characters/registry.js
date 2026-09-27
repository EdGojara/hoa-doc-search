// ============================================================================
// lib/characters/registry.js  (Ed 2026-09-26)  Trusted Character System
// ----------------------------------------------------------------------------
// The canonical character registry (migration 467). Reads go straight to the
// tables; every write goes through a database function, which is the only path
// the tables accept. Nothing in the runtime (roster, renderers, phone) reads
// this yet: Phase A is additive.
//
// Generic by construction: no character is named anywhere in this module.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { validateSpec, SCHEMA_VERSION } = require('./spec');
const { sha256Hex, specSha256 } = require('./hash');
const { releaseSignature, statusFromEvents } = require('./release');

const BUCKET = 'character-canon';
let _client = null;
function db() {
  if (!_client) _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return _client;
}

// Never destructure data without error: a broken query must not read as "no rows".
async function must(q, what) {
  const { data, error } = await q;
  if (error) throw new Error(`[characters] ${what} failed: ${error.message}`);
  return data;
}
async function rpc(fn, args) {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(`[characters] ${fn} failed: ${error.message}`);
  return data;
}

// ---- Reads -----------------------------------------------------------------
async function listCharacters() {
  return must(db().from('characters').select('*').order('display_name').limit(500), 'list characters');
}

async function findCharacter(ref) {
  const col = /^[0-9a-f-]{36}$/i.test(String(ref)) ? 'character_id' : 'character_slug';
  return must(db().from('characters').select('*').eq(col, ref).maybeSingle(), 'find character');
}

// Everything about one character, with statuses derived from the event log.
async function getCharacterDetail(characterId) {
  const character = await must(db().from('characters').select('*').eq('character_id', characterId).maybeSingle(), 'character');
  if (!character) return null;
  const [versions, releases, events, mappings, references] = await Promise.all([
    must(db().from('component_versions').select('*').eq('character_id', characterId).order('component').order('version_no').limit(1000), 'component versions'),
    must(db().from('character_releases').select('*').eq('character_id', characterId).order('release_no').limit(1000), 'releases'),
    must(db().from('character_events').select('*').eq('character_id', characterId).order('id').limit(5000), 'events'),
    must(db().from('provider_mappings').select('*').eq('character_id', characterId).order('created_at').limit(1000), 'provider mappings'),
    must(db().from('character_reference_assets').select('*').eq('character_id', characterId).order('created_at').limit(1000), 'reference assets'),
  ]);
  const versionIds = versions.map((v) => v.id);
  const releaseIds = releases.map((r) => r.id);
  const mappingIds = mappings.map((m) => m.id);
  const [componentAssets, releaseComponents, mappingSources] = await Promise.all([
    versionIds.length ? must(db().from('component_assets').select('*').in('component_version_id', versionIds).limit(5000), 'component assets') : [],
    releaseIds.length ? must(db().from('release_components').select('*').in('release_id', releaseIds).limit(5000), 'release components') : [],
    mappingIds.length ? must(db().from('provider_mapping_sources').select('*').in('mapping_id', mappingIds).limit(5000), 'mapping sources') : [],
  ]);
  const shas = [...new Set([...componentAssets.map((a) => a.sha256), ...mappingSources.map((s) => s.asset_sha256).filter(Boolean),
    ...references.map((r) => r.sha256)])];
  const assets = shas.length ? await must(db().from('character_assets').select('*').in('sha256', shas).limit(5000), 'assets') : [];

  const byVersion = new Map(versions.map((v) => [v.id, v]));
  return {
    character,
    versions: versions.map((v) => ({ ...v, status: statusFromEvents(events, v.id), assets: componentAssets.filter((a) => a.component_version_id === v.id) })),
    releases: releases.map((r) => {
      const comps = releaseComponents.filter((c) => c.release_id === r.id);
      return {
        ...r,
        status: statusFromEvents(events, r.id),
        is_current: character.current_release_id === r.id,
        components: Object.fromEntries(comps.map((c) => [c.component, c.component_version_id])),
        signature_ok: releaseSignature(comps.map((c) => ({ component: c.component, component_version_id: c.component_version_id,
          spec_sha256: (byVersion.get(c.component_version_id) || {}).spec_sha256 }))) === r.release_sha256,
      };
    }),
    mappings: mappings.map((m) => ({ ...m, status: m.retired_at ? 'retired' : 'active', sources: mappingSources.filter((s) => s.mapping_id === m.id) })),
    references, // design direction only; never part of a release
    assets,
    events,
  };
}

// Recompute a stored spec's hash outside the database.
function verifySpecHash(version) {
  return specSha256(version.spec) === version.spec_sha256;
}

// Download the stored bytes and prove they are exactly the registered asset.
async function verifyAsset(asset) {
  const { data, error } = await db().storage.from(asset.storage_bucket || BUCKET).download(asset.storage_key);
  if (error) return { sha256: asset.sha256, ok: false, error: error.message };
  const buf = Buffer.from(await data.arrayBuffer());
  const actual = sha256Hex(buf);
  return { sha256: asset.sha256, ok: actual === asset.sha256 && buf.length === Number(asset.bytes), actual, bytes: buf.length };
}

async function signedAssetUrl(asset, seconds = 300) {
  const { data, error } = await db().storage.from(asset.storage_bucket || BUCKET).createSignedUrl(asset.storage_key, seconds);
  if (error) throw new Error(`[characters] signed url failed: ${error.message}`);
  return data.signedUrl;
}

// What production actually uses today vs what the registry maps for the current
// release. Read-only. Surfaces drift loudly instead of hiding it.
// runtime: { avatar_id, video_voice_id, tts_voice_id, phone_voice_id } (as resolved by the caller)
function runtimeDivergence(detail, runtime) {
  const current = detail.releases.find((r) => r.is_current);
  const activeFor = (componentVersionId) => detail.mappings.filter((m) => m.status === 'active'
    && m.sources.some((s) => s.component_version_id === componentVersionId));
  const rows = [];
  const check = (label, component, providerKinds, runtimeId, channel) => {
    if (!runtimeId) { rows.push({ label, runtime_id: null, state: 'not_configured' }); return; }
    const all = detail.mappings.filter((m) => providerKinds.includes(`${m.provider}:${m.kind}`) && m.external_id === runtimeId
      && (!channel || !m.channel || m.channel === channel));
    const cvId = current && current.components[component];
    const inCurrent = cvId ? activeFor(cvId).some((m) => all.includes(m)) : false;
    const owners = all.flatMap((m) => m.sources.map((s) => detail.versions.find((v) => v.id === s.component_version_id))).filter(Boolean);
    rows.push({
      label, runtime_id: runtimeId,
      state: inCurrent ? 'matches_current' : all.length ? 'maps_to_other_version' : 'unmapped',
      mapped_versions: [...new Set(owners.map((v) => `${v.component} v${v.version_no}`))],
    });
  };
  check('HeyGen avatar (video)', 'face', ['heygen:look', 'heygen:avatar_group'], runtime.avatar_id);
  check('HeyGen voice (video)', 'voice', ['heygen:voice'], runtime.video_voice_id, 'video');
  check('ElevenLabs voice (portal TTS)', 'voice', ['elevenlabs:voice'], runtime.tts_voice_id, 'portal_tts');
  if (runtime.phone_voice_id !== undefined) check('ElevenLabs voice (phone)', 'voice', ['elevenlabs:voice'], runtime.phone_voice_id, 'phone');
  return { current_release_no: current ? current.release_no : null, rows };
}

// ---- Writes (database functions only) ---------------------------------------
const createCharacter = ({ slug, displayName, rosterPersona, actor, reason }) =>
  rpc('character_create', { p_slug: slug, p_display_name: displayName, p_roster_persona: rosterPersona || null, p_actor: actor, p_reason: reason });

const renameCharacter = ({ characterId, slug, displayName, rosterPersona, actor, reason }) =>
  rpc('character_rename', { p_character: characterId, p_slug: slug, p_display_name: displayName, p_roster_persona: rosterPersona || null, p_actor: actor, p_reason: reason });

async function createComponentVersion({ characterId, component, spec, parentVersionId, changeReason, actor, assets }) {
  const v = validateSpec(component, spec);
  if (!v.ok) throw new Error(`[characters] invalid ${component} spec: ${v.errors.join('; ')}`);
  return rpc('character_create_component_version', {
    p_character: characterId, p_component: component, p_spec: spec, p_schema_version: SCHEMA_VERSION,
    p_parent_version: parentVersionId || null, p_change_reason: changeReason, p_actor: actor, p_assets: assets || [],
  });
}

const setComponentStatus = ({ versionId, event, actor, reason }) =>
  rpc('character_set_component_status', { p_version: versionId, p_event: event, p_actor: actor, p_reason: reason });
const createRelease = ({ characterId, components, notes, actor, parentReleaseId }) =>
  rpc('character_create_release', { p_character: characterId, p_components: components, p_notes: notes, p_actor: actor, p_parent_release: parentReleaseId || null });
const deriveRelease = ({ baseReleaseId, overrides, notes, actor }) =>
  rpc('character_derive_release', { p_base_release: baseReleaseId, p_overrides: overrides, p_notes: notes, p_actor: actor });
const promoteRelease = ({ releaseId, actor, reason }) =>
  rpc('character_promote_release', { p_release: releaseId, p_actor: actor, p_reason: reason });
const approvePackage = ({ characterId, currentReleaseId, legacyReleaseIds, actor, reason }) =>
  rpc('character_approve_package', { p_character: characterId, p_current_release: currentReleaseId, p_legacy_releases: legacyReleaseIds || [], p_actor: actor, p_reason: reason });
const createProviderMapping = ({ characterId, provider, kind, externalId, licenseClass, channel, notes, actor, sources }) =>
  rpc('character_create_provider_mapping', { p_character: characterId, p_provider: provider, p_kind: kind, p_external_id: externalId,
    p_license_class: licenseClass, p_channel: channel || null, p_notes: notes || null, p_actor: actor, p_sources: sources });
const retireProviderMapping = ({ mappingId, actor, reason }) =>
  rpc('character_retire_provider_mapping', { p_mapping: mappingId, p_actor: actor, p_reason: reason });
const recordRender = (payload, actor) => rpc('character_record_render', { p: payload, p_actor: actor });
const addReferenceAsset = ({ characterId, sha256, category, label, notes, actor }) =>
  rpc('character_add_reference_asset', { p_character: characterId, p_sha256: sha256, p_category: category, p_label: label, p_notes: notes || null, p_actor: actor });

module.exports = {
  BUCKET, db,
  listCharacters, findCharacter, getCharacterDetail, verifySpecHash, verifyAsset, signedAssetUrl, runtimeDivergence,
  createCharacter, renameCharacter, createComponentVersion, setComponentStatus, createRelease, deriveRelease,
  promoteRelease, approvePackage, createProviderMapping, retireProviderMapping, recordRender, addReferenceAsset,
};
