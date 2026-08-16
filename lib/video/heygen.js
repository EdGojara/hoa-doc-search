// ============================================================================
// lib/video/heygen.js  (Ed 2026-08-16)
// ----------------------------------------------------------------------------
// CLAIRE'S FACE. Thin wrapper over HeyGen for two different products that get
// confused with each other and shouldn't be:
//
//   STREAMING (interactive)  — the teledoc-style visit. A live avatar in a
//     WebRTC session that speaks whatever text we send it. Metered PER MINUTE.
//     This is the expensive one and the one with a kill switch.
//
//   VIDEO (pre-rendered)     — the 45-second ARC explainer, EN + ES. Rendered
//     once, stored, replayed forever at zero marginal cost. Anything that is
//     the same for every viewer belongs here, NOT in a live session. Rendering
//     an explainer as a live stream per viewer is how a $40 feature becomes a
//     $4,000 one.
//
// Key handling: HEYGEN_API_KEY never leaves the server. The browser gets a
// short-lived session token minted here. An API key shipped to a public page is
// an unmetered bill anyone can run up.
//
// Gated on the key being present, same pattern as lib/video/daily.js — with no
// key configured every function reports unavailable and the surfaces degrade to
// voice-and-text Claire rather than breaking.
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
  const r = await fetch(`${HEYGEN_API}${path}`, {
    ...opts,
    headers: {
      'x-api-key': process.env.HEYGEN_API_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON body */ }
  if (!r.ok) {
    throw new Error(j?.message || j?.error?.message || j?.error || `HeyGen ${r.status}: ${text.slice(0, 160)}`);
  }
  // HeyGen wraps success payloads in { data } and reports some failures with a
  // 200 plus a non-zero code. Treating that as success is how a "working"
  // integration silently returns nothing.
  if (j && j.code && j.code !== 100 && j.error) {
    throw new Error(j.error?.message || j.message || `HeyGen error code ${j.code}`);
  }
  return j.data !== undefined ? j.data : j;
}

/**
 * Mint a short-lived streaming session token for the browser.
 * The browser SDK opens the WebRTC session with this; it never sees the key.
 */
async function createStreamingToken() {
  const d = await heygenFetch('/v1/streaming.create_token', { method: 'POST', body: '{}' });
  const token = d?.token || d?.session_token || null;
  if (!token) throw new Error('HeyGen returned no streaming token');
  return token;
}

/**
 * The avatars available for PRE-RENDERED video. Deliberately separate from the
 * streaming list below: the two products have different catalogues AND
 * different plan gating, so on a video-only plan the streaming endpoint 403s
 * and the face picker would come back empty with no explanation.
 */
async function listVideoAvatars() {
  const d = await heygenFetch('/v2/avatars', { method: 'GET' });
  const list = d?.avatars || d?.data?.avatars || (Array.isArray(d) ? d : []);
  return list.map((a) => ({
    avatar_id: a.avatar_id || a.id || null,
    name: a.avatar_name || a.name || null,
    gender: a.gender || null,
    preview: a.preview_image_url || a.preview_url || null,
  })).filter((a) => a.avatar_id);
}

/** The voices available for pre-rendered video, so a face can be paired. */
async function listVoices() {
  const d = await heygenFetch('/v2/voices', { method: 'GET' });
  const list = d?.voices || (Array.isArray(d) ? d : []);
  return list.map((v) => ({
    voice_id: v.voice_id || v.id || null,
    name: v.name || null,
    language: v.language || null,
    gender: v.gender || null,
  })).filter((v) => v.voice_id);
}

/** The avatars available for LIVE streaming — a different catalogue and tier. */
async function listStreamingAvatars() {
  const d = await heygenFetch('/v1/streaming/avatar.list', { method: 'GET' });
  const list = Array.isArray(d) ? d : (d?.avatars || d?.data || []);
  return list.map((a) => ({
    avatar_id: a.avatar_id || a.id || a.pose_id || null,
    name: a.name || a.avatar_name || null,
    gender: a.gender || null,
    preview: a.normal_preview || a.preview_image_url || a.preview || null,
  })).filter((a) => a.avatar_id);
}

/**
 * Kick off a PRE-RENDERED explainer. Returns the provider video id; rendering
 * is asynchronous, so the caller polls videoStatus(). Used for the library of
 * short explainers (ARC, assessments, violations) in EN and ES — the pieces
 * that are identical for every viewer and must never run as a live session.
 */
async function renderExplainer({ script, language = 'en', persona, avatarId, voiceId, background = '#0B1D34' }) {
  const who = persona || (language === 'es' ? 'isabella' : 'claire');
  const avatar_id = avatarId || avatarIdFor(who);
  const voice_id = voiceId || voiceIdFor(who);
  const face = roster.get(who);
  if (!avatar_id) throw new Error(`No avatar configured for ${face ? face.name : who} (set ${face && face.face ? face.face + '_AVATAR_ID' : 'their avatar id'})`);
  if (!voice_id) throw new Error(`No voice configured for ${face ? face.name : who} (set ${face && face.face ? face.face + '_VOICE_ID' : 'their voice id'})`);
  if (!script || !script.trim()) throw new Error('script_required');

  const body = {
    video_inputs: [{
      character: { type: 'avatar', avatar_id, avatar_style: 'normal' },
      voice: { type: 'text', input_text: script.trim(), voice_id },
      background: { type: 'color', value: background },
    }],
    dimension: { width: 1280, height: 720 },
  };
  const d = await heygenFetch('/v2/video/generate', { method: 'POST', body: JSON.stringify(body) });
  const videoId = d?.video_id || d?.id || null;
  if (!videoId) throw new Error('HeyGen returned no video id');
  return videoId;
}

/** Poll a render. Returns { status, video_url, duration, error }. */
async function videoStatus(videoId) {
  const d = await heygenFetch(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, { method: 'GET' });
  return {
    status: d?.status || 'unknown',              // pending | processing | completed | failed
    video_url: d?.video_url || null,
    duration: d?.duration != null ? Math.round(Number(d.duration)) : null,
    error: d?.error ? (d.error.message || String(d.error)) : null,
  };
}

/**
 * What this API key can actually DO. HeyGen sells pre-rendered video and live
 * streaming avatars as different products with different plan gating, and the
 * pricing pages don't make that legible. Rather than reading marketing copy to
 * find out, ask the API: probe both endpoints and report which answered.
 * Never throws — an unavailable product is an answer, not an error.
 */
async function capabilities() {
  const out = { configured: heygenEnabled(), video: false, streaming: false, errors: {} };
  if (!out.configured) return out;
  await Promise.all([
    listVideoAvatars().then((a) => { out.video = true; out.video_avatar_count = a.length; })
      .catch((e) => { out.errors.video = e.message.slice(0, 160); }),
    listStreamingAvatars().then((a) => { out.streaming = true; out.streaming_avatar_count = a.length; })
      .catch((e) => { out.errors.streaming = e.message.slice(0, 160); }),
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
