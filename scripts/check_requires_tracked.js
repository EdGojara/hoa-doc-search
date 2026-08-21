// ============================================================================
// scripts/check_requires_tracked.js — every local require must be a file that
// actually ships.
// ----------------------------------------------------------------------------
// SCAR, 2026-08-21. `.gitignore` carried an unanchored `_*.js`, meant for
// one-off scratch scripts at the repo root. It ignores every underscore-prefixed
// file ANYWHERE, so when api/_presentation_mode.js was written, `git add -A`
// skipped it without a word. The commit shipped the module's TEST but not the
// module. Locally everything passed — the file was right there on disk. On
// Render the server hit `require('./_presentation_mode')`, threw
// MODULE_NOT_FOUND, and exited 1. The deploy failed with no indication of why,
// because nothing anywhere reports a file git decided not to see.
//
// The general failure: a require that resolves on the author's disk but not in
// the repository. .gitignore is the common cause; a forgotten `git add` is the
// other. Both are invisible until deploy, and both take production down at boot
// rather than at a code path anyone tested.
//
// So: walk every require() in the shipped source, resolve it, and assert the
// target is TRACKED BY GIT. Untracked is untracked whether a rule caused it or
// a person forgot.
//
// Run: npm run test:requires   (wired into npm test)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Where shipped code lives. Scratch scripts at the root are deliberately
// ignored by git and are not part of the deployed app.
const DIRS = ['api', 'lib', 'scripts', 'tests'];
const ENTRY_FILES = ['server.js'];

function tracked() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return new Set(out.split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/')));
}

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); }
  catch (_) { return acc; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'fixtures') continue;
      walk(rel, acc);
    } else if (e.name.endsWith('.js')) {
      acc.push(rel);
    }
  }
  return acc;
}

// require('./x') / require('../lib/y'). Template literals and computed paths are
// skipped — they cannot be checked statically, and there are none today.
const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// Comments and quoted examples are not requires.
//
// Without this the check reports lib/brand.js as requiring './lib/brand' (from a
// comment listing its own callers) and tests/test_amanda_review.js as requiring
// '../minutes/standards' (from an assertion that greps source for that literal).
// A check that cries wolf gets skipped, and then it protects nothing.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))   // keep line count
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1);
}

// A require nested inside a string literal — assert(src.includes("require('x')"))
// — is the source being examined, not a dependency being declared.
function insideStringLiteral(src, index) {
  const before = src[index - 1];
  return before === '"' || before === "'" || before === '`';
}

function resolveTarget(fromFile, spec) {
  const base = path.resolve(ROOT, path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* next */ }
  }
  return null;
}

const trackedFiles = tracked();
const files = [...ENTRY_FILES, ...DIRS.flatMap((d) => walk(d))]
  .filter((f) => trackedFiles.has(f));   // only check code that ships

const missing = [];    // require target does not exist at all
const untracked = [];  // exists on disk but git does not have it

for (const file of files) {
  let src;
  try { src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch (_) { continue; }
  REQUIRE_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRE_RE.exec(src)) !== null) {
    if (insideStringLiteral(src, m.index)) continue;
    const spec = m[1];
    const target = resolveTarget(file, spec);
    if (!target) {
      missing.push({ file, spec });
      continue;
    }
    const rel = path.relative(ROOT, target).replace(/\\/g, '/');
    if (!trackedFiles.has(rel)) untracked.push({ file, spec, rel });
  }
}

if (!missing.length && !untracked.length) {
  console.log(`requires check: ok — every local require in ${files.length} shipped files resolves to a tracked file`);
  process.exit(0);
}

console.error('');
if (untracked.length) {
  console.error('✗ These requires resolve on this machine but are NOT in the repository.');
  console.error('  The server will throw MODULE_NOT_FOUND on boot and the deploy will exit 1.');
  console.error('');
  for (const u of untracked) {
    console.error(`    ${u.file}`);
    console.error(`      requires '${u.spec}'  ->  ${u.rel}   [on disk, not tracked]`);
    let why = '';
    try {
      why = execFileSync('git', ['check-ignore', '-v', u.rel], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (_) { /* not ignored — just never added */ }
    console.error(why
      ? `      ignored by ${why.split('\t')[0]}  — fix the rule, or: git add -f ${u.rel}`
      : `      never added — run: git add ${u.rel}`);
    console.error('');
  }
}
if (missing.length) {
  console.error('✗ These requires do not resolve to any file:');
  for (const x of missing) console.error(`    ${x.file} requires '${x.spec}'`);
  console.error('');
}
process.exit(1);
