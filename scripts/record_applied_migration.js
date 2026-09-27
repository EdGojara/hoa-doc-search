#!/usr/bin/env node
// ============================================================================
// scripts/record_applied_migration.js  (Ed 2026-09-26)
// ----------------------------------------------------------------------------
// Records ONE migration as applied in schema_migrations, AFTER it has been run
// in the Supabase SQL editor. Closes the gap that made every editor-applied
// migration look "pending" (see migration 468 and lib/migrations_runner.js).
//
// The sha256 recorded is the file exactly as main will deploy it (the git blob,
// LF line endings), which is what the status check compares against.
//
//   node scripts/record_applied_migration.js 469            # show what would be recorded
//   node scripts/record_applied_migration.js 469 --confirm   # record it
//
// It refuses to overwrite a clean row with a different hash (a file changed
// after it was applied must be investigated, not papered over).
// ============================================================================
require('dotenv').config({ quiet: true });
const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
const [num, flag] = process.argv.slice(2);
if (!/^\d{3}$/.test(num || '')) { console.error('usage: node scripts/record_applied_migration.js <NNN> [--confirm]'); process.exit(2); }

(async () => {
  const files = execSync('git ls-tree --name-only HEAD migrations/', { cwd: ROOT }).toString().split('\n')
    .filter((f) => f.startsWith(`migrations/${num}_`) && f.endsWith('.sql'));
  if (files.length !== 1) throw new Error(`expected exactly one committed migrations/${num}_*.sql, found ${files.length} (commit it first)`);
  const filename = files[0].slice('migrations/'.length);
  const content = execSync(`git show HEAD:${files[0]}`, { cwd: ROOT }).toString();
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: existing, error } = await db.from('schema_migrations').select('filename, sha256, error, applied_at').eq('filename', filename).maybeSingle();
  if (error) throw new Error(`reading schema_migrations failed: ${error.message} (is migration 468 applied?)`);
  if (existing && !existing.error) {
    if (existing.sha256 === sha256) { console.log(`${filename} is already recorded (applied_at ${existing.applied_at}). Nothing to do.`); return; }
    throw new Error(`${filename} is recorded with a DIFFERENT hash (${existing.sha256.slice(0, 12)} vs file ${sha256.slice(0, 12)}). The file changed after it was applied; investigate instead of re-recording.`);
  }
  console.log(`${existing ? 'will clear error row and record' : 'will record'}: ${filename}  sha256 ${sha256}`);
  if (flag !== '--confirm') { console.log('Dry run. Re-run with --confirm once the migration has been applied in the SQL editor.'); return; }
  const { error: upErr } = await db.from('schema_migrations').upsert({
    filename, sha256, applied_at: new Date().toISOString(), applied_by: 'sql-editor (recorded by scripts/record_applied_migration.js)', duration_ms: null, error: null,
  }, { onConflict: 'filename' });
  if (upErr) throw new Error(`recording failed: ${upErr.message}`);
  console.log(`recorded ${filename}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
