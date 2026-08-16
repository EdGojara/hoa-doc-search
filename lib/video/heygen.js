// ============================================================================
// lib/video/heygen.js  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// CLAIRE'S FACE. Thin wrapper over HeyGen for two different products that get
// confused with each other and shouldn't be:
//
//   VIDEO (pre-rendered)     — the 45-second ARC explainer, EN + ES. Rendered
//     once, stored, replayed forever at zero marginal cost. Anything that is
//     the same for every viewer belongs here. Rendering an explainer as a live
//     stream per viewer is how a $40 feature becomes a $4,000 one.
//     VERIFIED WORKING against a real key 2026-08-16.
//
//   STREAMING (interactive)  — the teledoc-style visit. Metered PER MINUTE.
//     NOT AVAILABLE on the standard API plan: every streaming route answers
//     with a bare HTML 404 (not a 403) on both v1 and v2, and Interactive
//     Avatar is absent from the public API lineup. It is an Enterprise
//     product. Left wired so it lights up if HeyGen enables it; until then
//     the visit page degrades to voice and text and says so.
//
// API VERSION: v3. The original build used /v1/video_status.get, which HeyGen
// marks Legacy with a hard sunset on 2026-10-31 — it would have failed silently
// in October with nobody watching. v3 also carries default_voice_id per avatar,
// which matters because a face paired with a mismatched voice is the fastest
// way an avatar reads as fake.
//
// Key handling: HEYGEN_API_KEY never leaves the server.
// ============================================================================

const HEYGEN_API = 'https://api.heygen.com';

// Faces belong to the TEAM ROSTER, not to the video vendor. This module knows
// how to drive HeyGen; lib/team/roster.js knows who Annie is and what she looks
// like. Each teammate's face is locked independently via their own env pair
// (ANNIE_AVATAR_ID / ANNIE_VOICE_ID, ...), because a presenter whose appearance
// drifts between videos reads as stock footage, which is the opposite of the
// point.
const roster = require('../team/roster');
function avatarIdFor(persona) { return roster.avatarIdFor(persona); }
function voiceIdFor(persona) { return roster.voiceIdFor(persona); }

// Back-compat shims for the original single-face wiring.
function claireAvatarId() { return roster.avatarIdFor('claire'); }
function claireVoiceId(language = 'en') { return roster.voiceIdFor(language === 'es' ? 'isabella' : 'claire'); }

function heygenEnabled() { return !!process.env.HEYGEN_API_KEY; }

// The kill switch. Streaming is the metered surface, so it gets an explicit
// off-lever that does not require a deploy or pulling the API key (which would
// also kill the free pre-rendered explainers). Default ON when a key exists.
function streamingEnabled() {
  if (!heygenEnabled()) return false;
  return String(process.env.CLAIRE_VIDEO_ENABLED || 'true').toLowerCase() !== 'false';
}

// Cost of a live avatar minute, in cents, for the session cost ledger. This is
// a plan-dependent estimate and is deliberately configurable: the number that
// matters is that SOMETHING is written to claire_sessions.est_cost_cents, so
// the monthly bill can be attributed instead of appearing as a mystery line.
function streamingCentsPerMinute() {
  const n = Number(process.env.CLAIRE_STREAM_CENTS_PER_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

async function heygenFetch(path, opts = {}) {
  if (!heygenEnabled()) throw new Error('HeyGen is not configured (HEYGEN_API_KEY unset)');
  const r = await fetch(HEYGEN_API + path, {
    ...opts,
    headers: {
      'x-api-key': process.env.HEYGEN_API_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();

  // A route that is not on this plan answers with an HTML 404 page, not JSON.
  // Separating that from a real API error matters: "this endpoint does not
  // exist for you" and "your request was wrong" need different responses from
  // the caller, and an HTML body run through JSON.parse surfaces as a
  // meaningless syntax error that hides the actual cause.
  if (text.trim().startsWith('<')) {
    const err = new Error('HeyGen route not available on this plan: ' + path);
    err.routeAbsent = true;
    throw err;
  }

  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON body */ }
  if (!r.ok) {
    throw new Error(j?.error?.message || j?.message || j?.error || ('HeyGen ' + r.status + ': ' + text.slice(0, 160)));
  }
  if (j && j.code && j.code !== 100 && j.error) {
    throw new Error(j.error?.message || j.message || ('HeyGen error code ' + j.code));
  }
  return j.data !== undefined ? j.data : j;
}

// v3 lists are cursor-paginated (has_more + next_token). Paging is not optional
// here: the stock catalogue runs to four figures and a single unpaged call
// quietly returns the first 20, which reads as "there are only 20 faces."
// Same discipline as lib/db/fetch_all.js on the database side.
async function heygenPaged(path, { cap = 2000 } = {}) {
  const out = [];
  let token = null;
  for (let i = 0; i < 100; i += 1) {
    const qs = token ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : path;
    const r = await fetch(HEYGEN_API + qs, { headers: { 'x-api-key': process.env.HEYGEN_API_KEY } });
    const text = await r.text();
    if (text.trim().startsWith('<')) {
      const e = new Error('HeyGen route not available on this plan: ' + path);
      e.routeAbsent = true;
      throw e;
    }
    const j = JSON.parse(text);
    if (!r.ok) throw new Error(j?.error?.message || ('HeyGen ' + r.status));
    out.push(...(j.data || []));
    if (!j.has_more || !j.next_token || out.length >= cap) break;
    token = j.next_token;
  }
  return out;
}

/**
 * LIVE streaming avatar token. Enterprise-gated (see header). Kept wired so the
 * surface works the day HeyGen enables it on the account.
 */
async function createStreamingToken() {
  const d = await heygenFetch('/v1/streaming.create_token', { method: 'POST', body: '{}' });
  const token = d?.token || d?.session_token || null;
  if (!token) throw new Error('HeyGen returned no streaming token');
  return token;
}

/** Streaming avatar catalogue — same plan gating as the token above. */
async function listStreamingAvatars() {
  const d = await heygenFetch('/v1/streaming/avatar.list', { method: 'GET' });
  const list = Array.isArray(d) ? d : (d?.avatars || []);
  return list.map((a) => ({
    avatar_id: a.avatar_id || a.id || a.pose_id || null,
    name: a.name || a.avatar_name || null,
    gender: a.gender || null,
    preview: a.normal_preview || a.preview_image_url || null,
  })).filter((a) => a.avatar_id);
}

/**
 * Avatars for PRE-RENDERED video. v3 carries default_voice_id, which pairs a
 * face with the voice it was built for.
 */
async function listVideoAvatars() {
  const list = await heygenPaged('/v3/avatars');
  return list.map((a) => ({
    avatar_id: a.id || a.avatar_id || null,
    name: (a.name || '').trim() || null,
    gender: a.gender || null,
    preview: a.preview_image_url || null,
    default_voice_id: a.default_voice_id || null,
    looks_count: a.looks_count || null,
  })).filter((a) => a.avatar_id);
}

/** Voices for pre-rendered video. */
async function listVoices() {
  const list = await heygenPaged('/v3/voices');
  return list.map((v) => ({
    voice_id: v.voice_id || v.id || null,
    name: (v.name || '').trim() || null,
    language: v.language || null,
    gender: v.gender || null,
    preview: v.preview_audio_url || null,
  })).filter((v) => v.voice_id);
}

/**
 * Render an explainer. POST /v3/videos, a discriminated union keyed on `type`.
 */
async function renderExplainer({ script, language = 'en', persona, avatarId, voiceId, background = '#0B1D34', title }) {
  const who = persona || (language === 'es' ? 'isabella' : 'claire');
  const avatar_id = avatarId || avatarIdFor(who);
  const voice_id = voiceId || voiceIdFor(who);
  const face = roster.get(who);
  const label = face ? face.name : who;
  if (!avatar_id) throw new Error('No avatar configured for ' + label + ' (set ' + (face && face.face ? face.face + '_AVATAR_ID' : 'their avatar id') + ')');
  if (!voice_id) throw new Error('No voice configured for ' + label + ' (set ' + (face && face.face ? face.face + '_VOICE_ID' : 'their voice id') + ')');
  if (!script || !script.trim()) throw new Error('script_required');

  const body = {
    type: 'avatar',
    avatar_id,
    script: script.trim(),
    voice_id,
    aspect_ratio: '16:9',
    resolution: '1080p',
    background: { type: 'color', value: background },
    title: title || ('Bedrock explainer (' + language + ')'),
  };
  const d = await heygenFetch('/v3/videos', { method: 'POST', body: JSON.stringify(body) });
  const videoId = d?.video_id || d?.id || null;
  if (!videoId) throw new Error('HeyGen returned no video id');
  return videoId;
}

/** Poll a render. GET /v3/videos/{id}. */
async function videoStatus(videoId) {
  const d = await heygenFetch('/v3/videos/' + encodeURIComponent(videoId), { method: 'GET' });
  const raw = String(d?.status || 'unknown').toLowerCase();
  const status = ['completed', 'success', 'done'].includes(raw) ? 'completed'
    : (['failed', 'error'].includes(raw) ? 'failed' : raw);
  return {
    status,
    video_url: d?.video_url || d?.output?.video_url || d?.url || null,
    duration: d?.duration != null ? Math.round(Number(d.duration)) : null,
    error: d?.error ? (d.error.message || String(d.error)) : null,
  };
}

/**
 * What this API key can actually DO. HeyGen sells pre-rendered video and live
 * streaming as different products with different gating, and the pricing pages
 * don't make that legible. Ask the API rather than reading marketing copy.
 * Never throws — an unavailable product is an answer, not an error.
 */
async function capabilities() {
  const out = { configured: heygenEnabled(), video: false, streaming: false, errors: {} };
  if (!out.configured) return out;
  await Promise.all([
    listVideoAvatars().then((a) => { out.video = true; out.video_avatar_count = a.length; })
      .catch((e) => { out.errors.video = e.routeAbsent ? 'not on this plan' : String(e.message).slice(0, 160); }),
    listStreamingAvatars().then((a) => { out.streaming = true; out.streaming_avatar_count = a.length; })
      .catch((e) => { out.errors.streaming = e.routeAbsent ? 'not on this plan (Interactive Avatar is an Enterprise product)' : String(e.message).slice(0, 160); }),
  ]);
  return out;
}

module.exports = {
  heygenEnabled,
  streamingEnabled,
  streamingCentsPerMinute,
  avatarIdFor,
  voiceIdFor,
  claireAvatarId,
  claireVoiceId,
  createStreamingToken,
  listStreamingAvatars,
  listVideoAvatars,
  listVoices,
  capabilities,
  renderExplainer,
  videoStatus,
};
