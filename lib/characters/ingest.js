// ============================================================================
// lib/characters/ingest.js  (Ed 2026-09-26)  Trusted Character System
// ----------------------------------------------------------------------------
// Content-addressed ingest into the private character-canon bucket.
//   hash the bytes -> key sha256/<aa>/<sha>.<ext> -> upload (never overwrite)
//   -> download it back and re-hash -> only then register the asset row.
// A mismatch at any step aborts before anything is registered.
// ============================================================================
const { sha256Hex, sniffMedia, storageKeyFor } = require('./hash');
const registry = require('./registry');

// Describe what would be stored, without touching storage or the database.
function planAsset(buffer, { origin, originRef, parentSha256, notes }) {
  const media = sniffMedia(buffer);
  if (!media) throw new Error('[characters] unrecognized media type (refusing to store unknown bytes)');
  const sha256 = sha256Hex(buffer);
  return {
    sha256, bytes: buffer.length, ...media,
    storage_key: storageKeyFor(sha256, media.ext),
    parent_sha256: parentSha256 || null, origin, origin_ref: originRef || null, notes: notes || null,
  };
}

async function uploadVerified(buffer, plan, { client } = {}) {
  const storage = (client || registry.db()).storage.from(registry.BUCKET);
  const { error: upErr } = await storage.upload(plan.storage_key, buffer, { contentType: plan.media_type, upsert: false });
  // Same key already present is fine ONLY if its bytes prove identical (checked below).
  if (upErr && !/exists|duplicate/i.test(upErr.message)) throw new Error(`[characters] upload failed: ${upErr.message}`);
  const { data, error } = await storage.download(plan.storage_key);
  if (error) throw new Error(`[characters] read-back failed: ${error.message}`);
  const back = Buffer.from(await data.arrayBuffer());
  const actual = sha256Hex(back);
  if (actual !== plan.sha256 || back.length !== plan.bytes) {
    throw new Error(`[characters] read-back mismatch for ${plan.storage_key}: got ${actual} (${back.length} bytes)`);
  }
  return { reused: !!upErr };
}

async function ingestAsset(buffer, meta, { actor, apply = false } = {}) {
  const plan = planAsset(buffer, meta);
  if (!apply) return { ...plan, applied: false };
  const up = await uploadVerified(buffer, plan);
  const { error } = await registry.db().rpc('character_register_asset', {
    p_sha256: plan.sha256, p_media_type: plan.media_type, p_kind: plan.kind, p_bytes: plan.bytes,
    p_width: plan.width, p_height: plan.height, p_duration_seconds: null, p_storage_key: plan.storage_key,
    p_parent_sha256: plan.parent_sha256, p_origin: plan.origin, p_origin_ref: plan.origin_ref, p_notes: plan.notes, p_actor: actor,
  });
  if (error) throw new Error(`[characters] register asset failed: ${error.message}`);
  return { ...plan, applied: true, reused_storage_object: up.reused };
}

module.exports = { planAsset, uploadVerified, ingestAsset };
