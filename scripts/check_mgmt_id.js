// ============================================================================
// scripts/check_mgmt_id.js  (2026-09-20)  — wired into `npm test`
// ----------------------------------------------------------------------------
// The Bedrock management-company id is defined ONCE, in lib/company.js, and
// imported everywhere in runtime app code. This check FAILS THE BUILD if the raw
// UUID literal reappears anywhere in api/ or lib/ or server.js, so the 70-file
// duplication we just consolidated cannot silently return.
//
// Deliberately NOT scanned (the literal legitimately appears there as historical
// data, not as a re-typed runtime constant): migrations/ (seed rows), scripts/
// (one-off seed/import tools), tests/ and fixtures (query params / expected data).
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UUID = '00000000-0000-0000-0000-000000000001';
const ALLOWED = path.resolve(ROOT, 'lib', 'company.js');

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (n.endsWith('.js')) out.push(p);
  }
}

const files = [];
walk(path.join(ROOT, 'api'), files);
walk(path.join(ROOT, 'lib'), files);
files.push(path.join(ROOT, 'server.js'));

const bad = [];
// scripts/ and tests/ are exempt ONLY because they are non-runtime (operator
// tools / fixtures), never loaded by the running server. That exemption is only
// safe while it stays true, so we also assert no runtime module imports a
// script — otherwise a script would become production-reachable and could
// reintroduce the literal through the back door.
const scriptImports = [];
const SCRIPT_REQUIRE = /require\(\s*['"][^'"]*\/scripts\/[^'"]+['"]\s*\)|require\(\s*['"]\.\.?\/scripts\/[^'"]+['"]\s*\)/;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (path.resolve(f) !== ALLOWED && src.includes(UUID)) bad.push(path.relative(ROOT, f));
  if (SCRIPT_REQUIRE.test(src)) scriptImports.push(path.relative(ROOT, f));
}

let failed = false;
if (bad.length) {
  failed = true;
  console.error('✗ management-company id: the UUID literal must live ONLY in lib/company.js. Found in:');
  bad.forEach((f) => console.error('   - ' + f));
  console.error("  Fix: const { BEDROCK_MGMT_CO_ID } = require('<rel>/lib/company');");
}
if (scriptImports.length) {
  failed = true;
  console.error('✗ management-company id: runtime code must NOT import from scripts/ (scripts are exempt only because they are non-runtime). Found in:');
  scriptImports.forEach((f) => console.error('   - ' + f));
}
if (failed) process.exit(1);
console.log('✓ management-company id: single source (lib/company.js); no duplicated literals in app runtime; scripts stay non-runtime');
