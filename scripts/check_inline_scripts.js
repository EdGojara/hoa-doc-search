// ============================================================================
// scripts/check_inline_scripts.js  (Issue #14 scar, 2026-10-02)
// ----------------------------------------------------------------------------
// Parses every inline <script> in public/**/*.html and FAILS on a syntax error.
//
// Scar: one bad quote in a vendor-spend message (a `${...}` inside a plain
// '...' string) made the browser drop the whole 9,500-line script block that
// defines switchTab. Every tab in the main app stopped working, and nothing
// on the server noticed: tests passed, /version was green. A syntax error in
// an inline block is silent until someone clicks.
//
// Skips <script src=...>, non-JS types (JSON, templates), and module scripts
// are parsed as modules. HTML comments are stripped first so a comment that
// mentions "<script>" is not mistaken for a block.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'public');
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

function htmlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Blank HTML comments but keep newlines so reported line numbers stay true.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));

function checkFile(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const errors = []; let m; let blocks = 0;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = ((/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '').toLowerCase();
    if (!JS_TYPES.has(type)) continue;
    blocks++;
    const startLine = src.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
    try {
      if (type === 'module') new vm.SourceTextModule ? new vm.SourceTextModule(m[2]) : new vm.Script(m[2]);
      else new vm.Script(m[2], { filename: file });
    } catch (e) {
      if (type === 'module' && /import|export/.test(e.message)) continue; // module syntax outside --experimental-vm-modules
      const at = /:(\d+)\n/.exec(e.stack || '');
      const line = at ? startLine + Number(at[1]) - 1 : startLine;
      errors.push(`${path.relative(path.join(__dirname, '..'), file)}:${line}  ${e.message}`);
    }
  }
  return { blocks, errors };
}

let total = 0; const errors = [];
for (const f of htmlFiles(ROOT)) { const r = checkFile(f); total += r.blocks; errors.push(...r.errors); }
if (errors.length) {
  console.log('✗ Inline <script> syntax errors (the browser drops the WHOLE block; every function in it is undefined):');
  for (const e of errors) console.log('    ' + e);
  process.exit(1);
}
console.log(`✓ Inline scripts: ${total} blocks parse cleanly.`);
