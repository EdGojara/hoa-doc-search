#!/usr/bin/env node
// ============================================================================
// scripts/check_retrieval_truncation.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// Fails the build if a getRelevantChunks() result is sliced below the full
// retrieved set. getRelevantChunks already self-limits to its top ~18 chunks
// (~20k chars, ranked). A SMALLER `.slice(0, N)` silently drops provisions that
// ranked past the cutoff — the Waterview corner-lot tree miss (2026-09-08): the
// rule "corner lots need two additional side-street trees" sat at char 10,487 of
// a 20k retrieval, and a `.slice(0, 9000)` dropped it before the model ever saw
// it, so the drafter confidently answered "two trees" for a four-tree lot.
//
// Rule: any `.slice(0, N)` applied to a getRelevantChunks() result with
// N < 20000 fails. Raise it (the retriever bounds itself) or add `// truncate-ok`
// on the line if the truncation is genuinely intended (e.g. a short log sample).
// ============================================================================
const fs = require('fs');
const path = require('path');

const SAFE_MIN = 20000;
const ROOTS = ['lib', 'api', 'server.js'];

function walk(p, out = []) {
  let st; try { st = fs.statSync(p); } catch { return out; }
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) { if (e === 'node_modules') continue; walk(path.join(p, e), out); } }
  else if (p.endsWith('.js')) out.push(p);
  return out;
}

const cwd = process.cwd();
const files = ROOTS.flatMap((r) => { const p = path.join(cwd, r); return fs.existsSync(p) ? walk(p) : []; });
const violations = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split(/\r?\n/);
  // variables in THIS file that hold a getRelevantChunks result
  const vars = new Set();
  for (const m of src.matchAll(/\b(\w+)\s*=\s*(?:await\s+)?\(?\s*(?:await\s+)?getRelevantChunks\s*\(/g)) vars.add(m[1]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/truncate-ok/.test(line)) continue;
    // inline: (await getRelevantChunks(...) || '').slice(0, N)
    const inline = /getRelevantChunks\s*\([\s\S]*?\.slice\(\s*0\s*,\s*(\d+)\s*\)/.exec(line);
    if (inline && Number(inline[1]) < SAFE_MIN) { violations.push({ f, i: i + 1, n: inline[1], line: line.trim() }); continue; }
    // cross-line: a getRelevantChunks-derived variable sliced small
    for (const v of vars) {
      const m = new RegExp('\\b' + v + '\\b[^\\n]*?\\.slice\\(\\s*0\\s*,\\s*(\\d+)\\s*\\)').exec(line);
      if (m && Number(m[1]) < SAFE_MIN) { violations.push({ f, i: i + 1, n: m[1], line: line.trim() }); break; }
    }
  }
}

if (violations.length) {
  console.error('Retrieval-truncation check FAILED — a getRelevantChunks() result is sliced below the full retrieved set,\nwhich silently drops governing-doc provisions ranked past the cutoff (the Waterview corner-lot tree miss):\n');
  for (const v of violations) console.error(`  ${path.relative(cwd, v.f)}:${v.i}  .slice(0, ${v.n})\n      ${v.line}`);
  console.error(`\nRaise the slice to >= ${SAFE_MIN} (getRelevantChunks already self-limits to its top chunks), or add \`// truncate-ok\` on the line if the truncation is genuinely intended.`);
  process.exit(1);
}
console.log(`Retrieval-truncation check passed (${files.length} files scanned).`);
