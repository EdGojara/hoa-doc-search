// ============================================================================
// tests/test_onboarding_prepaid_report.js  (Issue #15) — Vantaca Pre Paid Homeowners
// ----------------------------------------------------------------------------
// The prepaid / credit-balance report supplies the credits the current-owner
// ledger cannot: PREVIOUS owners. Synthetic fixture only. Proves:
//   - rows are read by ACCOUNT NUMBER ("***" = previous owner); names are never
//     used (they wrap and shift in the PDF text); rows must tie to the printed total;
//   - source controls: current-owner credits (ledger) + previous-owner credits
//     (report) = GL prepaid; report total = GL prepaid; current-owner rows match
//     the ledger account by account; a "previous owner" in the current ledger fails;
//   - the snapshot carries previous-owner credits as their own lines keyed by the
//     former owner's account (never attached to a current lot), leaving nothing
//     unsupported when the report ties; without the report the gap stays BLOCKED.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../lib/onboarding/engine');
const { makeArtifact } = require('../lib/onboarding/artifacts');
const { buildSnapshot } = require('../lib/onboarding/snapshot');
const { sourceControls } = require('../lib/onboarding/source_controls');
const P = require('../lib/onboarding/adapters/vantaca/parsers');

const FX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const read = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const ROLES = { ar_account: '1300', prepaid_account: '2400' };
function parseWith(overrides = {}) {
  const texts = { gl_trial_balance: read('gl_trial_balance.txt'), balance_sheet: read('balance_sheet.txt'), ar_aging: read('ar_aging.txt'), homeowner_transactions: read('homeowner_transactions.txt'), prepaid_homeowners: read('prepaid_homeowners.txt'), ...overrides };
  const inputs = Object.entries(texts).filter(([, t]) => t !== null).map(([type, t]) => { const buffer = Buffer.from(t); return { artifact: makeArtifact(buffer, { batch_code: 'B', community_id: 'c', source_system: 'vantaca', artifact_type: type, filename: type, cutoff_date: '2026-03-31' }), buffer }; });
  return E.normalize('vantaca', inputs);
}
const ctl = (list, code) => list.find((c) => c.code === code);
// Account 90000003 becomes a PREVIOUS owner: off the current ledger, on the report with ***.
const ledgerWithout3 = read('homeowner_transactions.txt').split('Report generated on 4/1/2026 9:00 AM - V3.11                                                                    Page 2')[0];
const prepaidPrevious = read('prepaid_homeowners.txt').replace('90000003     103 Example Lane', '***90000003  103 Example Lane');
const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('reader: account-keyed rows, previous-owner flag, printed total; names ignored even when the column shifts', () => {
  const r = P.parsePrepaidHomeowners(prepaidPrevious, { sha256: 'a'.repeat(64) });
  assert.deepStrictEqual(r.rows.map((x) => [x.source_account_key, x.previous_owner, x.amount_cents]), [['90000003', true, 8500]]);
  assert.strictEqual(r.printed.total, 8500); assert.strictEqual(r.as_of, '2026-03-31'); assert.deepStrictEqual(r.defects, []);
  const shifted = 'Pre Paid Homeowners For 7/31/2026\n***10000001  112 Example Way                    LLC                                                10.34\n10000002     1 Main St                         Name that wraps-                                   5.00\n                                               Continued\n                                                                                          15.34\n                                                                        Total\n';
  const s = P.parsePrepaidHomeowners(shifted, { sha256: 'b'.repeat(64) });
  assert.deepStrictEqual(s.rows.map((x) => [x.source_account_key, x.previous_owner, x.amount_cents]), [['10000001', true, 1034], ['10000002', false, 500]]);
  assert.ok(s.rows.every((x) => !('owner_name' in x)), 'no names in canonical rows');
});
check('extraction: rows must tie to the printed total; a garbled row is a defect', () => {
  const ok = parseWith();
  assert.strictEqual(ctl(ok.extraction, 'prepaid_homeowners.rows_tie_to_printed_total').status, 'PASS');
  const bad = parseWith({ prepaid_homeowners: read('prepaid_homeowners.txt').replace('                                                                                           85.00', '                                                                                           95.00') });
  assert.strictEqual(ctl(bad.extraction, 'prepaid_homeowners.rows_tie_to_printed_total').status, 'FAIL');
  const garbled = parseWith({ prepaid_homeowners: read('prepaid_homeowners.txt').replace('Example Owner Three                                85.00', 'Example Owner Three                                8?.00') });
  assert.strictEqual(ctl(garbled.extraction, 'prepaid_homeowners.no_unreadable_lines').status, 'FAIL');
});
check('source controls: current owner on report = ledger -> PASS; report total = GL prepaid', () => {
  const c = sourceControls(parseWith().parsed, { roles: ROLES });
  for (const k of ['subledger.credit_balances_equal_gl_prepaid', 'prepaid_report.total_equals_gl_prepaid', 'prepaid_report.current_owner_credits_match_ledger']) assert.strictEqual(ctl(c, k).status, 'PASS', k);
});
check('the Quail Ridge shape: credit gone from the current ledger but on the report as a PREVIOUS owner -> ledger + previous = GL, PASS', () => {
  const n = parseWith({ homeowner_transactions: ledgerWithout3, prepaid_homeowners: prepaidPrevious });
  const withoutReport = sourceControls(parseWith({ homeowner_transactions: ledgerWithout3, prepaid_homeowners: null }).parsed, { roles: ROLES });
  assert.strictEqual(ctl(withoutReport, 'subledger.credit_balances_equal_gl_prepaid').status, 'FAIL', 'without the report the gap is real');
  const c = sourceControls(n.parsed, { roles: ROLES });
  const k = ctl(c, 'subledger.credit_balances_equal_gl_prepaid');
  assert.strictEqual(k.status, 'PASS'); assert.deepStrictEqual([k.detail.ledger_credits_cents, k.detail.previous_owner_credits_cents, k.detail.previous_owner_accounts], [0, 8500, 1]);
  assert.strictEqual(ctl(c, 'prepaid_report.current_owner_credits_match_ledger').status, 'PASS');
});
check('mismatches fail: report current-owner amount != ledger; a "previous owner" still in the current ledger; report total != GL', () => {
  const amt = sourceControls(parseWith({ prepaid_homeowners: read('prepaid_homeowners.txt').replace(/85\.00/g, '80.00') }).parsed, { roles: ROLES });
  assert.strictEqual(ctl(amt, 'prepaid_report.current_owner_credits_match_ledger').status, 'FAIL');
  assert.strictEqual(ctl(amt, 'prepaid_report.total_equals_gl_prepaid').status, 'FAIL');
  const stillCurrent = sourceControls(parseWith({ prepaid_homeowners: prepaidPrevious }).parsed, { roles: ROLES });
  assert.ok(ctl(stillCurrent, 'prepaid_report.current_owner_credits_match_ledger').failures.some((f) => /previous owner but present/.test(f.reason || '')));
});
check('snapshot: previous-owner credits are their own lines keyed by the former account; nothing unsupported; without the report the gap stays BLOCKED', () => {
  const s = buildSnapshot(parseWith({ homeowner_transactions: ledgerWithout3, prepaid_homeowners: prepaidPrevious }).parsed, { batch_code: 'B', cutoff_date: '2026-03-31', roles: ROLES });
  const c = s.components.find((x) => x.component === 'prepaid_detail');
  assert.deepStrictEqual([c.status, c.control_cents, c.supported_cents, c.unsupported_cents, c.former_owner_accounts], ['PASS', -8500, -8500, 0, 1]);
  const lines = s.lines.filter((l) => l.kind === 'prepaid_detail');
  assert.deepStrictEqual(lines.map((l) => [l.source_account_key, l.amount_cents, !!l.former_owner]), [['90000003', -8500, true]]);
  assert.ok(lines[0].provenance[0].locator.line > 0);
  assert.strictEqual(s.lines.filter((l) => l.kind === 'unsupported_detail' && l.component === 'prepaid_detail').length, 0);
  const s2 = buildSnapshot(parseWith({ homeowner_transactions: ledgerWithout3, prepaid_homeowners: null }).parsed, { batch_code: 'B', cutoff_date: '2026-03-31', roles: ROLES });
  assert.strictEqual(s2.components.find((x) => x.component === 'prepaid_detail').status, 'BLOCKED');
});

let pass = 0, fail = 0;
console.log('Onboarding: Vantaca Pre Paid Homeowners report (Issue #15)');
for (const [n, fn] of tests) { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
