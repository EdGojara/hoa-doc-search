#!/usr/bin/env node
// ============================================================================
// backup_explainers.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// Pulls every published explainer out of Supabase to a second location.
//
//   node scripts/backup_explainers.js --to="C:/Users/.../OneDrive - Bedrock/Explainers"
//   node scripts/backup_explainers.js --to=... --check     (verify only, no copy)
//
// WHY. The videos exist in exactly ONE place: the Supabase `explainers` bucket.
// HeyGen's copies expire in about a week. Migration 369 solved link rot — it did
// not solve loss. Two failure modes remain and neither shows a warning:
//
//   1. Supabase database backups do NOT include Storage objects. Restore the
//      project from a backup and every claire_explainers ROW comes back while
//      the mp4s do not. The library would look intact in the admin and 404 for
//      every homeowner.
//   2. Anything that empties or un-publics the bucket — a cleanup script, a
//      permissions change, a wrong environment — takes the whole library with
//      no undo.
//
// Each video costs real credits and real judgment about what to say to a board.
// Re-rendering is not free and the words would drift. Keep a copy.
//
// Writes a manifest.json alongside so a restore knows which file was which
// topic, language and title — the filename alone is a bare uuid.
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));

(async () => {
  const dest = args.to;
  if (!dest) { console.error('\n✗ --to=<folder> is required\n'); process.exit(1); }
  const checkOnly = !!args.check;

  const { data: rows, error } = await supabase.from('claire_explainers')
    .select('id, topic, language, title, storage_path, bytes, video_url, duration_seconds')
    .eq('status', 'ready').order('topic');
  if (error) { console.error('✗ ' + error.message); process.exit(1); }

  if (!checkOnly) fs.mkdirSync(dest, { recursive: true });

  const manifest = [];
  let copied = 0, skipped = 0, missing = 0, bytes = 0;

  for (const r of rows) {
    // A row with no storage_path cannot be restored to the right place later,
    // so it is a finding, not a silent skip.
    if (!r.storage_path) { console.log('  ⚠ no storage_path: ' + r.title + ' — cannot be backed up reliably'); missing++; continue; }

    const local = path.join(dest, `${r.topic}__${r.language}__${r.id}.mp4`);
    manifest.push({ id: r.id, topic: r.topic, language: r.language, title: r.title,
      storage_path: r.storage_path, bytes: r.bytes, duration_seconds: r.duration_seconds,
      file: path.basename(local) });

    if (fs.existsSync(local) && fs.statSync(local).size === Number(r.bytes)) {
      console.log('  = ' + r.title.padEnd(26) + 'already backed up'); skipped++; bytes += Number(r.bytes || 0); continue;
    }
    if (checkOnly) { console.log('  ! ' + r.title.padEnd(26) + 'MISSING from backup'); missing++; continue; }

    const { data, error: de } = await supabase.storage.from('explainers').download(r.storage_path);
    if (de) { console.log('  ✗ ' + r.title.padEnd(26) + 'download failed: ' + de.message); missing++; continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    fs.writeFileSync(local, buf);
    console.log('  + ' + r.title.padEnd(26) + Math.round(buf.length / 1024 / 1024 * 10) / 10 + 'MB');
    copied++; bytes += buf.length;
  }

  if (!checkOnly) {
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  console.log('\n  ' + rows.length + ' published | ' + copied + ' copied | ' + skipped + ' already there | ' +
    missing + ' missing | ' + Math.round(bytes / 1024 / 1024 * 10) / 10 + 'MB total');
  if (missing && checkOnly) { console.log('\n  Run without --check to fetch them.\n'); process.exit(1); }
  if (!checkOnly) console.log('  manifest.json written — a restore needs it to know which uuid was which video.\n');
})().catch((e) => { console.error('\n✗ ' + e.message + '\n'); process.exit(1); });
