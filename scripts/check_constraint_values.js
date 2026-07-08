#!/usr/bin/env node
// ============================================================================
// scripts/check_constraint_values.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// ENFORCEMENT for a recurring scar: code inserting a literal value into a
// CHECK-constrained column that the constraint forbids. That class shipped
// twice silently (mail_scan, minutes_module → source_origin) because the
// "rule" lived in CLAUDE.md as prose nobody re-reads mid-ship. A note is not
// enforcement. This is: it reads every `CHECK (col IN (...))` from the
// migrations and every `.from('table').insert({ col: 'literal' })` in the code,
// and FAILS if a code value isn't in the constraint's allowed set.
//
//   node scripts/check_constraint_values.js     # exit 1 on any violation
//
// Wired into `npm test`. Static + literal-only by design: it can't catch a
// value computed at runtime, but it makes the exact "invented enum value"
// class impossible to ship unseen — which is the class that keeps recurring.
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.js$/.test(e.name)) out.push(full);
  }
  return out;
};

// ---- 1. Allowed values per table.column, from migration CHECK constraints ----
// Process migrations in numeric order; a later DROP+ADD replaces the earlier set
// (e.g. 263 replaces 013's source_origin), so last definition wins.
const allowed = {}; // "table.col" -> Set(values)
const migFiles = fs.readdirSync(path.join(ROOT, 'migrations'))
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

const CHECK_RE = /CHECK\s*\(\s*([a-z_]+)\s+IN\s*\(([^)]*)\)/gi;
for (const f of migFiles) {
  // Strip SQL line comments first — several enum lists document each value with
  // a trailing `-- ...`, which otherwise gets parsed INTO the allowed set.
  const sql = read(path.join(ROOT, 'migrations', f)).replace(/--[^\n]*/g, '');
  let m;
  while ((m = CHECK_RE.exec(sql))) {
    const col = m[1];
    // nearest preceding "CREATE|ALTER TABLE <name>" owns this constraint
    const before = sql.slice(0, m.index);
    const tblMatch = [...before.matchAll(/(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)].pop();
    if (!tblMatch) continue;
    const table = tblMatch[1];
    const vals = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    allowed[`${table}.${col}`] = new Set(vals); // last wins
  }
}

// ---- 2. Literal insert values in the code, tied to their table ----
// Find `.from('table') ... .insert({ ... })`, brace-match the object, pull
// `col: 'literal'` pairs. Skips dynamic values (variables/expressions).
function braceMatch(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return '';
}

const violations = [];
// .insert MUST be directly chained to its .from — `.from('t').insert({...})`.
// Allowing arbitrary code between them mis-paired a later insert with an
// earlier unrelated .from('other_table') and produced false positives.
const FROM_INSERT = /\.from\(\s*['"]([a-z_]+)['"]\s*\)\s*\.insert\(\s*(\{)/g;
for (const file of walk(path.join(ROOT, 'api')).concat(walk(path.join(ROOT, 'lib')))) {
  const code = read(file);
  let m;
  while ((m = FROM_INSERT.exec(code))) {
    const table = m[1];
    const objStart = m.index + m[0].length - 1; // index of the '{'
    const obj = braceMatch(code, objStart);
    if (!obj) continue;
    // Only TOP-LEVEL keys of the insert object are columns. Collapse any nested
    // {...} / [...] (jsonb values, attachment arrays) to nothing so their inner
    // `type:`/`status:` fields aren't misread as columns of this table.
    let flat = obj.slice(1, -1);
    let prev;
    do { prev = flat; flat = flat.replace(/\{[^{}]*\}/g, '').replace(/\[[^\[\]]*\]/g, ''); } while (flat !== prev);
    // literal col: 'value' pairs (single or double quotes)
    const PAIR = /(\b[a-z_]+)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/gi;
    let p;
    while ((p = PAIR.exec(flat))) {
      const col = p[1]; const val = p[3];
      const key = `${table}.${col}`;
      if (allowed[key] && !allowed[key].has(val)) {
        // Line of the col:'val' pair in the original object (fall back to the insert site).
        const inObj = obj.search(new RegExp(col + "\\s*:\\s*['\"]" + val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        const absIdx = inObj >= 0 ? objStart + inObj : m.index;
        const line = code.slice(0, absIdx).split('\n').length;
        violations.push({ file: path.relative(ROOT, file), line, table, col, val, allowed: [...allowed[key]] });
      }
    }
  }
}

// ---- 3. Report ----
console.log(`Checked ${Object.keys(allowed).length} constrained columns across ${migFiles.length} migrations.`);
if (!violations.length) {
  console.log('✓ No code inserts a literal value its column’s CHECK constraint forbids.');
  process.exit(0);
}
console.error(`\n✗ ${violations.length} constraint violation(s) — a save WILL be rejected at runtime:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.table}.${v.col} = '${v.val}'  — not in {${v.allowed.join(', ')}}\n`);
}
process.exit(1);
