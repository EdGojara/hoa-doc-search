// ============================================================================
// scripts/check_stored_email_body.js  (Ed 2026-08-20)
// ----------------------------------------------------------------------------
// FAILS THE BUILD if a message row is written with body_preview and no
// body_full.
//
// Why this is a check and not a paragraph in CLAUDE.md: the class was audited
// once and turned up SEVEN sites. graph_ingest computed body_full and left it
// out of the insert row; api/tessa wrote Ed's own sent mail as a 2,000
// character stub; billing, email_intake, homeowner_360 and the triage compose
// path each did the same; ea_inbox had no column for it at all. Result was 980
// of 1,053 stored messages with no body, 824 of them in the main homeowner
// inbox.
//
// It is worth a build check specifically because NOTHING GOES WRONG when it
// breaks. There is no exception, no empty screen, no failed save. A draft
// written from the first 255 characters of a homeowner's email is fluent,
// confident and answers the wrong question, and the only way anyone finds out
// is a person reading the reply and knowing what the customer actually asked.
// CLAUDE.md's rule for a scar that recurs is to make it fail loudly on its own.
//
//   node scripts/check_stored_email_body.js
//
// Deliberate exception: put `// body-full-ok` on the body_preview line.
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['api', 'lib'];
// Tables whose rows represent a received or sent message.
const TABLES = ['email_messages', 'ea_inbox'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(p, out); }
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const failures = [];

for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;

  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8');
    // Only files that actually write one of these tables.
    if (!TABLES.some((t) => src.includes(`'${t}'`) || src.includes(`"${t}"`))) continue;
    const lines = src.split(/\r?\n/);

    lines.forEach((line, i) => {
      if (!/\bbody_preview\s*:/.test(line)) return;
      if (/body-full-ok/.test(line)) return;
      // A property read (passing a row along) is not a write.
      if (/body_preview:\s*[a-zA-Z_$][\w$]*\.body_preview\s*[,}]/.test(line) && !/insert|upsert|update/.test(line)) {
        // Still checked below by the window scan — a pass-through inside an
        // insert object is exactly how homeowner_360 lost the body.
      }

      // body_full may legitimately sit on a nearby line of the same object
      // literal, so look at the surrounding window rather than the one line.
      const from = Math.max(0, i - 12);
      const to = Math.min(lines.length, i + 13);
      const window = lines.slice(from, to).join('\n');
      if (/\bbody_full\s*:/.test(window)) return;

      // Confirm this window really is a write to one of the tables.
      const wideFrom = Math.max(0, i - 30);
      const wide = lines.slice(wideFrom, to).join('\n');
      const writesTable = TABLES.some((t) =>
        new RegExp(`from\\((['"\`])${t}\\1\\)[\\s\\S]{0,400}?\\.(insert|upsert|update)\\b`).test(wide)
        || new RegExp(`\\.(insert|upsert|update)\\b[\\s\\S]{0,400}?from\\((['"\`])${t}\\2\\)`).test(wide));
      if (!writesTable) return;

      failures.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: i + 1,
        text: line.trim().slice(0, 110),
      });
    });
  }
}

if (failures.length) {
  console.error(`\nbody_full missing on ${failures.length} message write(s):\n`);
  for (const f of failures) console.error(`  ${f.file}:${f.line}\n    ${f.text}`);
  console.error(`
Every row written to ${TABLES.join(' / ')} must store the whole message, not
just body_preview. A stored message is read back by drafting, review, search
and the 360 timeline; with only the preview those all reason about the first
few hundred characters and produce confident, wrong output with no error.

Add  body_full: <the full text>  to the same object. If the row genuinely has
no body, put  // body-full-ok  on the body_preview line and say why.
`);
  process.exit(1);
}

console.log('body_full check: ok — every message write stores the full body');
