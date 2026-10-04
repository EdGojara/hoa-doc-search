// ============================================================================
// scripts/check_test_network_guard.js — tests may not reach production.
// ----------------------------------------------------------------------------
// SCAR, 2026-10-04 (Issue #27 follow-up, PR #30). tests/test_ap_commit_review_flag.js
// loaded dotenv (real SUPABASE_URL/KEY) and faked @supabase/supabase-js only
// while the module under test loaded. lib/capture_error.js builds its own
// client, so a local run wrote 8 rows to PRODUCTION system_errors. That table is
// append-only (mig 264): the rows are permanent. The write was swallowed, so
// the test passed. When the guard was first switched on it found 28 more checks
// touching the network, two of them unit tests leaking the same way.
//
// The control is tests/_support/no_prod_network.js, preloaded into every check
// by scripts/run_all_tests.js. This check keeps that control from rotting:
//   1. the guard actually refuses (live self-test, nothing leaves the machine:
//      the target is a .invalid host);
//   2. run_all_tests.js still preloads it into every check;
//   3. a test that fakes @supabase/supabase-js requires the guard itself, so a
//      direct `node tests/x.js` is protected too, not just `npm test`;
//   4. a test that fakes a client AND loads dotenv is a reviewed hybrid: it
//      uses _support/live_readonly and is listed in LIVE_READ_CHECKS;
//   5. scripts/test_network_policy.js names only real, runnable checks, and no
//      check is both read-only and write.
//
// Run: npm run test:network-guard   (wired into npm test)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { LIVE_READ_CHECKS, LIVE_WRITE_CHECKS } = require('./test_network_policy');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'tests', '_support', 'no_prod_network.js');
const problems = [];
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ---- 1. the guard refuses, and fails the process even if the error is swallowed
{
  const probe = `
    fetch('https://guard-selftest.invalid/rest/v1/system_errors', { method: 'POST' }).catch(() => {});
    try { require('https').request({ host: 'guard-selftest.invalid', method: 'POST', path: '/' }); } catch (_) {}
    setTimeout(() => process.exit(0), 50);`;
  const r = spawnSync(process.execPath, ['-r', GUARD, '-e', probe], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, TEST_NO_PROD: '1', TEST_NO_PROD_REPORT: '' },
  });
  if (r.status === 0 || !/TEST_NO_PROD: this test tried to reach the network 2 time/.test(r.stderr || '')) {
    problems.push(`the guard did not refuse a swallowed POST to a non-local host (exit ${r.status}). The control is not running.`);
  }
  const ro = spawnSync(process.execPath, ['-r', GUARD, '-e',
    "fetch('https://guard-selftest.invalid/rest/v1/x', { method: 'PATCH' }).catch(() => {}); setTimeout(() => process.exit(0), 50);"], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, TEST_NO_PROD: 'readonly', SUPABASE_URL: 'https://guard-selftest.invalid', TEST_NO_PROD_REPORT: '' },
  });
  if (ro.status === 0) problems.push('readonly mode allowed a PATCH to the Supabase host. Live-read checks could write production.');
}

// ---- 2. the runner still preloads the guard into every check
const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run_all_tests.js'), 'utf8');
if (!/no_prod_network\.js/.test(runnerSrc) || !/NODE_OPTIONS:[^\n]*--require/.test(runnerSrc) || !/TEST_NO_PROD:/.test(runnerSrc)) {
  problems.push('scripts/run_all_tests.js no longer preloads tests/_support/no_prod_network.js into every check.');
}
const CHECKS = [...runnerSrc.slice(0, runnerSrc.indexOf('];')).matchAll(/^\s*'([^']+\.(?:m?js))'/gm)].map((m) => m[1]);

// ---- 3 + 4. per-test rules
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'fixtures' || e.name === '_support') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const liveRead = new Set(LIVE_READ_CHECKS);
for (const file of walk(path.join(ROOT, 'tests'))) {
  const src = fs.readFileSync(file, 'utf8');
  const r = rel(file);
  const fakesSupabase = /['"]@supabase\/supabase-js['"]/.test(src) && /Module\._load|require\.cache/.test(src);
  const loadsDotenv = /require\(\s*['"]dotenv['"]\s*\)|['"]dotenv\/config['"]/.test(src);
  const usesGuard = /_support\/no_prod_network['"]/.test(src);
  const usesLiveRO = /_support\/live_readonly['"]/.test(src);
  if (fakesSupabase && !usesGuard && !usesLiveRO) {
    problems.push(`${r} fakes @supabase/supabase-js but does not load the guard (tests/_support/no_prod_network.js) at the top. ` +
      'Any other module that builds its own client would reach production when the test is run directly.');
  }
  if (fakesSupabase && loadsDotenv && !(usesLiveRO && liveRead.has(r))) {
    problems.push(`${r} fakes @supabase/supabase-js AND loads dotenv (real keys). That is the exact 2026-10-04 leak. ` +
      'Drop dotenv, or if it truly reads live data, use _support/live_readonly and list it in LIVE_READ_CHECKS.');
  }
  if (usesLiveRO && !liveRead.has(r)) {
    problems.push(`${r} uses _support/live_readonly but is not in LIVE_READ_CHECKS (scripts/test_network_policy.js).`);
  }
}

// ---- 5. the policy names only real checks
for (const [name, list] of [['LIVE_READ_CHECKS', LIVE_READ_CHECKS], ['LIVE_WRITE_CHECKS', LIVE_WRITE_CHECKS]]) {
  for (const c of list) {
    if (!fs.existsSync(path.join(ROOT, c))) problems.push(`${name} names ${c}, which does not exist.`);
    else if (!CHECKS.includes(c)) problems.push(`${name} names ${c}, which is not in run_all_tests.js CHECKS.`);
    if (name === 'LIVE_READ_CHECKS' && LIVE_WRITE_CHECKS.includes(c)) problems.push(`${c} is in both LIVE_READ_CHECKS and LIVE_WRITE_CHECKS.`);
  }
}

if (problems.length) {
  console.error('\n✗ Test network guard:\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n  See tests/_support/no_prod_network.js for the scar.\n');
  process.exit(1);
}
console.log(`✓ Test network guard: guard refuses, runner preloads it, ${CHECKS.length} checks scanned, ` +
  `${LIVE_READ_CHECKS.length} live-read and ${LIVE_WRITE_CHECKS.length} live-write exceptions all valid.`);
