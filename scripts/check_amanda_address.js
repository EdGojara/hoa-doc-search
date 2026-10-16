#!/usr/bin/env node
// ============================================================================
// scripts/check_amanda_address.js  (Ed 2026-10-16): Amanda's address stays central
// ----------------------------------------------------------------------------
// Amanda's public address is ONE setting, AMANDA_PUBLIC_EMAIL in
// lib/email/graph_send.js (default amanda@bedrocktx.com). amandaalbright@ is her
// Microsoft 365 mailbox identity (AMANDA_MAILBOX), used only for Graph.
// Fails the build when a string literal anywhere else hard-codes either address:
//   - "amandaalbright@..."  (the mailbox identity leaking into a template), or
//   - "amanda@bedrocktx.com" (the public address copied instead of read).
// Comments are ignored. Allowlist: graph_send.js (the constants), tests/, and
// demo fixtures. A line that genuinely must carry one adds `// amanda-address-ok`
// with a reason. Scans api/, lib/, public/, scripts/, templates/, server.js
// (.js .mjs .cjs .html, plus .json under scripts/plans and templates, where
// generated documents such as RFPs keep their contact text).
// Usage: node scripts/check_amanda_address.js [root]
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const ALLOW = [
  /^lib\/email\/graph_send\.js$/,       // AMANDA_MAILBOX / AMANDA_PUBLIC_EMAIL defaults
  /^scripts\/check_amanda_address\.js$/, // this check
  /^tests\//,
  /^public\/app\/fixtures\//,           // demo fixture data, never sent
];
const LITERAL = /(['"`])(?:(?!\1).)*?(amandaalbright@|amanda@bedrocktx\.com)/i;

function walk(dir, out, root = ROOT) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', '.claude'].includes(e.name)) walk(p, out, root); continue; }
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (/\.(js|mjs|cjs|html)$/.test(e.name) || (/\.json$/.test(e.name) && /^(scripts\/plans|templates)\//.test(rel))) out.push(p);
  }
  return out;
}

// Drop comments so prose about the two addresses never trips the check.
function code(line, state) {
  let s = line;
  if (state.block) { const end = s.indexOf('*/'); if (end < 0) return ''; s = s.slice(end + 2); state.block = false; }
  s = s.replace(/\/\*.*?\*\//g, '');
  const open = s.search(/(^|\s)\/\*/); if (open >= 0) { state.block = true; s = s.slice(0, open); }
  const c = s.search(/(^|\s)\/\/(?!\/)/); if (c >= 0) s = s.slice(0, c);
  s = s.replace(/<!--.*?-->/g, '');
  return /^\s*\*/.test(s) ? '' : s;
}

function scan(root = ROOT) {
  const files = [];
  for (const d of ['api', 'lib', 'public', 'scripts', 'templates']) walk(path.join(root, d), files, root);
  if (fs.existsSync(path.join(root, 'server.js'))) files.push(path.join(root, 'server.js'));
  const problems = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (ALLOW.some((re) => re.test(rel))) continue;
    const json = /\.json$/.test(rel);
    const state = { block: false };
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((ln, i) => {
      if (/amanda-address-ok/.test(ln)) return;
      const m = LITERAL.exec(json ? ln : code(ln, state));
      if (m) problems.push(`${rel}:${i + 1} hard-coded ${m[2]} (read AMANDA_PUBLIC_EMAIL / AMANDA_MAILBOX from lib/email/graph_send.js, or /team-identity.js in a page): ${ln.trim().slice(0, 110)}`);
    });
  }
  return problems;
}

if (require.main === module) {
  const problems = scan();
  if (problems.length) {
    console.error('✗ Amanda address check failed:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('✓ Amanda address check: no hard-coded amanda@ / amandaalbright@ outside the allowlist');
}

module.exports = { scan };
