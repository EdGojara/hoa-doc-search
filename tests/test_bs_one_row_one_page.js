// tests/test_bs_one_row_one_page.js — balance sheet presentation (Ed 2026-11-17).
// 1. One row per GL account: an account carried in several funds (3050 in OPR, RES and SAV) is one
//    row, each fund's amount in its column, the total combined. Display only; the engine's
//    per-fund balances are summed, never changed.
// 2. The printed balance sheet fits one page: renderDocument marks it .fit1 and pdfBuffer scales
//    an overflowing .fit1 block down to the printable height, never below the legibility floor.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fitScale, PRINT_H_PX } = require('../lib/statements/export');
const { renderDocument } = require('../lib/statements/render');

const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('fitScale: fits as is -> 1; slightly over -> scaled to fit; far over -> 1 (continues, legible)', () => {
  assert.strictEqual(fitScale(PRINT_H_PX - 10), 1);
  assert.strictEqual(fitScale(PRINT_H_PX), 1);
  const z = fitScale(PRINT_H_PX * 1.2);
  assert.ok(z < 1 && z >= 0.72, String(z));
  assert.ok(PRINT_H_PX * 1.2 * z <= PRINT_H_PX, 'scaled block fits the printable height');
  assert.strictEqual(fitScale(PRINT_H_PX * 2), 1, 'never shrinks below the legibility floor');
  assert.strictEqual(fitScale(NaN), 1);
});

check('the balance sheet block is marked to fit one page; other statements are not', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib/statements/render.js'), 'utf8');
  assert.ok(html.includes("${m.kind === 'balance_sheet' ? ' fit1' : ''}"));
  assert.ok(/\.fit1\{break-inside:avoid\}/.test(html));
  const ex = fs.readFileSync(path.join(__dirname, '..', 'lib/statements/export.js'), 'utf8');
  assert.ok(/await page\.setViewport\(\{ width: PRINT_W_PX, height: PRINT_H_PX \}\);\s*await page\.setContent\(html[^;]*;\s*await fitOnePage\(page\);/.test(ex), 'measured at print width, fitted before printing');
  assert.ok(typeof renderDocument === 'function');
});

check('one row per GL account across funds, values summed per column, drill covers all funds', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'lib/statements/model.js'), 'utf8');
  assert.ok(m.includes('byAcct.get(a.account_id).members.push(a)'), 'rows grouped by account, not account+fund');
  assert.ok(m.includes('for (const mm of a.members) { const v = balOf(e, mm, col); if (v === null) return null; t += v; }'), 'each fund column sums that fund\'s balance; n/a stays n/a');
  assert.ok(m.includes("drill: { level: 'account', account_id: a.account_id, fund_id: multi ? null : (a.fund_id || null) }"), 'a merged row drills into every fund');
});

check('the PDF export returns a Buffer (a Uint8Array would be sent as JSON by Express)', () => {
  const ex = fs.readFileSync(path.join(__dirname, '..', 'lib/statements/export.js'), 'utf8');
  assert.ok(/return Buffer.from(await page.pdf({/.test(ex));
});

check('monthly statements print without a notes page by default; the statement PDF button opens the PDF', () => {
  const r = fs.readFileSync(path.join(__dirname, '..', 'lib/statements/render.js'), 'utf8');
  assert.ok(r.includes('const notesHtml = withNotes && notes.length'));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public/accounting.html'), 'utf8');
  assert.ok(ui.includes('/render?format=pdf&statements=income_budget&funds=active,all'));
  assert.ok(!ui.includes('/render?format=print&statements=income_budget'));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
