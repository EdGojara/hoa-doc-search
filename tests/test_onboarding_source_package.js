// ============================================================================
// tests/test_onboarding_source_package.js  (Issue #15) — the Vantaca source package
// ----------------------------------------------------------------------------
// A user should not have to know which files to upload. For a provider and a
// cutoff, the adapter names every report Trusted reads (by the name Vantaca
// prints on it, dated for that cutoff), recognizes a report from its own header
// and the date it carries, and the intake requests reuse the same names.
// Generic: nothing here is tied to one community.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/onboarding/adapters/vantaca');

const FX = path.join(__dirname, 'fixtures', 'onboarding', 'synthetic-vantaca');
const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('package for a cutoff: the six Vantaca reports by their printed names, dated for that cutoff', () => {
  const p = V.sourcePackage('2026-07-31');
  assert.deepStrictEqual(p.reports.map((r) => r.report), [
    'GL Trial Balance for 1/1/2026 - 7/31/2026',
    'Balance Sheet as of 7/31/2026',
    'AR Aging as of 7/31/2026',
    'Homeowner Transaction History for 1/1/2026 - 7/31/2026',
    'Pre Paid Homeowners as of 7/31/2026 (include previous owners)',
    'AP Aging as of 7/31/2026',
  ]);
  assert.ok(p.reports.every((r) => r.saved_as && r.why), 'every line says where to find it and why');
  assert.ok(p.reports.every((r) => r.need === undefined && r.role === undefined), 'the user is never shown an include-or-not decision; need / role stay internal');
});
check('package is generic: another cutoff gives other dates; no cutoff still names every report', () => {
  const p = V.sourcePackage('2025-12-31');
  assert.strictEqual(p.reports[0].report, 'GL Trial Balance for 1/1/2025 - 12/31/2025');
  assert.strictEqual(p.reports[1].report, 'Balance Sheet as of 12/31/2025');
  assert.ok(V.sourcePackage(null).reports.every((r) => /cutoff/.test(r.report)));
});
check('scope: the package is the FINANCIAL conversion only; owner / property / contact onboarding is separate and never inferred', () => {
  const p = V.sourcePackage('2026-07-31');
  assert.ok(!p.reports.some((r) => /roster|owner changes|contact/i.test(r.report)));
  assert.strictEqual(p.scope.kind, 'financial');
  assert.strictEqual(p.scope.text, "Financial conversion: these reports establish the association's accounting position through 7/31/2026. Owner, property and contact onboarding is handled separately and is not inferred from these reports.");
  assert.match(p.scope.detail, /never read as owner, co-owner, tenant, mailing-address, email or phone records/);
  assert.match(p.scope.detail, /Owner Changes Summary is not a roster/);
  assert.ok(!/not needed through preflight/i.test(JSON.stringify(p)), 'no copy implying party data is unnecessary');
});
check('no party data is inferred: canonical rows from every reader carry account keys, amounts and dates, never the names / addresses printed on the report (those stay only in the raw provenance line or a verbatim memo)', () => {
  const strip = (row) => { const { provenance, ...rest } = row; return rest; };
  const PARTY = /name|owner_|address|mail|email|phone|tenant|occupant|co_owner|relationship/i;
  for (const t of ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners']) {
    const text = fs.readFileSync(path.join(FX, `${t}.txt`), 'utf8');
    const rows = V.parse(t, text, { filename: t, sha256: 'x' }).rows.map(strip);
    assert.ok(rows.length, t + ' parsed');
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    for (const k of keys) assert.ok(!PARTY.test(k) || k === 'account_name', `${t}: canonical field ${k} looks like party data`);
    // a transaction memo is kept verbatim as printed (the bridge matches on it); it is never parsed into party fields
    const flat = JSON.stringify(rows.map(({ description, ...r }) => r));
    for (const who of ['Example Owner', 'Example Lane']) assert.ok(!flat.includes(who), `${t}: printed party text "${who}" leaked into canonical rows`);
  }
});
check('recognition: every synthetic fixture is identified by its header with the date it prints', () => {
  const read = (t) => fs.readFileSync(path.join(FX, `${t}.txt`), 'utf8');
  assert.deepStrictEqual(V.identify(read('gl_trial_balance')), { type: 'gl_trial_balance', as_of: '2026-03-31', period_start: '2026-01-01' });
  assert.deepStrictEqual(V.identify(read('balance_sheet')), { type: 'balance_sheet', as_of: '2026-03-31', period_start: null });
  assert.deepStrictEqual(V.identify(read('ar_aging')), { type: 'ar_aging', as_of: '2026-03-31', period_start: null });
  assert.deepStrictEqual(V.identify(read('homeowner_transactions')), { type: 'homeowner_transactions', as_of: '2026-03-31', period_start: '2026-01-01' });
  assert.deepStrictEqual(V.identify(read('prepaid_homeowners')), { type: 'prepaid_homeowners', as_of: '2026-03-31', period_start: null });
  assert.deepStrictEqual(V.identify('   AP Aging for Ending Date: 3/31/2026\n'), { type: 'ap_aging', as_of: '2026-03-31', period_start: null });
  assert.strictEqual(V.identify('Some Other Report\nnot a layout we know'), null);
  assert.strictEqual(V.detect(read('ar_aging')), 'ar_aging');
});
check('cutoff check: a report dated at another date is named again with the right date', () => {
  assert.deepStrictEqual(V.cutoffCheck(V.identify('AR Aging - 3/31/2026'), '2026-03-31'), { ok: true, note: null });
  const off = V.cutoffCheck(V.identify('AR Aging - 2/28/2026'), '2026-03-31');
  assert.strictEqual(off.ok, false); assert.match(off.note, /dated 2\/28\/2026; the cutoff is 3\/31\/2026\. Please run AR Aging as of 3\/31\/2026\./);
});
check('intake requests reuse the package names (one list); conditional reports only when the GL balance is non-zero', () => {
  const gl = (rows) => ({ gl_trial_balance: { rows: rows.map(([c, n, e]) => ({ domain: 'gl_account_balance', account_code: c, account_name: n, ending_cents: e })) } });
  const parsed = gl([['1300', 'Accounts Receivable', 100], ['2400', 'Prepaid Homeowners', -50], ['2000', 'Accounts Payable', 0]]);
  const roles = V.inferRoles(parsed);
  const req = V.requiredSources(parsed, roles, '2026-07-31');
  const pkg = Object.fromEntries(V.sourcePackage('2026-07-31').reports.map((r) => [r.type, r.report]));
  assert.deepStrictEqual(req.map((r) => r.type), ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'prepaid_homeowners']);
  assert.ok(req.every((r) => r.report === pkg[r.type]), 'same names as the start screen');
  assert.ok(!req.some((r) => r.type === 'ap_aging'), 'AP is zero, so the AP Aging is not demanded');
});

(async () => {
  let pass = 0, fail = 0;
  console.log('Onboarding: Vantaca source package (Issue #15)');
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
