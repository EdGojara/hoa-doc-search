#!/usr/bin/env node
// ============================================================================
// scripts/check_pagination.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// Fails `npm test` on the recurring Supabase pagination bug: a `.range()` read
// with NO stable `.order()` in its query chain. PostgREST caps responses at
// db-max-rows and paging with .range() but no ORDER BY makes pages drift — rows
// get duplicated AND skipped (the 123 Waterview rows a backfill silently missed,
// 2026-07-19). Every .range() must be ordered; for "read all rows" use the
// canonical lib/db/fetch_all.js (which orders + paginates for you).
//
// This is enforcement, not prose — CLAUDE.md's rule: a scar that ships twice
// becomes a check. Suppress a deliberate exception with a `// paginate-ok`
// comment on or just above the .range() line.
//
// Run: npm run test:pagination   (also part of `npm test`)
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['api', 'lib', 'scripts'];
const SELF = new Set([
  path.normalize('lib/db/fetch_all.js'),
  path.normalize('scripts/check_pagination.js'),
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// For a .range() at line i, reconstruct its query context by walking up to the
// nearest `.from(` (the query origin), then check that context for `.order(`.
function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  // Blank out line comments so `.range(` / `.order(` mentioned in prose don't
  // count as code (keeps the raw line for display via `raw`).
  const raw = src.split(/\r?\n/);
  const lines = raw.map((l) => l.replace(/\/\/.*$/, ''));
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\.range\s*\(/.test(lines[i])) continue;
    // suppression: `// paginate-ok` on the range line or the line above
    if (/paginate-ok/.test(lines[i]) || (i > 0 && /paginate-ok/.test(lines[i - 1]))) continue;
    // walk up (<=40 lines) to the query origin
    let start = Math.max(0, i - 15);
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      if (/\.from\s*\(/.test(lines[j])) { start = j; break; }
    }
    const context = lines.slice(start, i + 1).join('\n');
    if (!/\.order\s*\(/.test(context)) {
      bad.push({ line: i + 1, snippet: raw[i].trim().slice(0, 90) });
    }
  }
  return bad;
}

// Baseline of KNOWN pre-existing violations, as a per-file count. The check
// fails only when a file EXCEEDS its baseline (a new/regressed unordered
// .range()) or a non-baselined file has any — so no new occurrence can ship
// while the known set is ratcheted down. Regenerate with --update-baseline
// after you legitimately fix some (never to hide a new one).
const BASELINE_PATH = path.join(__dirname, 'pagination_baseline.json');
const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : {};

const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)))
  .filter((f) => !SELF.has(path.normalize(path.relative(ROOT, f))));

const counts = {};
for (const f of files) {
  const bad = checkFile(f);
  if (bad.length) counts[path.relative(ROOT, f).replace(/\\/g, '/')] = bad.map((b) => b.snippet);
}

if (process.argv.includes('--update-baseline')) {
  const out = {}; for (const [k, v] of Object.entries(counts)) out[k] = v.length;
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote baseline: ${Object.keys(out).length} files, ${Object.values(out).reduce((a, b) => a + b, 0)} known violations.`);
  process.exit(0);
}

let failed = 0, ratchet = 0;
for (const [rel, snippets] of Object.entries(counts)) {
  const allowed = baseline[rel] || 0;
  if (snippets.length > allowed) {
    failed += snippets.length - allowed;
    console.error(`  ${rel}: ${snippets.length} unordered .range() (baseline allows ${allowed}) — NEW:`);
    for (const s of snippets.slice(allowed)) console.error(`      ${s}`);
  } else if (snippets.length < allowed) { ratchet++; }
}

if (failed) {
  console.error(`\n✗ ${failed} NEW unordered .range() pagination read(s).`);
  console.error('  A .range() with no .order() drifts across pages (duplicates + skips rows).');
  console.error('  Fix: add a stable .order(...), or use fetchAll/fetchAllQuery from lib/db/fetch_all.js.');
  console.error('  Deliberate exception? Put `// paginate-ok` on the .range() line.');
  process.exit(1);
}
const known = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`✓ No new unordered .range(). ${known} baselined (being ratcheted down)${ratchet ? `; ${ratchet} file(s) improved — run --update-baseline to lock the gain` : ''}.`);
