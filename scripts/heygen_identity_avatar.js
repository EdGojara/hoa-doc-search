#!/usr/bin/env node
// ============================================================================
// scripts/heygen_identity_avatar.js  (Ed 2026-11-22)  Identity standardization
// ----------------------------------------------------------------------------
// Builds a REPLACEMENT HeyGen photo avatar from a teammate's approved original
// image and renders a short test video, for Ed's review. It never switches the
// active avatar: production keeps reading <FACE>_AVATAR_ID until Ed approves and
// the setting is changed. The old avatar is untouched (kept as legacy).
//
// Uses HeyGen's current v3 API (the v2 photo_avatar routes in
// lib/video/heygen_avatar.js were announced for removal on 2026-10-31):
//   POST /v3/assets (multipart 'file')                 -> asset id
//   POST /v3/avatars { type:'photo', name, file }       -> new group + look
//   GET  /v3/avatars/looks/{look_id}                    -> poll until completed
//   POST /v3/videos { type:'avatar', avatar_id, voice_id, script } -> test render
//   GET  /v3/videos/{video_id}                          -> poll, download video_url
//
//   node scripts/heygen_identity_avatar.js create --name "<group name>" --image <file>
//   node scripts/heygen_identity_avatar.js status --look <look_id>
//   node scripts/heygen_identity_avatar.js render --look <look_id> --voice <voice_id|FACE> --script "<text>" --out <file.mp4>
//
// COST: creating an avatar and rendering a video use HeyGen credits. Nothing
// here runs implicitly; every call is an explicit command.
// ============================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const API = 'https://api.heygen.com';
const KEY = process.env.HEYGEN_API_KEY;
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body, { form } = {}) {
  const headers = { 'x-api-key': KEY, accept: 'application/json' };
  let payload;
  if (form) payload = form;
  else if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(API + p, { method, headers, body: payload });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { /* not json */ }
  if (!r.ok) throw new Error(`HeyGen ${method} ${p} -> ${r.status}: ${text.slice(0, 400)}`);
  return (j && j.data !== undefined) ? j.data : j;
}

async function uploadAsset(file) {
  const buf = fs.readFileSync(file);
  const form = new FormData();
  const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  form.append('file', new Blob([buf], { type }), path.basename(file));
  const d = await call('POST', '/v3/assets', null, { form });
  const id = d.asset_id || d.id;
  if (!id) throw new Error(`no asset id in upload response: ${JSON.stringify(d).slice(0, 300)}`);
  return id;
}

async function waitLook(lookId, timeoutMs = 20 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    const look = await call('GET', `/v3/avatars/looks/${lookId}`);
    const st = look.status;
    if (st === 'completed') return look;
    if (st === 'failed') throw new Error(`look failed: ${JSON.stringify(look.error || look).slice(0, 300)}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`look still ${st} after ${Math.round(timeoutMs / 60000)} min`);
    await sleep(15000);
  }
}

async function voiceFor(v) {
  if (/^[A-Z]+$/.test(v)) {
    const face = v;
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    const { data, error } = await sb.from('persona_voices').select('voice_id').eq('face', face).maybeSingle();
    if (error) throw new Error(`persona_voices: ${error.message}`);
    const id = (data && data.voice_id) || process.env[`${face}_VOICE_ID`];
    if (!id) throw new Error(`no voice for ${face}`);
    return id;
  }
  return v;
}

(async () => {
  if (!KEY) throw new Error('HEYGEN_API_KEY is not set');
  if (cmd === 'create') {
    const name = arg('--name'); const image = arg('--image');
    if (!name || !image) throw new Error('--name and --image are required');
    const assetId = await uploadAsset(image);
    console.log('uploaded asset', assetId);
    const d = await call('POST', '/v3/avatars', { type: 'photo', name, file: { type: 'asset_id', asset_id: assetId } });
    const look = d.avatar_item || {}; const group = d.avatar_group || {};
    console.log(JSON.stringify({ look_id: look.id, group_id: group.id, status: look.status }));
    if (look.id) { const done = await waitLook(look.id); console.log('completed', JSON.stringify({ look_id: done.id, engines: done.supported_api_engines, image: done.image_url ? 'yes' : 'no' })); }
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await call('GET', `/v3/avatars/looks/${arg('--look')}`), null, 1));
  } else if (cmd === 'render') {
    const look = arg('--look'); const voice = await voiceFor(arg('--voice')); const script = arg('--script'); const out = arg('--out');
    if (!look || !voice || !script || !out) throw new Error('--look, --voice, --script and --out are required');
    const body = { type: 'avatar', avatar_id: look, voice_id: voice, script };
    if (arg('--engine')) body.engine = { type: arg('--engine') };
    const d = await call('POST', '/v3/videos', body);
    const vid = d.video_id || d.id;
    console.log('video', vid);
    const t0 = Date.now();
    for (;;) {
      await sleep(15000);
      const v = await call('GET', `/v3/videos/${vid}`);
      if (v.status === 'completed') {
        const r = await fetch(v.video_url); fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
        console.log('saved', out, `${Math.round((Date.now() - t0) / 1000)}s`); break;
      }
      if (v.status === 'failed') throw new Error(`render failed: ${v.failure_code} ${v.failure_message}`);
      if (Date.now() - t0 > 30 * 60 * 1000) throw new Error(`render still ${v.status} after 30 min`);
    }
  } else {
    throw new Error('usage: create | status | render (see header)');
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
