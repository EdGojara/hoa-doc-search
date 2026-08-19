#!/usr/bin/env node
// ============================================================================
// publish_explainer.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// Puts a finished teammate video on the public /learn library.
//
//   node scripts/publish_explainer.js \
//     --file=path/to/video.mp4 \
//     --topic=for_boards \
//     --title="For your board" \
//     --script="the exact words spoken" \
//     [--persona=kat] [--language=en] [--seconds=34] [--feature]
//
// WHY THIS EXISTS RATHER THAN A ONE-OFF SCRIPT EACH TIME. Two things have to be
// right every single publish, and both fail silently when done by hand:
//
//   1. THE URL MUST BE OURS. HeyGen's video_url is signed and expires in about
//      a week. Writing it into claire_explainers.video_url gives a library that
//      works perfectly in testing, gets linked from the portal and handed to a
//      board, and goes dead seven days later with no error anywhere — the row
//      still looks complete and the only symptom is a homeowner pressing play
//      and getting nothing. That is the scar migration 369 closed. This uploads
//      the bytes to the PUBLIC `explainers` bucket and stores OUR permanent url.
//
//   2. community_id MUST BE NULL for anything public. The /learn endpoint only
//      serves portfolio-wide rows, because a community-scoped video could name
//      a community, a board or a dispute. A row published with a community_id
//      simply never appears, which reads as "the upload failed."
//
// The file is verified fetchable over plain HTTP before the row is marked
// ready, so a broken publish fails here instead of in front of a board.
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'explainers';

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));

function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }

(async () => {
  const file = args.file;
  const topic = String(args.topic || '').trim();
  const title = String(args.title || '').trim();
  const language = args.language === 'es' ? 'es' : 'en';

  if (!file || !fs.existsSync(file)) die('--file is required and must exist');
  if (!topic) die('--topic is required (slug, e.g. for_boards)');
  if (!title) die('--title is required (what a homeowner reads on /learn)');
  if (!/^[a-z0-9_]+$/.test(topic)) die('--topic must be lowercase letters, digits and underscores');

  const buf = fs.readFileSync(file);
  if (!buf.length) die('the video file is empty');

  // 1) Row first — its id becomes the storage path, matching api/claire.js.
  const { data: row, error: ie } = await supabase.from('claire_explainers').insert({
    topic, language, title,
    script: args.script ? String(args.script) : null,
    community_id: null,                       // portfolio-wide, or /learn will not show it
    avatar_id: args.persona ? (process.env[String(args.persona).toUpperCase() + '_AVATAR_ID'] || null) : null,
    duration_seconds: args.seconds ? Number(args.seconds) : null,
    status: 'rendering',
  }).select('*').single();
  if (ie) die('insert failed: ' + ie.message);
  console.log('  row      ' + row.id);

  // 2) Bytes into the public bucket.
  const storagePath = `${topic}/${language}/${row.id}.mp4`;
  const { error: ue } = await supabase.storage.from(BUCKET)
    .upload(storagePath, buf, { contentType: 'video/mp4', upsert: true });
  if (ue) die('upload failed: ' + ue.message);
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  if (!pub || !pub.publicUrl) die('storage returned no public url');
  console.log('  uploaded ' + Math.round(buf.length / 1024 / 1024 * 10) / 10 + 'MB -> ' + storagePath);

  // 3) Prove it actually plays for someone with no login, BEFORE going ready.
  const head = await fetch(pub.publicUrl, { method: 'HEAD' });
  if (!head.ok) die('published file is not publicly fetchable (HTTP ' + head.status + ') — left as rendering');
  const bytes = Number(head.headers.get('content-length') || 0);
  if (bytes !== buf.length) die(`served ${bytes} bytes but uploaded ${buf.length} — left as rendering`);
  console.log('  verified public fetch ' + head.status + ' ' + head.headers.get('content-type'));

  // 4) Ready, with OUR url.
  const { error: fe } = await supabase.from('claire_explainers').update({
    status: 'ready', video_url: pub.publicUrl, storage_path: storagePath,
    bytes: buf.length, stored_at: new Date().toISOString(),
  }).eq('id', row.id);
  if (fe) die('final update failed: ' + fe.message);

  // 5) ARCHIVE IMMEDIATELY. The video now exists in exactly one place, and
  //    Supabase database backups do NOT include Storage objects — restore the
  //    project and this row comes back while the mp4 does not. Backing up at
  //    the moment of publication, rather than on a timer, means the archive can
  //    never be more than one publish stale and there is nothing to remember.
  //    Set EXPLAINER_ARCHIVE_DIR to change where it lands.
  const archiveDir = process.env.EXPLAINER_ARCHIVE_DIR
    || 'C:/Users/edget/OneDrive - Bedrock Association Management, LLC/Bedrock AI Videos';
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const copyTo = path.join(archiveDir, topic + '__' + language + '__' + row.id + '.mp4');
    fs.writeFileSync(copyTo, buf);
    console.log('  archived ' + copyTo);
  } catch (e) {
    // Loud, never swallowed: the video IS live, but the second copy is the
    // whole point, so a failed archive must be impossible to miss.
    console.error('  ! ARCHIVE FAILED (' + e.message + ') - the video is live but exists in ONE place.');
    console.error('    Fix with: node scripts/backup_explainers.js --to="' + archiveDir + '"');
  }

  console.log('\n✓ live on /learn — ' + title);
  console.log('  ' + pub.publicUrl);
  if (args.feature) {
    console.log('\n  NOTE: --feature only reminds you. Display order lives in the');
    console.log('  FEATURED array in api/claire.js so a new upload cannot silently');
    console.log('  outrank the explainer of what the company is. Add "' + topic + '" there.');
  }
})().catch((e) => die(e.message));
