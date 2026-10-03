// ============================================================================
// tests/onboarding_quail_ridge_local.js  (Issue #15)
// ----------------------------------------------------------------------------
// Runs the read-only onboarding stages 0-2 against Ed's REAL Quail Ridge
// package (Quail_Ridge_Claude_Migration_Package.zip) when it is present on
// this machine, and asserts the authoritative 7/31/2026 controls from the
// issue. The package contains homeowner data, so it is NEVER committed: the
// repo is public. Without the ZIP this test SKIPs (exit 0).
//   ONBOARDING_QR_ZIP=<path>  overrides the default Downloads location.
// Prints control codes and amounts only, never names or addresses.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../lib/onboarding/stages');
const E = require('../lib/onboarding/engine');
const { makeArtifact } = require('../lib/onboarding/artifacts');

const ZIP = process.env.ONBOARDING_QR_ZIP || path.join(os.homedir(), 'Downloads', 'Quail_Ridge_Claude_Migration_Package.zip');
if (!fs.existsSync(ZIP)) { console.log('SKIP  Quail Ridge onboarding fixture (package not on this machine)'); process.exit(0); }
let unzipOk = true; try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch (_) { unzipOk = false; }
if (!unzipOk) { console.log('SKIP  Quail Ridge onboarding fixture (unzip not available)'); process.exit(0); }
const read = (p) => execFileSync('unzip', ['-p', ZIP, `quail_ridge_claude_package/${p}`], { maxBuffer: 64e6 });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '\n      ' + x : '')); } };
const QR = 'a0000000-0000-4000-8000-000000000005';
const HUMAN = { kind: 'human', id: 'ed' };
const agent = (stage) => ({ kind: 'agent', id: 'claude', assigned_stage: stage });

const manifest = JSON.parse(read('manifest.json'));
const sha = (p) => manifest.find((m) => m.path === p).sha256;
const TEXT = { gl_trial_balance: 'extracted_text/gl_trial_balance.txt', balance_sheet: 'extracted_text/balance_sheet.txt', ar_aging: 'extracted_text/ar_aging.txt', homeowner_transactions: 'extracted_text/homeowner_transactions.txt' };
const PDF = { gl_trial_balance: 'original_vantaca_reports/GLTrialBalance (16).pdf', balance_sheet: 'original_vantaca_reports/BalanceSheet (18).pdf', ar_aging: 'original_vantaca_reports/AR Aging (8).pdf', homeowner_transactions: 'original_vantaca_reports/TransactionHistoryAssoc (3).pdf' };

console.log('Onboarding engine × Quail Ridge 7/31/2026 package (read-only)');
let state = S.newBatchState({ batch_code: 'CONV-QR-20260731-DRYRUN', community_id: QR, source_system: 'vantaca' });

// Stage 0: originals + derived text, each hashed; manifest must agree.
const inputs = [];
for (const [type, p] of Object.entries(PDF)) inputs.push({ buffer: read(p), meta: { artifact_type: `${type}_pdf`, filename: path.basename(p), cutoff_date: '2026-07-31' } });
for (const [type, p] of Object.entries(TEXT)) inputs.push({ buffer: read(p), meta: { artifact_type: type, filename: p, cutoff_date: '2026-07-31', derived_from_sha256: sha(PDF[type]) } });
const i0 = E.runIntake(state, agent('intake'), inputs);
check('stage 0: 8 artifacts registered, no duplicates', i0.result.status === 'PASS' && i0.artifacts.length === 8);
check('stage 0: every artifact hash equals the package manifest', i0.artifacts.every((a) => a.sha256 === sha(a.filename.includes('/') ? a.filename : Object.values(PDF).find((p) => p.endsWith(a.filename)))));
state = S.advance(i0.state, HUMAN, 'normalize');

// Stage 1: Vantaca adapter on the original-report text.
const texts = i0.artifacts.filter((a) => TEXT[a.artifact_type]).map((a) => ({ artifact: a, buffer: inputs.find((x) => x.meta.filename === a.filename).buffer }));
const n1 = E.runNormalize(state, agent('normalize'), texts);
for (const c of n1.extraction) check(`stage 1 extraction: ${c.code}`, c.status === 'PASS', JSON.stringify(c.failures || c).slice(0, 300));
const glTx = n1.parsed.gl_trial_balance.rows.filter((r) => r.domain === 'gl_transaction').length;
check(`stage 1: GL transaction lines read = 1,162 (package CSV had 1,148 incl. misreads; 48 dropped)`, glTx === 1162, String(glTx));
// Regression: the package's own normalized gl_transactions.csv (48 rows dropped) must FAIL against the original GL.
{
  let st2 = S.newBatchState({ batch_code: 'CONV-QR-CSV-CHECK', community_id: QR, source_system: 'vantaca' });
  const ins = [{ buffer: read(TEXT.gl_trial_balance), meta: { artifact_type: 'gl_trial_balance', filename: TEXT.gl_trial_balance, cutoff_date: '2026-07-31' } },
    { buffer: read('gl_transactions.csv'), meta: { artifact_type: 'gl_transactions_csv', filename: 'gl_transactions.csv', cutoff_date: '2026-07-31' } }];
  const a0 = E.runIntake(st2, agent('intake'), ins); st2 = S.advance(a0.state, HUMAN, 'normalize');
  const b1 = E.runNormalize(st2, agent('normalize'), a0.artifacts.map((a, k) => ({ artifact: a, buffer: ins[k].buffer })));
  const c = b1.extraction.find((x) => x.code === 'gl_transactions_csv.ties_to_printed_account_totals');
  const csvDefects = b1.extraction.find((x) => x.code === 'gl_transactions_csv.no_unreadable_lines');
  check(`regression: the package gl_transactions.csv FAILS against the original GL (accounts ${c.failures.map((f) => f.account).join(', ')}; unreadable rows ${csvDefects.failures.length})`,
    c.status === 'FAIL' && ['1000', '1100', '1300', '2300', '4100'].every((a) => c.failures.some((f) => f.account === a)) && b1.result.status === 'FAIL');
}
state = S.advance(n1.state, HUMAN, 'source_controls');

// Stage 2: authoritative controls (from the issue) + provider-agnostic + Vantaca mechanics.
const g = (code) => (p, { glEnd }) => glEnd(code);
const bsTotal = (sec) => (p, { bs }) => bs.filter((r) => r.section === sec).reduce((s, r) => s + r.amount_cents, 0);
const expected = {
  gl_total_debits: { label: 'GL total debits = 139,282.37', cents: 13928237, derive: (p, { bal }) => bal.reduce((s, r) => s + r.debit_cents, 0) },
  gl_total_credits: { label: 'GL total credits = 139,282.37', cents: 13928237, derive: (p, { bal }) => bal.reduce((s, r) => s + r.credit_cents, 0) },
  ar: { label: 'AR 1300 = 19,767.91', cents: 1976791, derive: g('1300') },
  cash: { label: 'Operating cash 1000 = 41,706.66', cents: 4170666, derive: g('1000') },
  savings: { label: 'Savings 1100 = 3,011.99', cents: 301199, derive: g('1100') },
  assets: { label: 'Total assets = 57,608.18', cents: 5760818, derive: bsTotal('assets') },
  liabilities: { label: 'Total liabilities = 9,713.60', cents: 971360, derive: bsTotal('liabilities') },
  equity: { label: 'Total equity = 47,894.58', cents: 4789458, derive: bsTotal('equity') },
  liabilities_equity: { label: 'Liabilities + equity = 57,608.18', cents: 5760818, derive: (p, ctx) => bsTotal('liabilities')(p, ctx) + bsTotal('equity')(p, ctx) },
};
const s2 = E.runSourceControls(state, agent('source_controls'), n1.parsed, { roles: { ar_account: '1300', prepaid_account: '2400' }, expected });
const by = Object.fromEntries(s2.controls.map((c) => [c.code, c]));
for (const c of s2.controls) console.log(`      ${c.status.padEnd(7)} ${c.code}${c.difference_cents ? '  diff ' + (c.difference_cents / 100).toFixed(2) : ''}`);
for (const k of Object.keys(expected)) check(`stage 2 authoritative: ${expected[k].label}`, by[`authoritative.${k}`].status === 'PASS');
check('stage 2: GL debits = credits; beginning and ending TB balance', ['gl.activity_debits_equal_credits', 'gl.beginning_trial_balance_balances', 'gl.ending_trial_balance_balances'].every((k) => by[k].status === 'PASS'));
check('stage 2: Balance Sheet A = L + E', by['balance_sheet.assets_equal_liabilities_plus_equity'].status === 'PASS');
check('stage 2: every Balance Sheet line = GL ending (3000 by the Vantaca display rule: 46,173.71 + 6,018.33 = 52,192.04)', s2.controls.filter((c) => c.code.startsWith('vantaca.bs_vs_gl.')).every((c) => c.status === 'PASS') && by['vantaca.bs_vs_gl.3000'].detail.current_period_result_cents === 601833 && by['vantaca.bs_vs_gl.3000'].detail.gl_carried_cents === 4617371);
check('stage 2: homeowner debit balances = GL AR 19,767.91; aging = GL AR; aging = ledger for every account', ['subledger.debit_balances_equal_gl_ar', 'ar_aging.total_equals_gl_ar', 'subledger.aging_matches_ledger_by_account'].every((k) => by[k].status === 'PASS'));
check('stage 2: prepaid gap surfaced, not plugged (credits 184.60 vs GL 2400 922.13 = -737.53)', by['subledger.credit_balances_equal_gl_prepaid'].status === 'FAIL' && by['subledger.credit_balances_equal_gl_prepaid'].difference_cents === -73753);
// The stage is not PASS (prepaid source gap), so a human cannot advance it without a waiver, and an agent never can.
let refused = null; try { S.advance(s2.state, HUMAN, 'snapshot'); } catch (e) { refused = e.code; }
check('gate: a non-passing source-controls stage cannot advance without a human waiver', refused === 'CURRENT_STAGE_NOT_PASSING', String(refused));
let agentRefused = null; try { S.advance(s2.state, agent('source_controls'), 'snapshot'); } catch (e) { agentRefused = e.code; }
check('gate: the agent cannot advance its own stage', agentRefused === 'ADVANCE_REQUIRES_HUMAN', String(agentRefused));
// A human waiver records a disposition; the control stays FAIL with its original amounts.
{
  const code = 'subledger.credit_balances_equal_gl_prepaid';
  const waived = S.waiveControl(s2.state, HUMAN, code, 'former-owner credit report requested; 737.53 reviewed, not plugged');
  const ws = S.waiversFor(waived, S.latestCompletion(waived, 'source_controls'));
  const shown = require('../lib/onboarding/controls').applyWaivers(s2.controls, ws);
  const c = shown.find((x) => x.code === code);
  const sum = require('../lib/onboarding/controls').summarize(shown);
  check('waiver: prepaid control is still FAIL (-737.53) with disposition WAIVED by ed; summary FAIL, eligible with waiver',
    c.status === 'FAIL' && c.difference_cents === -73753 && c.disposition.disposition === 'WAIVED' && c.disposition.waived_by === 'ed' && sum.overall === 'FAIL' && sum.eligibility === 'eligible_with_waiver');
  check('waiver: with the human waiver the stage may advance (human only)', S.advance(waived, HUMAN, 'snapshot').stage === 'snapshot');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
