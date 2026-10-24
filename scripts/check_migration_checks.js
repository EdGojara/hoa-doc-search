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
// Full catalog declarations (Ed 2026-10-24, migration 544 VERIFY_FAILED: the second
// time a manifest missed objects the apply-time catalog diff sees). The verifier
// snapshots EVERY column, constraint (including Postgres's automatic names), index,
// trigger and function, so from 544 on the manifest must declare all of them:
//   CREATE TABLE t (...)  -> table:t, column:t.<each col>, and the constraints and
//                            indexes Postgres names on its own (t_pkey, t_<col>_fkey,
//                            t_<col>_check, t_check / t_check1 ..., t_<col>_key)
//   ALTER TABLE t ADD COLUMN c  -> column:t.c (+ its inline fkey / check)
//   CREATE TRIGGER x ... ON t   -> trigger:t.x
//   CREATE FUNCTION f           -> function:f (added, or changed when replaced)
// The automatic names follow Postgres's rules and were confirmed by applying 544 to a
// real Postgres. Truncated names (over 63 characters) are not modelled.
const FULL_FROM = 544;
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '', q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function tableBody(sql, start) {
  let i = sql.indexOf('(', start), depth = 0, q = false;
  for (let j = i; j < sql.length; j++) {
    const ch = sql[j];
    if (ch === "'") q = !q;
    if (q) continue;
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return sql.slice(i + 1, j); }
  }
  return '';
}
function fullCatalogWant(rawSql) {
  const want = [];
  const sql = rawSql.replace(/--[^\n]*/g, '').replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''");
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const t = m[1].toLowerCase();
    let checks = 0;
    const tableCheck = () => `constraint:${t}.${t}_check${checks++ ? checks - 1 : ''}`;
    for (const item of splitTopLevel(tableBody(sql, m.index))) {
      const head = item.toLowerCase();
      let mm;
      if ((mm = /^constraint\s+([a-z_][a-z0-9_]*)\s+(.*)$/is.exec(item))) {
        const n = mm[1].toLowerCase(); want.push(`constraint:${t}.${n}`);
        if (/^(primary\s+key|unique)\b/i.test(mm[2])) want.push(`index:${n}`);
      } else if (/^check\s*\(/.test(head)) want.push(tableCheck());
      else if (/^primary\s+key\b/.test(head)) want.push(`constraint:${t}.${t}_pkey`, `index:${t}_pkey`);
      else if ((mm = /^unique\s*\(([^)]*)\)/.exec(head))) { const n = `${t}_${mm[1].split(',').map((c) => c.trim()).join('_')}_key`; want.push(`constraint:${t}.${n}`, `index:${n}`); }
      else if ((mm = /^foreign\s+key\s*\(\s*([a-z_][a-z0-9_]*)/.exec(head))) want.push(`constraint:${t}.${t}_${mm[1]}_fkey`);
      else if ((mm = /^([a-z_][a-z0-9_]*)\s+/.exec(head)) && !/^(like|exclude)$/.test(mm[1])) {
        const c = mm[1]; want.push(`column:${t}.${c}`);
        if (/\bprimary\s+key\b/.test(head)) want.push(`constraint:${t}.${t}_pkey`, `index:${t}_pkey`);
        if (/\breferences\b/.test(head)) want.push(`constraint:${t}.${t}_${c}_fkey`);
        if (/\bcheck\s*\(/.test(head)) want.push(`constraint:${t}.${t}_${c}_check`);
        if (/\bunique\b/.test(head)) want.push(`constraint:${t}.${t}_${c}_key`, `index:${t}_${c}_key`);
      }
    }
  }
  for (const st of sql.split(';')) {
    const at = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(st);
    if (!at) continue;
    const t = at[1].toLowerCase();
    for (const part of splitTopLevel(st.slice(at.index + at[0].length))) {
      const mm = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)(.*)$/is.exec(part.trim());
      if (!mm) continue;
      const c = mm[1].toLowerCase(), rest = mm[2].toLowerCase(); want.push(`column:${t}.${c}`);
      if (/\breferences\b/.test(rest)) want.push(`constraint:${t}.${t}_${c}_fkey`);
      if (/\bcheck\s*\(/.test(rest)) want.push(`constraint:${t}.${t}_${c}_check`);
    }
  }
  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_][a-z0-9_]*)[\s\S]*?\bON\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) want.push(`trigger:${m[2].toLowerCase()}.${m[1].toLowerCase()}`);
  for (const m of rawSql.replace(/--[^\n]*/g, '').matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)) want.push(`function:${m[1].toLowerCase()}`);
  return [...new Set(want)];
}
for (const f of files.filter((x) => Number(x.slice(0, 3)) >= FULL_FROM)) {
  const cj = path.join(DIR, 'checks', f.replace(/\.sql$/, '.json'));
  if (!fs.existsSync(cj)) continue;
  let objs; try { objs = JSON.parse(fs.readFileSync(cj, 'utf8')).objects || {}; } catch (_) { continue; }
  const declared = new Set([...(objs.added || []), ...(objs.changed || [])]);
  for (const w of fullCatalogWant(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    if (!declared.has(w)) problems.push(`${f}: creates ${w} but checks/${path.basename(cj)} does not declare it (the apply-time catalog diff will fail VERIFY)`);
  }
}
module.exports = { fullCatalogWant };
for (const j of fs.existsSync(path.join(DIR, 'checks')) ? fs.readdirSync(path.join(DIR, 'checks')) : []) {
  if (!fs.existsSync(path.join(DIR, j.replace(/\.json$/, '.sql')))) problems.push(`checks/${j}: no matching migration file`);
}
if (problems.length) {
  console.error('✗ Migration checks problems:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} migration(s) from ${FIRST} on have a valid checks file and run as one transaction.`);
}
