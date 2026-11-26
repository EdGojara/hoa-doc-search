// ============================================================================
// lib/characters/production.js  (Ed 2026-11-26)  Trusted Character System
// ----------------------------------------------------------------------------
// The Character Canon decides who appears and how she sounds. This module
// resolves, from the registry ONLY, each teammate's current approved
// production identity:
//
//   face      the face version in the CURRENT RELEASE, which must be approved
//   primary   the one active HeyGen look (channel 'video') built from that face
//   variants  other approved looks of the same face (channel 'video_variant'),
//             usable only when a render names them explicitly
//   voice     the approved voice version in the current release, and its
//             ElevenLabs voice (the canonical provider); absent = no voice
//   persona   the approved personality version in the current release
//
// "Standard: one character, one identity, one voice, one personality, multiple
// approved appearance variations." Nothing here falls back: no env avatar, no
// stock voice, no other teammate's voice, no older look. A missing piece is
// reported by name so the production that needs it can stop and say why.
//
// Generic by construction: no character is named in this module.
// ============================================================================
const { sameFaceVersions } = require('./identity_drift');

const APPROVED = ['approved', 'restored'];
const PRIMARY_CHANNEL = 'video';
const VARIANT_CHANNEL = 'video_variant';

class IdentityError extends Error {
  constructor(message, needs) { super(message); this.name = 'IdentityError'; this.code = 'IDENTITY_NOT_APPROVED'; this.needs = needs || []; }
}

// One character's production identity from getCharacterDetail().
function resolveDetail(detail) {
  const c = detail.character || {};
  const out = {
    character_id: c.character_id, character_slug: c.character_slug, display_name: c.display_name,
    persona: c.roster_persona || null, release_no: null,
    face: null, persona_version: null, body_version: null, wardrobe_version: null,
    primary_look: null, variant_looks: [], voice: null, problems: [],
  };
  const current = (detail.releases || []).find((r) => r.id === c.current_release_id);
  if (!current) { out.problems.push('no current approved release in the Character Canon'); return out; }
  out.release_no = current.release_no;
  const byId = new Map((detail.versions || []).map((v) => [v.id, v]));
  const comp = (k) => (current.components && current.components[k]) ? byId.get(current.components[k]) : null;
  const approved = (v) => !!v && APPROVED.includes(v.status);

  const face = comp('face');
  if (!face) { out.problems.push('the current release has no face'); return out; }
  if (!approved(face)) { out.problems.push(`face v${face.version_no} is ${face.status}, not approved`); return out; }
  out.face = { version_no: face.version_no, version_id: face.id };
  for (const k of ['persona', 'body', 'wardrobe']) {
    const v = comp(k);
    if (v && approved(v)) out[`${k === 'persona' ? 'persona' : k}_version`] = v.version_no;
  }

  // Looks built from this face (or a record of the same face).
  const faces = (detail.versions || []).filter((v) => v.component === 'face');
  const same = sameFaceVersions(face, faces.filter((v) => v.version_no < face.version_no));
  const sameIds = new Set(faces.filter((v) => same.has(v.version_no)).map((v) => v.id));
  const looks = (detail.mappings || []).filter((m) => m.status === 'active' && m.provider === 'heygen' && m.kind === 'look'
    && (m.sources || []).some((s) => sameIds.has(s.component_version_id)));
  const primary = looks.filter((m) => m.channel === PRIMARY_CHANNEL);
  if (primary.length === 1) out.primary_look = primary[0].external_id;
  else if (!primary.length) out.problems.push(`no production HeyGen look is mapped to face v${face.version_no}`);
  else out.problems.push(`${primary.length} production HeyGen looks are mapped to face v${face.version_no}; exactly one is allowed`);
  out.variant_looks = looks.filter((m) => m.channel === VARIANT_CHANNEL).map((m) => m.external_id);

  const voice = comp('voice');
  if (!voice) out.problems.push('no approved voice in the current release');
  else if (!approved(voice)) out.problems.push(`voice v${voice.version_no} is ${voice.status}, not approved`);
  else {
    const vm = (detail.mappings || []).filter((m) => m.status === 'active' && m.kind === 'voice'
      && (m.sources || []).some((s) => s.component_version_id === voice.id));
    const el = vm.filter((m) => m.provider === 'elevenlabs');
    const uniq = [...new Set(el.map((m) => m.external_id))];
    if (uniq.length === 1) out.voice = { version_no: voice.version_no, elevenlabs_voice_id: uniq[0] };
    else out.problems.push(uniq.length ? `voice v${voice.version_no} maps to ${uniq.length} different ElevenLabs voices` : `voice v${voice.version_no} has no ElevenLabs voice mapped`);
  }
  return out;
}

// ---- cache -------------------------------------------------------------------
let _state = { loaded_at: null, byPersona: null, error: null };
const MAX_AGE_MS = 5 * 60 * 1000;
let _registry = null;
let _loading = null;

async function load(registry) {
  _registry = registry || _registry;
  try {
    const chars = await registry.listCharacters();
    const byPersona = Object.create(null);
    for (const ch of chars) {
      if (!ch.roster_persona || ch.status === 'retired') continue;
      const d = await registry.getCharacterDetail(ch.character_id);
      d.character = d.character || ch;
      byPersona[ch.roster_persona] = resolveDetail(d);
    }
    _state = { loaded_at: Date.now(), byPersona, error: null };
  } catch (e) {
    _state = { loaded_at: _state.loaded_at, byPersona: _state.byPersona, error: e.message };
    throw e;
  }
  return _state;
}

function state() { return _state; }
function setState(byPersona) { _state = { loaded_at: Date.now(), byPersona, error: null }; } // tests and boot wiring
// Synchronous read for the roster. A stale cache starts a background reload
// (no timer: the repo allows recurring timers only in the scheduler).
function identityFor(persona) {
  if (_registry && !_loading && _state.loaded_at && Date.now() - _state.loaded_at > MAX_AGE_MS) {
    _loading = load(_registry).catch((e) => console.warn('[characters] production refresh failed:', e.message)).finally(() => { _loading = null; });
  }
  return _state.byPersona ? (_state.byPersona[persona] || null) : undefined;
}

async function fresh(registry) {
  if (!_state.byPersona || !_state.loaded_at || Date.now() - _state.loaded_at > MAX_AGE_MS) await load(registry);
  return _state;
}

/**
 * Everything a render needs, or an IdentityError naming what is missing.
 * opts.lookId picks an approved variant look of the SAME teammate explicitly.
 * opts.requireVoice (default true) refuses a render without an approved voice.
 */
async function resolveForRender(registry, persona, opts = {}) {
  await fresh(registry);
  const id = identityFor(persona);
  if (!id) throw new IdentityError(`${persona} is not in the Character Canon`, ['register the teammate in the Character Canon']);
  const name = id.display_name || persona;
  const needs = [];
  if (!id.face) needs.push(...id.problems);
  let look = id.primary_look;
  if (opts.lookId) {
    if (opts.lookId === id.primary_look || id.variant_looks.includes(opts.lookId)) look = opts.lookId;
    else needs.push(`look ${String(opts.lookId).slice(0, 8)} is not an approved look of ${name}'s current face`);
  }
  if (!look && id.face) needs.push(...id.problems.filter((p) => /look/.test(p)));
  if (opts.requireVoice !== false && !id.voice) needs.push(...id.problems.filter((p) => /voice/.test(p)));
  if (needs.length) {
    throw new IdentityError(`Production stopped for ${name}: ${[...new Set(needs)].join('; ')}. Fix it in the Character Canon (/admin/characters).`, [...new Set(needs)]);
  }
  return { persona, name, avatar_id: look, voice: id.voice, face_version: id.face.version_no, release_no: id.release_no, persona_version: id.persona_version };
}

module.exports = { resolveDetail, load, fresh, state, setState, identityFor, resolveForRender, IdentityError, PRIMARY_CHANNEL, VARIANT_CHANNEL };
