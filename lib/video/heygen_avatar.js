// ============================================================================
// lib/video/heygen_avatar.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// CREATING a photo avatar, which is a different product from lib/video/heygen.js.
// That module RENDERS video from an avatar that already exists. This one makes
// the avatar in the first place, so a new teammate can be added to the roster
// without anyone clicking through the HeyGen studio.
//
// The flow HeyGen requires, in order:
//   1. upload the still to upload.heygen.com (raw binary, NOT multipart, and
//      NOT the api.heygen.com host) -> image_key
//   2. create an avatar group from that image_key -> group_id
//   3. train the group -> async job
//   4. poll training status until 'ready'
//   5. list the group's looks -> the avatar_id you actually render with
//
// SOURCE IMAGE RULES, learned the hard way on Paige: a photo avatar inherits
// the quality of its source and cannot exceed it. Claire was built from a
// 2048x2048 original and looks it. Paige's first candidate was a 366x412 crop
// lifted out of a nine-up composite, which would have shipped a visibly softer
// face on the persona fronting business development. Square, >=1024 (2048
// preferred), face unobstructed through the mouth and jaw, even light across
// the face, and a CLOSED-mouth expression — a wide smile locks every rendered
// second into that same grin and gets unnerving over a minute of talking.
//
// COST: creating and training an avatar consumes account quota. Rendering is
// metered separately. Neither is free, so this module never creates anything
// implicitly — a caller has to ask for it by name.
//
// ⚠ SUNSET 2026-10-31. Every /v2/photo_avatar/* route here answers with a
// Legacy warning and a hard removal date of 2026-10-31:
//
//   "This v2 endpoint is Legacy and will be removed on 2026-10-31 ...
//    review the latest API documentation for replacement availability"
//   docs: https://developers.heygen.com/reference
//
// This is the identical trap heygen.js already carries in its header for
// /v1/video_status.get: a route that keeps working right up until it does not,
// with nobody watching. Creating a new teammate's face is not something anyone
// does weekly, so this will be cold code on the day it breaks. Migrate to the
// current photo-avatar routes before October, and verify by creating a throwaway
// avatar rather than by reading the docs.
//
// NOTE ON THE TWO TIERS, learned creating Paige 2026-08-18. avatar_group/create
// returns a working TALKING PHOTO immediately — the group id doubles as a
// renderable avatar id and its look reports status 'completed' straight away.
// /photo_avatar/train is a separate, slower upgrade to an HD photo avatar and
// takes 10-20 minutes.
//
// "No valid image for training found in group X" IS A LIAR, and I believed it
// twice before checking (Ed 2026-08-18). It does NOT mean the group is empty or
// the upload failed. HeyGen returns it for at least two different states:
//   1. a group whose look has not registered yet — retry a moment later, or add
//      the look explicitly via avatar_group/add, and it trains fine
//   2. a group ALREADY TRAINING — the second call is rejected while the first
//      is in flight, and the message says nothing about that
// The only reliable signal is /photo_avatar/train/status: 'pending' means it is
// running, 'ready' means it is done. Six avatars all reported that error and
// all six were training normally. Before retrying or re-uploading anything,
// read the status endpoint — a failure message here is not evidence of failure.
// ============================================================================
const fs = require('fs');
const path = require('path');

const UPLOAD_HOST = 'https://upload.heygen.com';
const API_HOST = 'https://api.heygen.com';

function enabled() { return !!process.env.HEYGEN_API_KEY; }

function mimeFor(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  throw new Error('unsupported_image_type: ' + e + ' (use png, jpg or webp)');
}

// Shared response handling. HeyGen answers a route that is not on your plan
// with an HTML 404 page rather than JSON, and running that through JSON.parse
// surfaces as a syntax error that hides the real cause. Same guard as
// heygen.js heygenFetch.
async function readJson(r, label) {
  const text = await r.text();
  if (text.trim().startsWith('<')) {
    const err = new Error('HeyGen route not available on this plan: ' + label);
    err.routeAbsent = true;
    throw err;
  }
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON */ }
  if (!r.ok) throw new Error(j?.error?.message || j?.message || j?.error || `HeyGen ${label} ${r.status}: ${text.slice(0, 200)}`);
  if (j && j.code && j.code !== 100 && j.error) throw new Error(j.error?.message || j.message || ('HeyGen error code ' + j.code));
  return j.data !== undefined ? j.data : j;
}

async function apiFetch(p, opts = {}) {
  if (!enabled()) throw new Error('HeyGen is not configured (HEYGEN_API_KEY unset)');
  const r = await fetch(API_HOST + p, {
    ...opts,
    headers: { 'x-api-key': process.env.HEYGEN_API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return readJson(r, p);
}

// ---------------------------------------------------------------------------
// 1) Upload the still. Different host, raw body, no multipart wrapper.
// ---------------------------------------------------------------------------
async function uploadImage(filePath) {
  if (!enabled()) throw new Error('HeyGen is not configured (HEYGEN_API_KEY unset)');
  if (!fs.existsSync(filePath)) throw new Error('image_not_found: ' + filePath);
  const body = fs.readFileSync(filePath);
  const r = await fetch(UPLOAD_HOST + '/v1/asset', {
    method: 'POST',
    headers: { 'x-api-key': process.env.HEYGEN_API_KEY, 'Content-Type': mimeFor(filePath) },
    body,
  });
  const d = await readJson(r, '/v1/asset');
  const key = d.image_key || d.key || (d.asset && d.asset.image_key);
  if (!key) throw new Error('upload_returned_no_image_key: ' + JSON.stringify(d).slice(0, 200));
  return { image_key: key, bytes: body.length, raw: d };
}

// ---------------------------------------------------------------------------
// 2) Create the avatar group from the uploaded still.
// ---------------------------------------------------------------------------
async function createAvatarGroup({ name, image_key }) {
  if (!name) throw new Error('name_required');
  if (!image_key) throw new Error('image_key_required');
  const d = await apiFetch('/v2/photo_avatar/avatar_group/create', {
    method: 'POST',
    body: JSON.stringify({ name, image_key }),
  });
  const group_id = d.group_id || d.id || (d.avatar_group && d.avatar_group.id);
  if (!group_id) throw new Error('create_returned_no_group_id: ' + JSON.stringify(d).slice(0, 200));
  return { group_id, raw: d };
}

// ---------------------------------------------------------------------------
// 3+4) Train, then poll. Training is asynchronous and takes minutes.
// ---------------------------------------------------------------------------
// Idempotent. Reads the status FIRST, because /train answers a group that is
// already training with "No valid image for training found" — a message that
// reads like the upload failed and sends you off re-uploading a perfectly good
// image. Status is the only trustworthy signal.
async function trainAvatarGroup(group_id) {
  try {
    const st = await trainStatus(group_id);
    const s = String(st.status || st.state || '').toLowerCase();
    if (['pending', 'processing', 'in_progress'].includes(s)) return { already: 'training', status: s };
    if (['ready', 'completed', 'success'].includes(s)) return { already: 'trained', status: s };
  } catch (_) { /* no prior job — fall through and start one */ }

  try {
    return await apiFetch('/v2/photo_avatar/train', { method: 'POST', body: JSON.stringify({ group_id }) });
  } catch (e) {
    // Lost a race, or the look has not registered yet. Re-read the status
    // rather than surfacing a message that misdescribes what happened.
    if (/no valid image/i.test(e.message || '')) {
      try {
        const st = await trainStatus(group_id);
        const s = String(st.status || st.state || '').toLowerCase();
        if (s && s !== 'failed' && s !== 'error') return { already: 'training', status: s };
      } catch (_) { /* fall through to the real error */ }
      throw Object.assign(
        new Error('train_rejected_group_not_ready: the look may not have registered yet — add it via avatar_group/add and retry'),
        { groupId: group_id },
      );
    }
    throw e;
  }
}

async function trainStatus(group_id) {
  return apiFetch('/v2/photo_avatar/train/status/' + encodeURIComponent(group_id), { method: 'GET' });
}

async function waitForTraining(group_id, { timeoutMs = 15 * 60 * 1000, intervalMs = 15000, onTick } = {}) {
  const started = Date.now();
  for (;;) {
    const s = await trainStatus(group_id);
    const status = String(s.status || s.state || '').toLowerCase();
    if (onTick) onTick(status, Math.round((Date.now() - started) / 1000));
    if (['ready', 'completed', 'success'].includes(status)) return { ok: true, status, raw: s };
    if (['failed', 'error'].includes(status)) return { ok: false, status, error: s.error || s.message || 'training_failed', raw: s };
    if (Date.now() - started > timeoutMs) return { ok: false, status, error: 'timeout_waiting_for_training', raw: s };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// 5) The looks in a trained group. One of these ids is what you render with —
//    the group id is NOT an avatar id, and passing it to a render call fails
//    in a way that reads like the avatar does not exist.
// ---------------------------------------------------------------------------
async function listGroupLooks(group_id) {
  const d = await apiFetch('/v2/avatar_group/' + encodeURIComponent(group_id) + '/avatars', { method: 'GET' });
  const arr = d.avatar_list || d.avatars || d.list || (Array.isArray(d) ? d : []);
  return arr.map((a) => ({ avatar_id: a.avatar_id || a.id, name: a.avatar_name || a.name, status: a.status }));
}

// ---------------------------------------------------------------------------
// The whole thing, end to end.
// ---------------------------------------------------------------------------
async function createPhotoAvatar({ name, imagePath, wait = true, onTick }) {
  const up = await uploadImage(imagePath);
  const grp = await createAvatarGroup({ name, image_key: up.image_key });
  await trainAvatarGroup(grp.group_id);
  if (!wait) return { ...grp, image_key: up.image_key, trained: false };
  const t = await waitForTraining(grp.group_id, { onTick });
  if (!t.ok) return { ...grp, image_key: up.image_key, trained: false, error: t.error, status: t.status };
  const looks = await listGroupLooks(grp.group_id);
  return { ...grp, image_key: up.image_key, trained: true, looks };
}

module.exports = {
  enabled, uploadImage, createAvatarGroup, trainAvatarGroup,
  trainStatus, waitForTraining, listGroupLooks, createPhotoAvatar,
};
