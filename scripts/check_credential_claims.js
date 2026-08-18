#!/usr/bin/env node
// ============================================================================
// check_credential_claims.js  (Ed 2026-08-18)
// ----------------------------------------------------------------------------
// FAILS THE BUILD when a professional credential is named in copy a CUSTOMER
// reads: board decks, proposals, contracts, letters, emails, portal pages.
//
// WHY THIS IS A CHECK AND NOT A NOTE IN CLAUDE.md
// Ed's rule: "the FIRST time a scar recurs, convert it into enforcement." This
// language had spread to five separate places (both decks twice over, a
// positioning paragraph, a module bullet) and prose in CLAUDE.md would not have
// caught the sixth. Marketing copy is written fast and by whoever is closest to
// the deadline, which is exactly when a rule that lives in someone's memory
// fails.
//
// WHY IT MATTERS — two distinct exposures:
//   1) TITLE USE. Bedrock Association Management LLC is not a licensed CPA
//      firm. The AICPA and the Texas State Board of Public Accountancy are
//      strict about advertising the CPA designation, and holding out the title
//      through an entity that is not a licensed firm is a problem on its own,
//      independent of whatever the surrounding sentence claims.
//   2) FALSE ASSURANCE. "CPA-grade", "audit-ready", "fraud examiner" invite a
//      board to believe its books are audited or that fraud detection is part
//      of the engagement. Neither is what a management agreement provides. A
//      board that relied on that reading has a grievance we handed them.
//
// WHAT THIS DOES **NOT** TOUCH — and deliberately so.
// The encoded judgment stays. The multi-lens analysis, the CPA/CFE framing
// inside AI system prompts, the fraud-pattern heuristics: all of that is the
// moat and it keeps running. Ed 2026-08-18: "we want all the lenses and my DNA,
// just not out there so much." So this check scans OUTPUT surfaces only. It
// never looks at api/, the judgment engine, or the prompts that steer it.
//
// Escape hatch: put `credential-ok` in a comment on the offending line when a
// mention is genuinely necessary and lawful (e.g. quoting a third party's own
// audited financials).
//
//   node scripts/check_credential_claims.js        # or: npm run test:credentials
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Surfaces whose words reach a customer. Adding a new one here is the point:
// if you build a new outward-facing renderer, register it.
const SCAN_DIRS = [
  'lib/presentations',
  'lib/contracts',
  'lib/correspondence',
  'lib/email',
  'lib/notifications',
  'lib/board_package',
  'templates',
];
const SCAN_FILES = [
  'lib/builder_letter.js',
  'public/portal.html',
  'public/board-portal.html',
  'public/legal-disclosures.html',
];
const EXTS = new Set(['.js', '.html', '.md', '.txt', '.json']);

// Precise on purpose. A control that fires on everything gets ignored, so this
// targets the self-claim, not every appearance of the word "audit" (an
// association's own third-party audit is a legitimate thing to reference).
// \bCPA\b does not match inside FDCPA — the preceding D is a word character.
const PATTERNS = [
  { re: /\bCPAs?\b/,                     why: 'CPA title in customer-facing copy' },
  { re: /certified public accountant/i,   why: 'CPA title spelled out' },
  { re: /\bCFEs?\b/,                     why: 'CFE title in customer-facing copy' },
  { re: /certified fraud examiner/i,      why: 'CFE title spelled out' },
  { re: /fraud examiner/i,                why: 'implies fraud-examination services' },
  { re: /audit partner/i,                 why: 'implies public-accounting practice' },
  { re: /audit[- ]ready/i,                why: 'implies an audit opinion is in scope' },
  { re: /CPA[- ]grade/i,                  why: 'implies assurance-level work' },
  { re: /attorney'?s eye/i,               why: 'implies legal services / holding out to practice' },
  { re: /forensic account/i,              why: 'implies forensic accounting services' },
  { re: /\bwe audit\b|\bour audit of\b/i, why: 'claims an audit engagement' },
];

// Strip comments so our own explanatory notes (and this file's header) never
// trip the check — only real copy counts.
function stripComments(src, ext) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (ext === '.html' || ext === '.md') {
    out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  }
  return out
    .split('\n')
    .map((line) => {
      // Blank out a // comment, but not one inside an obvious URL.
      const i = line.indexOf('//');
      if (i === -1) return line;
      if (/https?:$/.test(line.slice(0, i + 1).trim().slice(-6))) return line;
      return line.slice(0, i);
    })
    .join('\n');
}

function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, acc); }
    else if (EXTS.has(path.extname(e.name))) acc.push(p);
  }
  return acc;
}

const files = [];
SCAN_DIRS.forEach((d) => walk(path.join(ROOT, d), files));
SCAN_FILES.forEach((f) => { const p = path.join(ROOT, f); if (fs.existsSync(p)) files.push(p); });

const hits = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs);
  const rawLines = raw.split('\n');
  const codeLines = stripComments(raw, ext).split('\n');
  codeLines.forEach((line, i) => {
    if (!line.trim()) return;
    // Honour the escape hatch on the ORIGINAL line (it lives in a comment).
    if (/credential-ok/.test(rawLines[i] || '')) return;
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        hits.push({ rel, line: i + 1, match: m[0], why: p.why, text: rawLines[i].trim().slice(0, 120) });
        break;
      }
    }
  });
}

if (hits.length) {
  console.error(`\n✗ ${hits.length} professional-credential claim(s) in customer-facing copy:\n`);
  for (const h of hits) {
    console.error(`  ${h.rel}:${h.line}  "${h.match}" — ${h.why}`);
    console.error(`      ${h.text}`);
  }
  console.error('\n  Bedrock Association Management LLC is not a licensed CPA firm. The AICPA and');
  console.error('  the Texas State Board are strict about advertising the designation, and');
  console.error('  "CPA-grade" / "audit-ready" / "fraud examiner" also invite a board to think its');
  console.error('  books are audited or that fraud detection is in scope. Neither is true of a');
  console.error('  management engagement.');
  console.error('\n  Fix: claim the SYSTEM, not the credential. Name the question the work answers');
  console.error('  ("do the numbers add up", "every figure traceable to its source document")');
  console.error('  instead of the license behind it. The encoded lenses and prompts are');
  console.error('  untouched by this check — keep them.');
  console.error('\n  Genuinely lawful mention? Put `credential-ok` in a comment on that line.\n');
  process.exit(1);
}

console.log(`✓ No professional-credential claims in customer-facing copy (${files.length} files scanned).`);
