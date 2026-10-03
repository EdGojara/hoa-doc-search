// ============================================================================
// tests/test_onboarding_ap_aging.js  (Issue #15) — Vantaca AP Aging reader
// ----------------------------------------------------------------------------
// Synthetic only. Proves:
//   - invoices ("<vendor> Inv # <n> on <date>") and amount rows are paired strictly
//     IN ORDER, including the pdftotext shape where an invoice's amounts print on
//     the line ABOVE its header; a count mismatch is a defect, never a guess;
//   - invoice rows tie to the printed Total (every bucket); buckets add per invoice;
//   - source control: AP aging = GL AP (blocked without an AP account role);
//   - snapshot: AP detail lines per invoice support GL AP exactly; a short aging
//     leaves an unsupported line, never a plug.
// The synthetic GL has no 2000 account, so the tests point the AP role at 2400
// (85.00 credit) purely to exercise the mechanics.
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
// Two invoices; the second one's amounts print on the line ABOVE its header (the real layout).
const AP = [
  '                    Example Creek Homeowners Association, Inc',
  '',
  '          AP Aging for Ending Date: 3/31/2026',
  '',
  'Provider                                                                            Current      Over 30      Over 60       Over 90         Total',
  '',
  'EXAMPLE LANDSCAPING LLC Inv # EX-0002 on 3/01/2026 -                                       0.00        60.00          0.00          0.00      60.00',
  'Monthly - Landscaping                                                                     25.00         0.00          0.00          0.00      25.00',
  'EXAMPLE POSTAGE LLC Inv # P-77 on 3/20/2026 -',
  'Postage - Postage                                                                         25.00        60.00          0.00          0.00      85.00',
  '',
  '                                                                             Total',
].join('\n');
function parseWith(apText, roles) {
  const texts = { gl_trial_balance: read('gl_trial_balance.txt'), balance_sheet: read('balance_sheet.txt'), ar_aging: read('ar_aging.txt'), homeowner_transactions: read('homeowner_transactions.txt'), ap_aging: apText };
  const inputs = Object.entries(texts).filter(([, t]) => t !== null).map(([type, t]) => { const buffer = Buffer.from(t); return { artifact: makeArtifact(buffer, { batch_code: 'B', community_id: 'c', source_system: 'vantaca', artifact_type: type, filename: type, cutoff_date: '2026-03-31' }), buffer }; });
  return E.normalize('vantaca', inputs);
}
const ctl = (list, code) => list.find((c) => c.code === code);
const ROLES = { ar_account: '1300', prepaid_account: '2400', ap_account: '2400' };
const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('reader: invoices and amount rows paired in order, including amounts printed above the header; printed total captured', () => {
  const r = P.parseApAging(AP, { sha256: 'a'.repeat(64) });
  assert.deepStrictEqual(r.defects, []); assert.strictEqual(r.as_of, '2026-03-31');
  assert.deepStrictEqual(r.rows.map((x) => [x.invoice_number, x.invoice_date, x.amount_cents]), [['EX-0002', '2026-03-01', 6000], ['P-77', '2026-03-20', 2500]]);
  assert.strictEqual(r.printed.total.balance_cents, 8500);
  assert.ok(r.rows.every((x) => x.provenance.locator.line > 0 && x.provenance.locator.amount_line > 0));
});
check('reader: n invoices must have n + 1 amount rows; otherwise a defect (no guessing)', () => {
  const r = P.parseApAging(AP.replace('EXAMPLE POSTAGE LLC Inv # P-77 on 3/20/2026 -', 'EXAMPLE POSTAGE LLC (no invoice header)'), { sha256: 'a'.repeat(64) });
  assert.ok(r.defects.some((d) => d.code === 'AP_AGING_ROW_COUNT_MISMATCH'));
});
check('extraction: invoice rows tie to the printed total in every bucket; buckets add per invoice', () => {
  const n = parseWith(AP);
  for (const k of ['current', 'over_30', 'over_60', 'over_90', 'balance']) assert.strictEqual(ctl(n.extraction, `ap_aging.items_tie_to_printed_total.${k}`).status, 'PASS', k);
  assert.strictEqual(ctl(n.extraction, 'ap_aging.invoice_buckets_add_to_invoice_total').status, 'PASS');
  const bad = parseWith(AP.replace('25.00         0.00          0.00          0.00      25.00', '25.00         0.00          0.00          0.00      26.00'));
  assert.strictEqual(ctl(bad.extraction, 'ap_aging.items_tie_to_printed_total.balance').status, 'FAIL');
});
check('source control: AP aging = GL AP; blocked without an AP account role', () => {
  assert.strictEqual(ctl(sourceControls(parseWith(AP).parsed, { roles: ROLES }), 'ap_aging.total_equals_gl_ap').status, 'PASS');
  assert.strictEqual(ctl(sourceControls(parseWith(AP).parsed, { roles: { ar_account: '1300' } }), 'ap_aging.total_equals_gl_ap').status, 'BLOCKED');
});
check('snapshot: one AP line per invoice supports GL AP exactly; a short aging leaves an unsupported line (no plug)', () => {
  const s = buildSnapshot(parseWith(AP).parsed, { batch_code: 'B', cutoff_date: '2026-03-31', roles: ROLES });
  const c = s.components.find((x) => x.component === 'ap_detail');
  assert.deepStrictEqual([c.status, c.supported_cents, c.unsupported_cents, c.invoices], ['PASS', -8500, 0, 2]);
  assert.deepStrictEqual(s.lines.filter((l) => l.kind === 'ap_detail').map((l) => [l.invoice_number, l.amount_cents]), [['EX-0002', -6000], ['P-77', -2500]]);
  const shortAp = AP.replace('25.00        60.00          0.00          0.00      85.00', '25.00        50.00          0.00          0.00      75.00').replace('0.00        60.00          0.00          0.00      60.00', '0.00        50.00          0.00          0.00      50.00');
  const s2 = buildSnapshot(parseWith(shortAp).parsed, { batch_code: 'B', cutoff_date: '2026-03-31', roles: ROLES });
  const c2 = s2.components.find((x) => x.component === 'ap_detail');
  assert.deepStrictEqual([c2.status, c2.unsupported_cents], ['BLOCKED', -1000]);
  assert.ok(s2.lines.some((l) => l.kind === 'unsupported_detail' && l.component === 'ap_detail' && l.amount_cents === -1000));
});

let pass = 0, fail = 0;
console.log('Onboarding: Vantaca AP Aging reader (Issue #15)');
for (const [n, fn] of tests) { try { fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
