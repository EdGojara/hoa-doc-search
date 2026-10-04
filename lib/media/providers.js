// ============================================================================
// lib/media/providers.js  (Issue #10 Media Studio) — renderer catalog on the ONE contract
// ----------------------------------------------------------------------------
// Each entry is a defineAdapter() renderer: credential NAMES (values never logged),
// DOCUMENTED capabilities + quality classes (documentation is not proof of access;
// quality classes are research judgements to be replaced by our own Phase 0
// evidence), pricing CHANNELS with source + date, a read-only probe (model-list /
// account endpoints only), a pure compile() that keeps provider-specific request
// fields inside the adapter, and live submit/poll/fetch that refuse until our
// account is probed and the owner has confirmed spend.
// ============================================================================
const { defineAdapter, notEnabled } = require('./adapter');
const { effectiveCost } = require('./cost');

const DOC_DATE = '2026-10-04';

// ---- read-only probes (list / account endpoints only; never generation)
async function geminiProbe(env, fetch, re) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY; if (!key) return null;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`);
  if (!r.ok) return { reachable: false, http: r.status };
  const j = await r.json(); const names = (j.models || []).map((m) => m.name).filter((n) => re.test(n));
  return { reachable: names.length > 0, models: names, note: names.length ? 'listed for this key' : 'key works but the model is not listed for this account' };
}
async function runwayProbe(env, fetch) {
  if (!env.RUNWAYML_API_SECRET) return null;
  const r = await fetch('https://api.dev.runwayml.com/v1/organization', { headers: { Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`, 'X-Runway-Version': '2024-11-06' } });
  if (!r.ok) return { reachable: false, http: r.status };
  const j = await r.json();
  return { reachable: true, credit_balance: j.creditBalance ?? null, note: 'organization endpoint reachable' };
}

// ---- the provider-neutral ShotSpec -> one prompt text (adapters add their own fields around it)
function promptText(spec) {
  const c = spec.camera || {}; const l = spec.look || {};
  return [spec.action, l.location && `Location: ${l.location}.`, l.prop && `Prop: ${l.prop}.`,
    `Camera: ${[c.operator, c.lens_mm && `${c.lens_mm}mm`, c.framing, c.move, c.support].filter(Boolean).join(', ')}.`,
    spec.audio && spec.audio.dialogue ? `Dialogue: "${spec.audio.dialogue}"` : 'No dialogue; natural ambient sound only.',
    'Photoreal, natural light, true-to-reference identity; do not alter the character\'s face, age or build.'].filter(Boolean).join(' ');
}
// ambient-only shots: ambient is added in post, so native audio is billed only for dialogue or an explicit request
const shotForCost = (spec, ctx) => ({ resolution: ctx.resolution, duration_seconds: spec.duration_seconds, needs_audio: !!(spec.audio && (spec.audio.dialogue || spec.audio.native === true)),
  reference_images: (spec.references || []).length, expected_attempts: ctx.expected_attempts });
const withAccount = (channels, ctx) => channels.map((ch) => ({ ...ch, ...((ctx.channels || {})[ch.channel] || {}) }));

function renderer({ id, family, label, credentials, all_required = false, model, sources, caps, channels, compileFields, probe }) {
  return defineAdapter({
    id, family, label, credentials, all_required, model, sources,
    capabilities: () => ({ ...caps, documented_as_of: DOC_DATE }),
    channels,
    quote: (spec, ctx = {}) => effectiveCost(withAccount(channels, ctx), shotForCost(spec, ctx)),
    probe: probe || (async () => null),
    compile: (spec, refs = []) => ({ provider: id, model, compiled_prompt: promptText(spec), request: compileFields(spec, refs) }),
    submit: notEnabled(id), poll: notEnabled(id), fetch: notEnabled(id),
  });
}

const refList = (refs) => refs.map((r) => ({ sha256: r.sha256, role: r.use, url: r.url || null }));

const CATALOG = [
  renderer({ id: 'veo_3_1', family: 'google', label: 'Google Veo 3.1 (Gemini API / Vertex AI)', model: 'veo-3.1-generate-preview',
    credentials: [['GEMINI_API_KEY', 'GOOGLE_API_KEY'], ['GOOGLE_VERTEX_PROJECT']], sources: ['https://ai.google.dev/gemini-api/docs/video'],
    caps: { max_seconds: 8, extend_to_seconds: 60, resolutions: ['720p', '1080p', '4k'], native_audio: true, max_reference_images: 3, face_reference: { state: 'unverified', note: 'person policy allows adults; a likeness filter reportedly rejects human-like faces (no opt-out); AI-generated Amanda untested' }, first_last_frame: true, modes: ['generate', 'extend'], provenance: 'SynthID', quality: { identity: 'hero', motion: 'hero' } },
    channels: [{ channel: 'direct:gemini_api', rate_per_s: { '720p': 0.40, '1080p': 0.40, '4k': 0.60 }, source: 'https://ai.google.dev/gemini-api/docs/video', as_of: DOC_DATE },
               { channel: 'aggregator:runway', rate_per_s: { '720p': 0.20, '1080p': 0.20 }, audio_premium_per_s_flat: 0.20, source: 'https://docs.dev.runwayml.com/guides/pricing/', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ prompt: promptText(s), config: { durationSeconds: s.duration_seconds, aspectRatio: s.aspect || '16:9', generateAudio: true }, referenceImages: refList(refs) }),
    probe: (env, f) => geminiProbe(env, f, /veo-3\.1/) }),
  renderer({ id: 'veo_3_1_lite', family: 'google', label: 'Google Veo 3.1 Lite (Gemini API)', model: 'veo-3.1-lite-generate-preview',
    credentials: [['GEMINI_API_KEY', 'GOOGLE_API_KEY']], sources: ['https://ai.google.dev/gemini-api/docs/pricing'],
    caps: { max_seconds: 8, resolutions: ['720p', '1080p'], native_audio: true, max_reference_images: 3, face_reference: { state: 'unverified', note: 'same Google likeness filter as Veo 3.1; untested' }, first_last_frame: true, modes: ['generate'], provenance: 'SynthID', quality: { identity: 'draft', motion: 'standard' } },
    channels: [{ channel: 'direct:gemini_api', rate_per_s: { '720p': 0.05, '1080p': 0.08 }, source: 'https://ai.google.dev/gemini-api/docs/pricing', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ prompt: promptText(s), config: { durationSeconds: s.duration_seconds, aspectRatio: s.aspect || '16:9' }, referenceImages: refList(refs) }),
    probe: (env, f) => geminiProbe(env, f, /veo-3\.1-lite/) }),
  renderer({ id: 'veo_3_1_fast', family: 'google', label: 'Google Veo 3.1 Fast (Gemini API or Runway)', model: 'veo-3.1-fast-generate-preview',
    credentials: [['GEMINI_API_KEY', 'GOOGLE_API_KEY'], ['RUNWAYML_API_SECRET']], sources: ['https://ai.google.dev/gemini-api/docs/pricing', 'https://docs.dev.runwayml.com/guides/pricing/'],
    caps: { max_seconds: 8, resolutions: ['720p', '1080p'], native_audio: true, max_reference_images: 3, face_reference: { state: 'unverified', note: 'same Google likeness filter as Veo 3.1; untested' }, first_last_frame: true, modes: ['generate'], provenance: 'SynthID', quality: { identity: 'standard', motion: 'standard' } },
    channels: [{ channel: 'direct:gemini_api', rate_per_s: { '720p': 0.10, '1080p': 0.12 }, source: 'https://ai.google.dev/gemini-api/docs/pricing', as_of: DOC_DATE },
               { channel: 'aggregator:runway', rate_per_s: { '720p': 0.10, '1080p': 0.10 }, source: 'https://docs.dev.runwayml.com/guides/pricing/', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ prompt: promptText(s), config: { durationSeconds: s.duration_seconds, aspectRatio: s.aspect || '16:9' }, referenceImages: refList(refs) }),
    probe: (env, f) => geminiProbe(env, f, /veo-3\.1-fast/) }),
  renderer({ id: 'minimax_h3', family: 'minimax', label: 'MiniMax Hailuo H3 (via Runway)', model: 'hailuo_h3',
    credentials: [['RUNWAYML_API_SECRET']], sources: ['https://docs.dev.runwayml.com/guides/pricing/'],
    caps: { max_seconds: 15, resolutions: ['768p', '1080p'], native_audio: true, max_reference_images: 4, face_reference: { state: 'unverified', note: 'not documented; dark-horse acceptance check only' }, first_last_frame: false, modes: ['generate'], provenance: 'none published', quality: { identity: 'standard', motion: 'hero' } },
    channels: [{ channel: 'aggregator:runway', rate_per_s: { '768p': 0.105, '1080p': 0.15 }, reference_surcharge_per_image: 0.02, source: 'https://docs.dev.runwayml.com/guides/pricing/ (about $0.10-0.15/s, +2 credits per reference image)', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ model: 'hailuo_h3', promptText: promptText(s), duration: s.duration_seconds, referenceImages: refList(refs) }),
    probe: (env, f) => runwayProbe(env, f) }),
  renderer({ id: 'omni_flash_1_1', family: 'google', label: 'Google Gemini Omni Flash 1.1', model: 'gemini-omni-1.1-flash',
    credentials: [['GEMINI_API_KEY', 'GOOGLE_API_KEY']], sources: ['https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash'],
    caps: { max_seconds: 10, extend_to_seconds: 30, resolutions: ['360p', '720p', '1080p', '4k'], native_audio: true, max_reference_images: 5, face_reference: { state: 'unverified', note: 'likeness block reported on real footage; AI-generated Amanda untested' }, first_last_frame: true, modes: ['generate', 'extend', 'edit'], provenance: 'SynthID (+C2PA, second-hand)', quality: { identity: 'standard', motion: 'standard' } },
    channels: [{ channel: 'direct:gemini_api', rate_per_s: { '360p': 0.03, '720p': 0.10, '1080p': 0.15, '4k': 0.30 }, source: 'https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ prompt: promptText(s), config: { durationSeconds: Math.min(10, s.duration_seconds) }, referenceImages: refList(refs) }),
    probe: (env, f) => geminiProbe(env, f, /omni/) }),
  renderer({ id: 'seedance_2_5', family: 'bytedance', label: 'ByteDance Seedance 2.5 (Runway API or BytePlus ModelArk)', model: 'seedance2_5',
    credentials: [['RUNWAYML_API_SECRET'], ['ARK_API_KEY', 'BYTEPLUS_ARK_API_KEY']], sources: ['https://docs.dev.runwayml.com/guides/pricing/', 'https://runware.ai/docs/models/bytedance-seedance-2-5'],
    caps: { max_seconds: 30, resolutions: ['480p', '720p', '1080p'], native_audio: true, max_reference_images: 30, face_reference: { state: 'unverified', note: '2.0 refuses realistic faces; fal blocks all faces; Runway reportedly accepts; 2.5 on our account untested' }, first_last_frame: true, modes: ['generate', 'extend', 'edit'], provenance: 'none published', quality: { identity: 'hero', motion: 'hero' }, risks: ['photoreal face reference acceptance unverified'] },
    channels: [{ channel: 'aggregator:runway', rate_per_s: { '480p': 0.20, '720p': 0.68, '1080p': 0.68 }, min_charge: 0.80, source: 'https://docs.dev.runwayml.com/guides/pricing/', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ model: 'seedance2_5', promptText: promptText(s), duration: s.duration_seconds, ratio: '1920:1080', referenceImages: refList(refs) }),
    probe: (env, f) => (env.RUNWAYML_API_SECRET ? runwayProbe(env, f) : Promise.resolve(env.ARK_API_KEY || env.BYTEPLUS_ARK_API_KEY ? { reachable: null, note: 'BytePlus key present; probe endpoint not verified yet' } : null)) }),
  renderer({ id: 'kling_3', family: 'kling', label: 'Kuaishou Kling 3.0 / O3 (official API)', model: 'kling-v3', all_required: true,
    credentials: [['KLING_ACCESS_KEY'], ['KLING_SECRET_KEY']], sources: ['https://www.atlascloud.ai/blog/guides/kling-ai-api-pricing'],
    caps: { max_seconds: 15, resolutions: ['720p', '1080p'], native_audio: true, max_reference_images: 4, face_reference: { state: 'unverified', note: 'not documented' }, first_last_frame: true, modes: ['generate', 'motion_control', 'edit'], provenance: 'none published', quality: { identity: 'standard', motion: 'hero' } },
    channels: [{ channel: 'direct:kling_api', rate_per_s: { '720p': 0.08, '1080p': 0.14 }, source: 'second-hand estimate', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ model_name: 'kling-v3', prompt: promptText(s), duration: String(Math.min(15, s.duration_seconds)), image_list: refList(refs) }),
    probe: async (env) => (env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY ? { reachable: null, note: 'keys present; JWT probe to be added with the adapter' } : null) }),
  renderer({ id: 'heygen_avatar', family: 'heygen', label: 'HeyGen avatar video (existing integration)', model: 'v3/videos avatar',
    credentials: [['HEYGEN_API_KEY']], sources: ['lib/video/heygen.js'],
    caps: { max_seconds: 600, resolutions: ['1080p'], native_audio: true, max_reference_images: 0, face_reference: { state: 'not_applicable', note: 'identity comes from the consented provider avatar, not a face reference' }, first_last_frame: false, modes: ['talking_head'], provenance: 'none published', quality: { identity: 'standard', motion: 'draft' } },
    channels: [{ channel: 'direct:heygen', rate_per_s: { '1080p': 0.05 }, source: 'plan-dependent estimate (~$1-4 per generated minute); replace with the account rate', as_of: DOC_DATE }],
    compileFields: (s) => ({ type: 'avatar', script: (s.audio && s.audio.dialogue) || '', aspect_ratio: '16:9', resolution: '1080p' }) }),
  renderer({ id: 'runway_aleph_2', family: 'runway', label: 'Runway Aleph 2.0 (video-to-video repair)', model: 'aleph2',
    credentials: [['RUNWAYML_API_SECRET']], sources: ['https://docs.dev.runwayml.com/guides/pricing/'],
    caps: { max_seconds: 30, resolutions: ['720p', '1080p'], native_audio: false, max_reference_images: 1, face_reference: { state: 'not_applicable', note: 'edits an existing take; identity is carried by that take' }, first_last_frame: false, modes: ['edit'], provenance: 'none published', quality: { identity: 'standard', motion: 'standard' } },
    channels: [{ channel: 'direct:runway', rate_per_s: { '720p': 0.28, '1080p': 0.28 }, min_charge: 0.56, source: 'https://docs.dev.runwayml.com/guides/pricing/', as_of: DOC_DATE }],
    compileFields: (s, refs) => ({ model: 'aleph2', promptText: promptText(s), videoUri: null, references: refList(refs) }),
    probe: (env, f) => runwayProbe(env, f) }),
];
const ADAPTERS = Object.fromEntries(CATALOG.map((a) => [a.id, a]));

const hasCredentials = (a, env) => (a.all_required ? a.credentials.every((g) => g.some((k) => env[k])) : a.credentials.some((g) => g.some((k) => env[k])));
const missingCredentials = (a) => a.credentials.map((g) => g.join(' or '));

async function probeAll(env, fetch, list = CATALOG) {
  const out = {};
  for (const a of list) {
    if (!hasCredentials(a, env)) { out[a.id] = { reachable: false, reason: 'no credential configured', needs: missingCredentials(a) }; continue; }
    try { out[a.id] = (await a.probe(env, fetch)) || { reachable: null, reason: 'credential present; no read-only probe implemented for this adapter yet' }; }
    catch (e) { out[a.id] = { reachable: false, reason: `probe error: ${e.message}` }; }
  }
  return out;
}

module.exports = { CATALOG, ADAPTERS, DOC_DATE, probeAll, hasCredentials, missingCredentials, promptText };
