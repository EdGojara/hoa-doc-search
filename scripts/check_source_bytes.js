// ============================================================================
// scripts/check_source_bytes.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// FAILS THE BUILD on control bytes and replacement characters in source.
//
// Not hypothetical tidiness. In one session the word-boundary escape in a
// single file was mangled into a literal backspace (0x08) FOUR times by editing
// tooling adding a layer of escaping, and once a UTF-8 em-dash was corrupted to
// 0x14 by a latin1 round-trip.
//
// It earns a build check because a broken word boundary fails SILENTLY. The
// pattern still compiles. It just matches nothing, so whatever it was doing
// quietly stops. The tests kept passing, because a substring comparison
// underneath happened to give the same answer for the cases written down. The
// only way to see it is to look at the bytes.
//
// Same shape as everything else found today: a stored message with no body, a
// signature filed under the wrong name, a draft filed under the wrong persona.
// All produced plausible output. None of them failed.
//
// Detection is by CODE POINT, not by a pattern containing the characters it
// looks for. The first version used a regex with a literal replacement
// character in it and failed its own check, which is funny once.
//
//   node scripts/check_source_bytes.js
//
// Tab (9), newline (10) and carriage return (13) are legal.
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['api', 'lib', 'scripts', 'tests'];

const REPLACEMENT_CHAR = 0xfffd; // U+FFFD, what a mangled encoding leaves behind
const LEGAL_CONTROL = new Set([9, 10, 13]);

function isBad(code) {
  if (code === REPLACEMENT_CHAR) return true;
  if (code === 0x7f) return true;
  return code < 0x20 && !LEGAL_CONTROL.has(code);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p, out); }
    else if (/\.(js|json|sql|md)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const failures = [];

for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const hits = [];
      for (let n = 0; n < line.length; n++) {
        const code = line.charCodeAt(n);
        if (isBad(code)) hits.push({ n, code });
      }
      if (!hits.length) return;
      failures.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: i + 1,
        codes: hits.map((h) => 'col ' + (h.n + 1) + ' = 0x' + h.code.toString(16).padStart(2, '0')).join(', '),
        // Render the offending characters visibly, or the report is as
        // invisible as the bug it is reporting.
        text: line.split('').map((c) => (isBad(c.charCodeAt(0)) ? '?' : c)).join('').trim().slice(0, 100),
      });
    });
  }
}

if (failures.length) {
  console.error('\ncontrol bytes or replacement characters in ' + failures.length + ' line(s):\n');
  for (const f of failures) console.error('  ' + f.file + ':' + f.line + '  (' + f.codes + ')\n    ' + f.text);
  console.error('\nThese are almost always a mangled escape. A word-boundary escape that became'
    + '\n0x08 turns into a backspace: the pattern still compiles, matches nothing, and'
    + '\nthe behaviour it provided silently disappears.'
    + '\n\nFix by rewriting the line with a tool that does not add an escaping layer, or'
    + '\nby dropping the escape entirely (token matching instead of a word boundary).\n');
  process.exit(1);
}

console.log('source bytes check: ok — no control bytes or replacement characters');
