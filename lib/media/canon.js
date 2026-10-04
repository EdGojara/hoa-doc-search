// ============================================================================
// lib/media/canon.js  (Issue #10 Media Studio) — resolve a character's APPROVED visual canon
// ----------------------------------------------------------------------------
// One read path for "what exact component versions may a shot cast?": the latest
// approved face / body / wardrobe / guardrails versions (by spec_sha256) plus the
// approved face's canonical image sha256. Read-only; the caller passes a
// read-only client (lib/onboarding/write_gate.readOnlyClient). A character whose
// visual canon is incomplete returns { ok:false, reason } so the planner can say
// "cast not approved" instead of guessing.
// ============================================================================
const VISUAL = ['face', 'body', 'wardrobe', 'guardrails'];

async function castCanon(ro, slug) {
  const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data || []; };
  const ch = (await q(ro.from('characters').select('character_id, character_slug').eq('character_slug', slug)))[0];
  if (!ch) return { ok: false, slug, reason: `${slug} is not in the character registry` };
  const versions = await q(ro.from('component_versions').select('id, component, version_no, spec_sha256').eq('character_id', ch.character_id).order('version_no'));
  const events = await q(ro.from('character_events').select('subject_id, event').eq('character_id', ch.character_id).order('id'));
  const status = new Map(); for (const e of events) status.set(e.subject_id, e.event);
  const approved = (comp) => versions.filter((v) => v.component === comp && status.get(v.id) === 'approved').sort((a, b) => b.version_no - a.version_no)[0];
  const pins = {};
  for (const comp of VISUAL) {
    const v = approved(comp);
    if (!v) return { ok: false, slug, reason: `${slug}: no approved ${comp} version (visual canon incomplete)` };
    pins[comp] = { version: v.version_no, spec_sha256: v.spec_sha256 };
  }
  const faceV = approved('face');
  const assets = await q(ro.from('component_assets').select('component_version_id, sha256, role').eq('component_version_id', faceV.id));
  const canonical = assets.find((a) => a.role === 'canonical');
  if (!canonical) return { ok: false, slug, reason: `${slug}: approved face has no canonical image` };
  return { ok: true, slug, pins, face_sha256: canonical.sha256, voice_approved: !!approved('voice') };
}

module.exports = { castCanon, VISUAL };
