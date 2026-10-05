// tests/onboarding_canyon_gate_bs_local.js  (Issue #15, 2026-10-05) — LOCAL ONLY.
// Proves the Vantaca adapter on REAL files that are never committed (the repo is
// public): a real fund-column Balance Sheet (Canyon Gate's 7/31/2026 upload, rejected
// before this change as "not a report Trusted recognizes yet") and Quail Ridge's
// original single-column Balance Sheet. No real path or figure lives in this file.
//
// Local config (never committed), JSON at $ONBOARDING_LOCAL_CONFIG, default
// ~/.trusted-onboarding/local.json:
//   { "fund_bs": { "path": "<real fund-column BalanceSheet.pdf>", "cutoff": "YYYY-MM-DD",
//                  "expect": { "fund_columns": [...], "rows": N, "total_assets_cents": N,
//                              "accounts": { "<code>": { "total_cents": N, "funds": { "<fund>": N } } } } },
//     "qr_zip": "<Quail_Ridge_Claude_Migration_Package.zip>" }
// Without the config or a file, that part SKIPs. Without "expect", the real file is
// still checked by assertions DERIVED from the document itself (recognized at the
// cutoff, every line read, every tie PASS, fund columns add to Total, each fund
// balances, every provenance span reads back the amount kept).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const V = require('../lib/onboarding/adapters/vantaca');
const { pdfToLayoutText } = require('../lib/onboarding/pdf_layout');
const { sourceControls } = require('../lib/onboarding/source_controls');
const { createOnboardingService } = require('../lib/onboarding/service');
const { parseCents } = require('../lib/onboarding/money');

const CONFIG_PATH = process.env.ONBOARDING_LOCAL_CONFIG || path.join(os.homedir(), '.trusted-onboarding', 'local.json');
let cfg = {};
if (fs.existsSync(CONFIG_PATH)) { try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { console.log(`FAIL  local onboarding config is not valid JSON: ${e.message}`); process.exit(1); } }
const ART = { sha256: 'x'.repeat(64) };
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
// The parse output of the pre-change parser (origin/main dd3977dc) on Quail Ridge's real
// Balance Sheet, as a hash: proves "byte-for-byte unchanged" without carrying any figure.
const QR_PINNED = {
  'quail_ridge_claude_package/original_vantaca_reports/BalanceSheet (18).pdf': 'b961da70a3c88afbf76f0def3c07311c33f245a8ac18cd9e9c52861ac56346c8',
  'quail_ridge_claude_package/extracted_text/balance_sheet.txt': '49c4524764397c253f83c59b11aa162d2f3b111c80e8c221900789f65a42f6c0',
};
let pass = 0, fail = 0, skipped = 0;
const check = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const fsum = (r) => (r.fund_amounts || []).reduce((s, f) => s + f.amount_cents, 0);

(async () => {
  const fb = cfg.fund_bs || null;
  if (!fb || !fb.path || !fs.existsSync(fb.path)) { skipped++; console.log('SKIP  real fund-column Balance Sheet (no local config or file on this machine)'); }
  else {
    const buf = fs.readFileSync(fb.path);
    const text = await pdfToLayoutText(buf);
    const bs = V.parse('balance_sheet', text, ART);
    const cutoff = fb.cutoff || bs.as_of;
    await check('real fund-column BS: the upload recognizer accepts it (and a renamed copy) as a Balance Sheet dated at the cutoff', async () => {
      const svc = createOnboardingService({ rpc: async () => { throw new Error('no database in this test'); }, storage: {} });
      const r = await svc.recognize('vantaca', cutoff, [{ originalname: path.basename(fb.path), buffer: buf }, { originalname: 'anything-else.pdf', buffer: buf }]);
      for (const x of r) assert.deepStrictEqual({ type: x.type, as_of: x.as_of, dated_at_cutoff: x.dated_at_cutoff, note: x.note }, { type: 'balance_sheet', as_of: cutoff, dated_at_cutoff: true, note: null });
    });
    await check('real fund-column BS: every line read (no defects), fund columns named from the report, every line carries Total', () => {
      assert.deepStrictEqual(bs.defects, []);
      assert.ok(bs.rows.length > 0 && Array.isArray(bs.printed.fund_columns) && bs.printed.fund_columns.length >= 2, JSON.stringify(bs.printed.fund_columns));
      assert.ok(bs.rows.every((r) => Number.isInteger(r.amount_cents) && Array.isArray(r.fund_amounts) && r.fund_amounts.length >= 1));
      assert.ok(bs.rows.some((r) => r.fund_amounts.length >= 2), 'at least one account is split across funds');
    });
    await check('real fund-column BS: on every line the fund columns add to the Total column', () => {
      const bad = bs.rows.filter((r) => fsum(r) !== r.amount_cents).map((r) => r.account_code);
      assert.deepStrictEqual(bad, []);
    });
    await check('real fund-column BS: every extraction control PASSes', () => {
      const cs = V.extractionControls({ balance_sheet: bs });
      assert.ok(cs.every((c) => c.status === 'PASS'), JSON.stringify(cs.filter((c) => c.status !== 'PASS').map((c) => c.code)));
    });
    await check('real fund-column BS: assets = liabilities + equity in Total and within each fund', () => {
      assert.strictEqual(sourceControls({ balance_sheet: bs }).find((c) => c.code === 'balance_sheet.assets_equal_liabilities_plus_equity').status, 'PASS');
      const ft = bs.printed.fund_totals;
      for (const f of bs.printed.fund_columns) assert.strictEqual(ft['total assets'][f] ?? 0, ft['total liabilities / equity'][f] ?? 0, f);
    });
    await check('real fund-column BS: each column span in the provenance reads exactly the amount kept', () => {
      for (const r of bs.rows) for (const [col, [a, b]] of Object.entries(r.provenance.locator.columns)) {
        const kept = col === 'Total' ? r.amount_cents : r.fund_amounts.find((f) => f.fund === col).amount_cents;
        assert.strictEqual(parseCents(r.provenance.raw.slice(a, b)), kept, `${r.account_code} ${col}`);
      }
    });
    if (fb.expect) {
      await check('real fund-column BS: matches the locally held expectations (fund columns, row count, totals, split accounts)', () => {
        const e = fb.expect;
        if (e.fund_columns) assert.deepStrictEqual(bs.printed.fund_columns, e.fund_columns);
        if (e.rows !== undefined) assert.strictEqual(bs.rows.length, e.rows);
        if (e.total_assets_cents !== undefined) assert.strictEqual(bs.printed.totals['total assets'], e.total_assets_cents);
        for (const [code, x] of Object.entries(e.accounts || {})) {
          const r = bs.rows.find((y) => y.account_code === code);
          assert.ok(r, `account ${code} present`);
          if (x.total_cents !== undefined) assert.strictEqual(r.amount_cents, x.total_cents, `${code} Total`);
          if (x.funds) assert.deepStrictEqual(Object.fromEntries(r.fund_amounts.map((f) => [f.fund, f.amount_cents])), x.funds, `${code} funds`);
        }
      });
    } else console.log('  note  no "expect" block in the local config: exact amounts not compared (derived checks only)');
  }

  const qrZip = cfg.qr_zip || process.env.ONBOARDING_QR_ZIP || path.join(os.homedir(), 'Downloads', 'Quail_Ridge_Claude_Migration_Package.zip');
  if (!fs.existsSync(qrZip)) { skipped++; console.log('SKIP  Quail Ridge Balance Sheet (package not on this machine)'); }
  else {
    for (const [p, pinned] of Object.entries(QR_PINNED)) {
      await check(`Quail Ridge: ${path.basename(p)} recognizes and parses byte-for-byte as before the change`, async () => {
        const b = execFileSync('unzip', ['-p', qrZip, p], { maxBuffer: 64e6 });
        const text = /\.pdf$/i.test(p) ? await pdfToLayoutText(b) : b.toString('utf8');
        assert.deepStrictEqual(V.identify(text), { type: 'balance_sheet', as_of: '2026-07-31', period_start: null });
        assert.strictEqual(sha(V.parse('balance_sheet', text, ART)), pinned);
      });
    }
  }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();
