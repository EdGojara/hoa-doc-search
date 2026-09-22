#!/usr/bin/env node
// ============================================================================
// render_explainer.js  (2026-09-19)
// ----------------------------------------------------------------------------
// The missing first half of publishing a teammate video. publish_explainer.js
// takes a FINISHED mp4 and puts it on /learn permanently; this renders that mp4
// from a script using the teammate's HeyGen avatar, waits for it, downloads it,
// and then hands it straight to publish_explainer.js. One command, script in to
// live-on-/learn out, so nobody has to babysit the HeyGen studio or copy a
// signed url that expires in a week.
//
//   node scripts/render_explainer.js \
//     --topic=clma_team \
//     --title="Meet the team" \
//     --persona=amanda \
//     --script-file=path/to/script.txt \
//     [--seconds=45] [--language=en] [--background=#0B1D34] [--no-publish]
//
// WHY A COMPANION SCRIPT RATHER THAN INLINE. Rendering is metered HeyGen quota
// and takes minutes, and the render/poll/download/publish chain fails silently
// in several places when hand-run (a poll that never terminates, a signed url
// stored raw, an empty download). Encoding the whole chain once means every
// future team video renders the same correct way. See lib/video/heygen.js for
// the render+poll primitives and scripts/publish_explainer.js for why the
// permanent url + community_id=null + archive steps are non-negotiable.
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const heygen = require('../lib/video/heygen');

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));

function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }
function log(msg) { console.log('  ' + msg); }

(async () => {
  if (!heygen.heygenEnabled()) die('HEYGEN_API_KEY is not set — cannot render');

  const topic = String(args.topic || '').trim();
  const title = String(args.title || '').trim();
  const persona = String(args.persona || 'amanda').trim().toLowerCase();
  const language = args.language === 'es' ? 'es' : 'en';
  const background = args.background ? String(args.background) : '#0B1D34';

  let script = '';
  if (args['script-file']) {
    if (!fs.existsSync(args['script-file'])) die('--script-file does not exist: ' + args['script-file']);
    script = fs.readFileSync(args['script-file'], 'utf8');
  } else if (args.script) {
    script = String(args.script);
  }
  script = script.trim();

  if (!topic) die('--topic is required (slug, e.g. clma_team)');
  if (!/^[a-z0-9_]+$/.test(topic)) die('--topic must be lowercase letters, digits and underscores');
  if (!title) die('--title is required');
  if (!script) die('--script or --script-file is required');

  // Resolve the avatar/voice up front so a misconfigured persona fails BEFORE
  // we spend any HeyGen quota, not minutes into a render.
  const avatarId = heygen.avatarIdFor(persona);
  const voiceId = heygen.voiceIdFor(persona);
  if (!avatarId) die('no avatar configured for persona "' + persona + '" (check ' + persona.toUpperCase() + '_AVATAR_ID)');
  if (!voiceId) die('no voice configured for persona "' + persona + '" (check ' + persona.toUpperCase() + '_VOICE_ID)');

  console.log('\nrender_explainer  topic=' + topic + '  persona=' + persona + '  lang=' + language);
  log('script  ' + script.length + ' chars, ~' + Math.round(script.split(/\s+/).length / 2.5) + 's spoken');

  // 1) Kick off the render.
  const videoId = await heygen.renderExplainer({ script, language, persona, avatarId, voiceId, background, title });
  log('video   ' + videoId + ' (rendering)');

  // 2) Poll to completion. HeyGen renders a ~45s clip in a couple of minutes;
  //    cap at 15 to fail loudly rather than hang forever.
  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  let url = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 15000));
    let st;
    try { st = await heygen.videoStatus(videoId); }
    catch (e) { log('poll error (' + e.message + ') — retrying'); continue; }
    const secs = Math.round((Date.now() - started) / 1000);
    if (st.status === 'completed' && st.video_url) { url = st.video_url; log('completed in ' + secs + 's' + (st.duration ? ' (' + st.duration + 's clip)' : '')); break; }
    if (st.status === 'failed') die('HeyGen render failed: ' + (st.error || 'unknown'));
    if (Date.now() - started > timeoutMs) die('timed out after ' + secs + 's waiting for render ' + videoId);
    log('… ' + st.status + ' (' + secs + 's)');
  }

  // 3) Download the finished mp4 to a temp file. This signed url expires in
  //    about a week — publish_explainer.js re-hosts the bytes on our permanent
  //    bucket, so this file is throwaway.
  const res = await fetch(url);
  if (!res.ok) die('download failed: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) die('downloaded an empty file');
  const tmp = path.join(os.tmpdir(), 'explainer_' + topic + '_' + language + '_' + Date.now() + '.mp4');
  fs.writeFileSync(tmp, buf);
  log('downloaded ' + Math.round(buf.length / 1024 / 1024 * 10) / 10 + 'MB -> ' + tmp);

  if (args['no-publish']) {
    console.log('\n✓ rendered (not published, --no-publish). File: ' + tmp + '\n');
    return;
  }

  // 4) Hand to the existing publisher — permanent url, community_id=null, the
  //    public-fetch proof, and the immediate archive all live there.
  const pubArgs = [
    path.join(__dirname, 'publish_explainer.js'),
    '--file=' + tmp,
    '--topic=' + topic,
    '--title=' + title,
    '--script=' + script,
    '--language=' + language,
    '--persona=' + persona,
  ];
  if (args.seconds) pubArgs.push('--seconds=' + args.seconds);
  if (args.feature) pubArgs.push('--feature');
  console.log('\n-> handing to publish_explainer.js\n');
  const r = spawnSync(process.execPath, pubArgs, { stdio: 'inherit' });
  if (r.status !== 0) die('publish step failed (exit ' + r.status + ') — the temp mp4 is kept at ' + tmp);
  try { fs.unlinkSync(tmp); } catch (_) { /* leave it; not fatal */ }
})().catch((e) => die(e.message));
