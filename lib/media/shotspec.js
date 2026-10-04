// ============================================================================
// lib/media/shotspec.js  (Issue #10 Media Studio, Phase 0) — provider-neutral ShotSpec
// ----------------------------------------------------------------------------
// A ShotSpec says WHAT the shot is (cast by exact approved component versions,
// camera intent, framing, action, look references by asset sha256, audio,
// duration) and never HOW a vendor renders it. Adapters translate it; the spec
// is frozen by a canonical sha256 so every provider gets the identical request.
// Provider IDs, model names and signed URLs are refused (same rule as the
// character registry: providers map, they never define identity).
// ============================================================================
const crypto = require('crypto');

const canonicalJson = (v) => (Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const PROVIDER_KEY = /(^|_)(avatar|look|voice|talking_photo|provider|external|model|preset|job|request)_?id$|^(heygen|elevenlabs|runway|veo|seedance|kling|gemini|omni|byteplus|vertex|fal|replicate|runware)(_|$)/i;
const SIGNED = /[?&](Signature|X-Amz-Signature|Expires|token)=/i;
const SEGMENTS = ['engagement', 'instructional', 'brand'];

function validateShotSpec(spec) {
  const errors = [];
  const walk = (v, path) => {
    if (typeof v === 'string' && SIGNED.test(v)) errors.push(`${path}: signed URLs are not allowed in a ShotSpec`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (PROVIDER_KEY.test(k)) errors.push(`${path}.${k}: provider references are not allowed in a ShotSpec`); walk(x, `${path}.${k}`); }
  };
  walk(spec, 'shot');
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['shot spec required'] };
  if (!/^[a-z0-9_]{2,40}$/.test(String(spec.shot_key || ''))) errors.push('shot_key required (a-z0-9_)');
  if (!SEGMENTS.includes(spec.segment_class)) errors.push(`segment_class is one of ${SEGMENTS.join(' / ')}`);
  if (!(Number(spec.duration_seconds) > 0)) errors.push('duration_seconds required');
  for (const [i, c] of (spec.cast || []).entries()) {
    if (!c.character_slug) errors.push(`cast[${i}].character_slug required`);
    if (!c.components || !Object.values(c.components).every((x) => /^[0-9a-f]{64}$/.test(String(x && x.spec_sha256)))) errors.push(`cast[${i}]: every component is pinned by its approved spec_sha256`);
  }
  for (const [i, r] of (spec.references || []).entries()) if (!/^[0-9a-f]{64}$/.test(String(r.sha256 || ''))) errors.push(`references[${i}].sha256 required (content-addressed asset)`);
  return { ok: errors.length === 0, errors };
}

function freezeShotSpec(spec) {
  const v = validateShotSpec(spec);
  if (!v.ok) { const e = new Error(`invalid ShotSpec: ${v.errors.join('; ')}`); e.code = 'INVALID_SHOTSPEC'; e.errors = v.errors; throw e; }
  const text = canonicalJson(spec);
  return Object.freeze({ spec: JSON.parse(text), shotspec_sha256: sha256(text) });
}

module.exports = { canonicalJson, sha256, validateShotSpec, freezeShotSpec, SEGMENTS };
