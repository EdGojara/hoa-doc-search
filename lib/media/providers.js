// ============================================================================
// lib/media/providers.js  (Issue #10 Media Studio, Phase 0) — renderer adapters
// ----------------------------------------------------------------------------
// Each adapter declares: the credentials it needs (env var NAMES only; values are
// never logged), its DOCUMENTED capabilities and list pricing with source + date
// (documentation is not proof of access), a read-only PROBE that calls a free
// list/info endpoint to record what our account can actually reach, and a QUOTE
// for a frozen ShotSpec. Nothing here generates video or spends money: submit /
// poll / fetch are added per provider only after a real probe succeeds and the
// owner has confirmed the Phase 0 spend (scripts/media_phase0.js gate).
// ============================================================================
const DOC_DATE = '2026-10-04';

const ADAPTERS = {
  veo_3_1: {
    label: 'Google Veo 3.1 (Gemini API / Vertex AI)', family: 'google',
    credentials: [['GEMINI_API_KEY', 'GOOGLE_API_KEY'], ['GOOGLE_VERTEX_PROJECT']],   // any one group satisfies
    model: 'veo-3.1-generate-preview',
    capabilities: { durations_s: [4, 6, 8], resolutions: ['720p', '1080p', '4k'], audio: true, ref_images: 3, ref_video: false, first_last_frame: true, extend: true, edit: false, provenance: 'SynthID', face_ref_policy: 'person generation policy (no blanket face-reference block reported)' },
    price_per_s: { '720p': 0.40, '1080p': 0.40, '4k': 0.60 }, price_basis: 'Gemini API list price, audio on',
    sources: ['https://ai.google.dev/gemini-api/docs/video'],
    probe: async (env, fetch) => gemini(env, fetch, /veo-3\.1/),
  },
  omni_flash_1_1: {
    label: 'Google Gemini Omni Flash 1.1 (Gemini API)', family: 'google',
    credentials: [['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
    model: 'gemini-omni-1.1-flash',
    capabilities: { durations_s: [3, 10], extend_to_s: 30, resolutions: ['360p', '720p', '1080p', '4k'], audio: true, ref_images: '1-7 (second-hand: 5-7)', ref_video: true, first_last_frame: true, extend: true, edit: 'conversational multi-turn', provenance: 'SynthID + C2PA (second-hand)', face_ref_policy: 'avatar mode withheld; person policy applies' },
    price_per_s: { '360p': 0.03, '720p': 0.10, '1080p': 0.15, '4k': 0.30 }, price_basis: 'Gemini API list price',
    sources: ['https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash'],
    probe: async (env, fetch) => gemini(env, fetch, /omni/),
  },
  seedance_2_5: {
    label: 'ByteDance Seedance 2.5 (via Runway API, or BytePlus ModelArk)', family: 'bytedance',
    credentials: [['RUNWAYML_API_SECRET'], ['ARK_API_KEY', 'BYTEPLUS_ARK_API_KEY']],
    model: 'seedance2_5',
    capabilities: { durations_s: [4, 30], resolutions: ['480p (draft)', '720p', '1080p'], audio: true, ref_images: 30, ref_video: 10, ref_audio: 10, first_last_frame: true, extend: true, edit: true, provenance: 'none published (capture ourselves)', face_ref_policy: 'RISK: Seedance 2.0 refuses realistic-face references; 2.5 unconfirmed. Phase 0 tests it.' },
    price_per_s: { '1080p': 0.68, '720p': 0.68, '480p': 0.20 }, price_basis: 'Runway API 1080p output price; $0.80 minimum per task; input-video seconds billed separately (none in Phase 0)',
    sources: ['https://docs.dev.runwayml.com/guides/pricing/', 'https://runware.ai/docs/models/bytedance-seedance-2-5'],
    probe: async (env, fetch) => (env.RUNWAYML_API_SECRET ? runway(env, fetch) : env.ARK_API_KEY || env.BYTEPLUS_ARK_API_KEY ? { reachable: null, note: 'BytePlus key present; probe endpoint not verified yet' } : null),
  },
  kling_3: {
    label: 'Kuaishou Kling 3.0 / O3 (official Kling API)', family: 'kling',
    credentials: [['KLING_ACCESS_KEY'], ['KLING_SECRET_KEY']],
    all_required: true,
    model: 'kling-v3',
    capabilities: { durations_s: [5, 15], resolutions: ['720p', '1080p', '4k (O3)'], audio: 'multilingual + lip-sync (Turbo)', ref_images: 'elements / multi-image (Omni)', ref_video: 'motion control', first_last_frame: true, extend: false, edit: 'in-video (Omni)', provenance: 'none published', face_ref_policy: 'not documented' },
    price_per_s: { '720p': 0.08, '1080p': 0.14 }, price_basis: 'second-hand (aggregator) estimate',
    sources: ['https://www.atlascloud.ai/blog/guides/kling-ai-api-pricing'],
    probe: async (env) => (env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY ? { reachable: null, note: 'keys present; JWT probe to be added with the adapter' } : null),
  },
  runway_layer: {
    label: 'Runway API (aggregator for Veo / Seedance / Omni; Aleph 2 repair)', family: 'runway',
    credentials: [['RUNWAYML_API_SECRET']],
    model: 'organization',
    capabilities: { role: 'aggregator + Aleph 2.0 video-to-video repair', models: ['veo3.1', 'seedance2', 'seedance2_5', 'gemini_omni_flash', 'gen4.5', 'aleph2'], task_cost_api: true, provenance: 'none published' },
    price_per_s: {}, price_basis: 'per model (see underlying)',
    sources: ['https://docs.dev.runwayml.com/guides/pricing/'],
    probe: async (env, fetch) => (env.RUNWAYML_API_SECRET ? runway(env, fetch) : null),
  },
};

// ---- read-only probes (list / account endpoints only; never generation)
async function gemini(env, fetch, re) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY; if (!key) return null;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`);
  if (!r.ok) return { reachable: false, http: r.status };
  const j = await r.json(); const names = (j.models || []).map((m) => m.name).filter((n) => re.test(n));
  return { reachable: names.length > 0, models: names, note: names.length ? 'listed for this key' : 'key works but the model is not listed for this account' };
}
async function runway(env, fetch) {
  const r = await fetch('https://api.dev.runwayml.com/v1/organization', { headers: { Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`, 'X-Runway-Version': '2024-11-06' } });
  if (!r.ok) return { reachable: false, http: r.status };
  const j = await r.json();
  return { reachable: true, credit_balance: j.creditBalance ?? null, note: 'organization endpoint reachable' };
}

const hasCredentials = (a, env) => (a.all_required ? a.credentials.every((g) => g.some((k) => env[k])) : a.credentials.some((g) => g.some((k) => env[k])));
const missingCredentials = (a) => a.credentials.map((g) => g.join(' or '));

async function probeAll(env, fetch) {
  const out = {};
  for (const [id, a] of Object.entries(ADAPTERS)) {
    if (!hasCredentials(a, env)) { out[id] = { reachable: false, reason: 'no credential configured', needs: missingCredentials(a) }; continue; }
    try { out[id] = (await a.probe(env, fetch)) || { reachable: false, reason: 'no credential configured', needs: missingCredentials(a) }; }
    catch (e) { out[id] = { reachable: false, reason: `probe error: ${e.message}` }; }
  }
  return out;
}

function quote(adapterId, { resolution, duration_seconds }) {
  const a = ADAPTERS[adapterId]; if (!a) throw new Error(`unknown adapter ${adapterId}`);
  const per = a.price_per_s[resolution]; if (per == null) throw new Error(`${adapterId}: no price for ${resolution}`);
  const min = adapterId === 'seedance_2_5' ? 0.80 : 0;
  return { per_second: per, seconds: duration_seconds, cost: Math.max(min, Math.round(per * duration_seconds * 100) / 100), basis: a.price_basis, source: a.sources[0], as_of: DOC_DATE };
}

module.exports = { ADAPTERS, DOC_DATE, probeAll, quote, hasCredentials, missingCredentials };
