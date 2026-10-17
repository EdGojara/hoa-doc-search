#!/usr/bin/env node
// ============================================================================
// check_onboarding_community_agnostic.js  (Ed 2026-10-17)
// ----------------------------------------------------------------------------
// The conversion engine (lib/onboarding/**) is source-agnostic and community-
// agnostic: every community fact (accounts, amounts, lots, owners, decisions)
// enters as batch DATA (source reports, approved adjustments / policies, owner
// decisions), never as code. This check FAILS the build when:
//   * any UUID literal appears anywhere in lib/onboarding/** (code or comment):
//     a community / batch / property id in the engine is community-specific logic;
//   * a community name, slug or conversion batch code appears in EXECUTABLE code
//     (strings, identifiers, regexes). Comments may cite the precedent a generic
//     rule was proven on (they change no behavior); code may not branch on it.
// Run: node scripts/check_onboarding_community_agnostic.js   (wired into npm test)
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'lib', 'onboarding');
// Portfolio communities (names, slugs, short codes) and their conversion batch codes. A new
// community added to the portfolio belongs here too; the UUID rule needs no list.
const NAMES = [
  'still creek', 'still-creek', 'canyon gate', 'canyon-gate', 'pine forest', 'pine-forest', 'waterview', 'quail ridge', 'quail-ridge',
  'august meadows', 'august-meadows', 'eaglewood', 'covington', 'cinco ranch', 'lennar',
  'CONV-SCR', 'CONV-CGACR', 'CONV-LPF', 'CONV-QR',
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Remove comments (line and block), keep strings / regexes / code. A small state machine:
// good enough for this codebase's style (no comment markers inside regex character classes
// would be mistaken, because we only need to KEEP code and drop comments conservatively).
function codeOnly(src) {
  let out = ''; let i = 0; let mode = 'code'; let quote = null;
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; } if (c === '\n') out += c; i++; continue; }
    if (mode === 'str') { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === quote) mode = 'code'; i++; continue; }
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (/\.(js|mjs|cjs|json|sql)$/.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(DIR)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => { const m = UUID.exec(line); if (m) problems.push(`${rel}:${i + 1}: UUID literal ${m[0]}`); });
  const code = /\.js$|\.mjs$|\.cjs$/.test(file) ? codeOnly(src) : src;
  code.split('\n').forEach((line, i) => {
    const low = line.toLowerCase();
    for (const nm of NAMES) if (low.includes(nm.toLowerCase())) problems.push(`${rel}:${i + 1}: community-specific name "${nm}" in code`);
  });
}

if (problems.length) {
  console.error(`✗ lib/onboarding must stay community-agnostic (${problems.length} problem(s)):`);
  for (const p of problems) console.error('  ' + p);
  console.error('Community facts enter as batch data (reports, approved adjustments / policies, decisions), never as code.');
  process.exit(1);
}
console.log(`✓ lib/onboarding is community-agnostic (${walk(DIR).length} files: no UUID literals; no community names in code).`);
