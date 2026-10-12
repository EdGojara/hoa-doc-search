#!/usr/bin/env node
// ============================================================================
// scripts/check_migration_checks.js  (Ed 2026-09-27)
// ----------------------------------------------------------------------------
// Every migration from 469 on is applied by lib/migrations/apply_one.js, which
// needs a committed checks file (migrations/checks/NNN_name.json) describing
// its preflight, expected objects, row changes, protected tables and
// verification. This fails the build if a new migration has none, if the
// checks file is invalid, or if the migration cannot run as one transaction.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { loadMigration } = require('../lib/migrations/apply_one');

const DIR = path.join(__dirname, '..', 'migrations');
const FIRST = 469;
const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f) && Number(f.slice(0, 3)) >= FIRST).sort();
const problems = [];
for (const f of files) {
  try { loadMigration(f, DIR, { normalizeLineEndings: true }); } catch (e) { problems.push(`${f}: ${e.message}`); }
}
// Declared objects (Ed 2026-10-12, migration 513 VERIFY_FAILED on an undeclared
// table:work_item_events): every table, index and named constraint the SQL creates must
// be in checks.objects.added (or .changed), so the apply-time catalog diff cannot fail on
// a declaration the author forgot. Static and conservative: it only reads CREATE TABLE,
// CREATE [UNIQUE] INDEX and ADD CONSTRAINT names. From migration 513 on.
const DECLARED_FROM = 513;
for (const f of files.filter((x) => Number(x.slice(0, 3)) >= DECLARED_FROM)) {
  const cj = path.join(DIR, 'checks', f.replace(/\.sql$/, '.json'));
  if (!fs.existsSync(cj)) continue;
  let objs; try { objs = JSON.parse(fs.readFileSync(cj, 'utf8')).objects || {}; } catch (_) { continue; }
  const declared = new Set([...(objs.added || []), ...(objs.changed || [])]);
  const sql = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/--[^\n]*/g, '');
  const want = [];
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) want.push(`table:${m[1].toLowerCase()}`);
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) want.push(`index:${m[1].toLowerCase()}`);
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)/gi)) want.push(`constraint:${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  for (const w of [...new Set(want)]) if (!declared.has(w)) problems.push(`${f}: creates ${w} but checks/${path.basename(cj)} does not declare it in objects.added`);
}
for (const j of fs.existsSync(path.join(DIR, 'checks')) ? fs.readdirSync(path.join(DIR, 'checks')) : []) {
  if (!fs.existsSync(path.join(DIR, j.replace(/\.json$/, '.sql')))) problems.push(`checks/${j}: no matching migration file`);
}
if (problems.length) {
  console.error('✗ Migration checks problems:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} migration(s) from ${FIRST} on have a valid checks file and run as one transaction.`);
}
