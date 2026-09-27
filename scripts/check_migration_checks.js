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
for (const j of fs.existsSync(path.join(DIR, 'checks')) ? fs.readdirSync(path.join(DIR, 'checks')) : []) {
  if (!fs.existsSync(path.join(DIR, j.replace(/\.json$/, '.sql')))) problems.push(`checks/${j}: no matching migration file`);
}
if (problems.length) {
  console.error('✗ Migration checks problems:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} migration(s) from ${FIRST} on have a valid checks file and run as one transaction.`);
}
