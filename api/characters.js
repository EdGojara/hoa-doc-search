// ============================================================================
// api/characters.js  (Ed 2026-09-26)  Trusted Character System, Phase A
// ----------------------------------------------------------------------------
// Owner-only review of the canonical character registry (migration 467).
// LOCK: a router-level requireOwner runs FIRST, so no route can ship ungated.
// Reads the registry; the only writes are owner decisions (approve a package,
// approve/reject/retire/restore a component version, promote a release), each
// recorded against the owner's email as an append-only event.
//
// Nothing in the runtime reads the registry yet. This page shows where the
// runtime (env vars, persona_voices) and the canon disagree; it does not fix it.
// ============================================================================
const express = require('express');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');
const registry = require('../lib/characters/registry');
const roster = require('../lib/team/roster');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

router.use(async (req, res, next) => {
  const owner = await requireOwner(req, res); // sends 403 if not the owner
  if (!owner) return;
  req.owner = owner;
  next();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorOf = (req) => req.owner.email;

// What the running app would use for this character today (read-only).
function runtimeFor(character, detail) {
  const persona = character.roster_persona;
  const phone = detail.mappings.find((m) => m.status === 'active' && m.channel === 'phone');
  return {
    avatar_id: persona ? roster.avatarIdFor(persona) : null,
    video_voice_id: persona ? roster.voiceIdFor(persona) : null,
    tts_voice_id: persona ? roster.ttsVoiceIdFor(persona) : null,
    ...(phone ? { phone_voice_id: require('../lib/voice/persona').PERSONA.tts.voice_id } : {}),
  };
}

async function signAssets(assets) {
  const out = {};
  await Promise.all(assets.map(async (a) => {
    try { out[a.sha256] = a.kind === 'image' ? await registry.signedAssetUrl(a, 300) : null; }
    catch (e) { console.warn('[characters] sign failed', a.sha256.slice(0, 12), e.message); out[a.sha256] = null; }
  }));
  return out;
}

router.get('/', async (req, res) => {
  try {
    const list = await registry.listCharacters();
    const rows = await Promise.all(list.map(async (c) => {
      const d = await registry.getCharacterDetail(c.character_id);
      const current = d.releases.find((r) => r.is_current) || null;
      const faceId = current ? current.components.face : (d.releases[d.releases.length - 1] || { components: {} }).components.face;
      const face = d.versions.find((v) => v.id === faceId);
      const canon = face && face.assets.find((a) => a.role === 'canonical');
      const asset = canon && d.assets.find((a) => a.sha256 === canon.sha256);
      return {
        character_id: c.character_id, character_slug: c.character_slug, display_name: c.display_name,
        roster_persona: c.roster_persona, status: c.status,
        current_release_no: current ? current.release_no : null,
        pending: d.versions.filter((v) => v.status === 'proposed').length + d.releases.filter((r) => r.status === 'proposed').length,
        thumb: asset ? await registry.signedAssetUrl(asset, 300).catch(() => null) : null,
      };
    }));
    res.json({ characters: rows });
  } catch (err) {
    console.error('[characters] list failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'bad_character_id' });
    const d = await registry.getCharacterDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'not_found' });
    const urls = await signAssets(d.assets);
    res.json({
      ...d,
      versions: d.versions.map((v) => ({ ...v, spec_hash_ok: registry.verifySpecHash(v) })),
      asset_urls: urls,
      divergence: registry.runtimeDivergence(d, runtimeFor(d.character, d)),
    });
  } catch (err) {
    console.error('[characters] detail failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Re-download every stored file and prove its bytes still hash to its name.
router.get('/:id/verify', async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'bad_character_id' });
    const d = await registry.getCharacterDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'not_found' });
    const assets = [];
    for (const a of d.assets) assets.push(await registry.verifyAsset(a)); // sequential: bounded, small
    res.json({
      assets,
      specs: d.versions.map((v) => ({ id: v.id, component: v.component, version_no: v.version_no, ok: registry.verifySpecHash(v) })),
      releases: d.releases.map((r) => ({ id: r.id, release_no: r.release_no, ok: r.signature_ok })),
      ok: assets.every((a) => a.ok) && d.versions.every(registry.verifySpecHash) && d.releases.every((r) => r.signature_ok),
    });
  } catch (err) {
    console.error('[characters] verify failed:', err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/:id/approve-package', async (req, res) => {
  try {
    const { current_release_id, legacy_release_ids, reason } = req.body || {};
    if (!UUID.test(req.params.id) || !UUID.test(current_release_id || '')) return res.status(400).json({ error: 'bad_ids' });
    if (!Array.isArray(legacy_release_ids || []) || !(legacy_release_ids || []).every((x) => UUID.test(x))) return res.status(400).json({ error: 'bad_legacy_ids' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    await registry.approvePackage({ characterId: req.params.id, currentReleaseId: current_release_id,
      legacyReleaseIds: legacy_release_ids || [], actor: actorOf(req), reason: String(reason).slice(0, 500) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[characters] approve-package failed:', err.message);
    res.status(409).json({ error: safeErrorMessage(err) });
  }
});

router.post('/:id/components/:vid/status', async (req, res) => {
  try {
    const { event, reason } = req.body || {};
    if (!UUID.test(req.params.vid)) return res.status(400).json({ error: 'bad_version_id' });
    if (!['approved', 'rejected', 'retired', 'restored'].includes(event)) return res.status(400).json({ error: 'bad_event' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    await registry.setComponentStatus({ versionId: req.params.vid, event, actor: actorOf(req), reason: String(reason).slice(0, 500) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[characters] component status failed:', err.message);
    res.status(409).json({ error: safeErrorMessage(err) });
  }
});

// Promote a release; promoting an earlier release IS the rollback.
router.post('/:id/releases/:rid/promote', async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!UUID.test(req.params.rid)) return res.status(400).json({ error: 'bad_release_id' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    await registry.promoteRelease({ releaseId: req.params.rid, actor: actorOf(req), reason: String(reason).slice(0, 500) });
    res.json({ ok: true });
  } catch (err) {
    console.error('[characters] promote failed:', err.message);
    res.status(409).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
