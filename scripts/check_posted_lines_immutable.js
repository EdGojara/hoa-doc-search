#!/usr/bin/env node
// ============================================================================
// scripts/check_posted_lines_immutable.js  (Ed 2026-10-09)
// ----------------------------------------------------------------------------
// A POSTED journal entry's lines are permanent. No application workflow may
// delete or rewrite them, in an open period or a closed one. A wrong posted
// entry is corrected by a new entry (lib/accounting/correct_entry.js).
//
// THE SCAR (2026-09-28/29, Lakes of Pine Forest): the AP re-code ran
// "delete journal_entry_lines; delete journal_entries" on four POSTED Barker
// Cypress MUD accruals. The header delete was refused by a foreign key and the
// error was never read, so JE-2026-00169..00172 kept their headers and lost
// every line. That code compiled, passed review and ran in production; a prose
// rule would not have stopped it. This check does.
//
// It fails the build when application code (api/, lib/, server.js) contains:
//   * .from('journal_entry_lines') ... .delete( / .update( / .upsert(
//   * .from('journal_entries') ... .delete(
//   * raw SQL: DELETE FROM / UPDATE / TRUNCATE journal_entry_lines, DELETE FROM journal_entries
// Header UPDATEs (the void flip, document links, review flags) are allowed.
// A deliberate exception must say why on the SAME line:
//     // posted-lines-ok: <reason it can never touch a posted entry's lines>
// scripts/ is excluded: one-off operator scripts, not application workflows.
//   npm run test:posted-lines
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['api', 'lib', 'server.js'];

function files(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return /\.(c|m)?js$/.test(rel) ? [rel] : [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    return files(`${rel}/${e.name}`);
  });
}

// Returns [{ file, line, text }] for every violation in one source string.
function scan(rel, src) {
  const out = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const lineText = (n) => src.split('\n')[n - 1] || '';
  const okOn = (n) => /\/\/\s*posted-lines-ok:\s*\S/.test(lineText(n));
  // Query-builder chains: from the .from(...) to the end of the statement.
  const re = /\.from\(\s*(['"`])(journal_entry_lines|journal_entries)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const end = rest.search(/;|\n\s*\n/);
    const chain = end < 0 ? rest : rest.slice(0, end);
    const bad = m[2] === 'journal_entry_lines' ? /\.(delete|update|upsert)\s*\(/.exec(chain) : /\.(delete)\s*\(/.exec(chain);
    if (!bad) continue;
    const n = lineAt(m.index);
    if (okOn(n)) continue;
    out.push({ file: rel, line: n, text: `${m[2]}.${bad[1]}()` });
  }
  const sql = /\b(DELETE\s+FROM\s+journal_entry_lines|UPDATE\s+journal_entry_lines|TRUNCATE\s+(TABLE\s+)?journal_entry_lines|DELETE\s+FROM\s+journal_entries)\b/gi;
  while ((m = sql.exec(src))) {
    const n = lineAt(m.index);
    if (okOn(n)) continue;
    out.push({ file: rel, line: n, text: m[1] });
  }
  return out;
}

function run() {
  const violations = [];
  for (const t of TARGETS) for (const f of files(t)) violations.push(...scan(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
  return violations;
}

if (require.main === module) {
  const v = run();
  if (v.length) {
    console.error('✗ Posted journal-entry lines must never be deleted or rewritten by application code.');
    console.error('  Correct a posted entry with a new entry (lib/accounting/correct_entry.js voidLiveEntry + a replacement).');
    for (const x of v) console.error(`    ${x.file}:${x.line}  ${x.text}`);
    console.error('  A deliberate exception needs "// posted-lines-ok: <reason>" on the same line.');
    process.exitCode = 1;
  } else {
    console.log('✓ No application code deletes or rewrites journal entry lines (api/, lib/, server.js).');
  }
}

module.exports = { scan, run };
