// tests/test_check_reprint.js — check print / reprint (Ed 2026-11-17, migration 565).
// A reprint renders the SAME check (original number, payee, amount, date, payment, GL entry) from
// any issue date and never posts or creates anything. Voided, stop-paid and cleared checks are
// refused; a check confirmed printed needs an admin, a reason and an acknowledgement. A generated
// PDF is not a printed check. Layout: every check page stays inside its regions, one page per
// check (+ continuation pages for long invoice lists), and the PDF asks for actual-size printing.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../lib/accounting/check_run');
const { renderChecksHTML, renderChecksPDF, STUB_ROWS, CONT_ROWS } = require('../lib/accounting/check_renderer');

const tests = []; const check = (n, fn) => tests.push([n, fn]);
const row = (o = {}) => ({ id: 'r1', community_id: 'c1', check_number: '1021', status: 'issued', print_status: 'pdf_generated', reprinted_count: 0, ...o });

check('reprint rules: any date; dead checks refused; confirmed-printed needs admin + reason + acknowledgement', () => {
  const D = (o, opt = {}) => C.reprintDecision(row(o), { community_id: 'c1', ...opt });
  assert.strictEqual(D({}).ok, true, 'never confirmed: staff may reprint');
  assert.strictEqual(D({ print_status: 'print_failed' }).ok, true, 'a failed print can be retried');
  assert.strictEqual(D({ status: 'outstanding' }).ok, true);
  for (const st of ['voided', 'stop_payment', 'cleared']) assert.strictEqual(D({ status: st }, { isAdmin: true, reason: 'x', acknowledged: true }).ok, false, st + ' is never reprinted');
  assert.strictEqual(C.reprintDecision(row(), { community_id: 'other' }).ok, false, 'other community');
  assert.strictEqual(D({ print_status: 'printed' }).ok, false, 'staff cannot reprint a confirmed check');
  assert.strictEqual(D({ print_status: 'printed' }, { isAdmin: true }).ok, false, 'admin needs a reason');
  assert.strictEqual(D({ print_status: 'printed' }, { isAdmin: true, reason: 'misaligned, shredded' }).ok, false, 'admin needs the acknowledgement');
  assert.strictEqual(D({ print_status: 'printed' }, { isAdmin: true, reason: 'misaligned, shredded', acknowledged: true }).ok, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(C.reprintDecision.toString(), 'created_at') && !/created_at|_centralToday|today/.test(C.reprintDecision.toString()), 'no date lock');
});

check('print labels: never confirmed / printed / reprinted / failed / cleared', () => {
  assert.strictEqual(C.printLabel(row()), 'PDF generated, not confirmed');
  assert.strictEqual(C.printLabel(row({ reprinted_count: 1 })), 'Reprint generated, not confirmed');
  assert.strictEqual(C.printLabel(row({ print_status: 'printed' })), 'Printed');
  assert.strictEqual(C.printLabel(row({ print_status: 'printed', reprinted_count: 2 })), 'Reprinted');
  assert.strictEqual(C.printLabel(row({ print_status: 'print_failed' })), 'Print failed');
  assert.strictEqual(C.printLabel(row({ status: 'cleared' })), 'Printed (cleared the bank)');
});

check('reprint never posts, pays or numbers anything; it is logged before the PDF is sent; staff sign-in required', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/accounting/check_run.js'), 'utf8');
  const a = src.indexOf('// Print / reprint (Ed 2026-11-17'); const b = src.indexOf('// A printed check that posted created FOUR things');
  const block = src.slice(a, b);
  assert.ok(a > 0 && b > a);
  for (const bad of ['postJournalEntry', 'recordPayment', 'reserve_next_check_number', "from('ap_payments')", "from('journal_entries')", '.insert({ check_number', 'check_number:']) assert.ok(!block.includes(bad), 'reprint block must not touch ' + bad);
  const api = fs.readFileSync(path.join(__dirname, '..', 'api/checks.js'), 'utf8');
  const r = api.slice(api.indexOf("router.post('/reprint'"), api.indexOf("router.post('/print-status'"));
  assert.ok(/const u = await requireStaff\(req, res\); if \(!u\) return;/.test(r), 'reprint requires a signed-in staff member');
  assert.ok(r.indexOf('await recordPrintEvents(') > 0 && r.indexOf('await recordPrintEvents(') < r.indexOf('res.send(pdf)'), 'logged before the PDF goes out');
  assert.ok(/isAdmin: u\.role === 'admin'/.test(r) && !/b\.isAdmin|b\.role/.test(r), 'admin comes from the verified sign-in, never the body');
  const ps = api.slice(api.indexOf("router.post('/print-status'"), api.indexOf("router.get('/register/:id/print-history'"));
  assert.ok(/requireStaff/.test(ps) && /confirmPrint\(/.test(ps));
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations/565_check_print_status.sql'), 'utf8');
  assert.ok(/print_status IN \('pdf_generated', 'printed', 'print_failed'\)/.test(mig) && /GRANT SELECT, INSERT ON check_print_events TO service_role/.test(mig));
  const sqlOnly = mig.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n').replace(/GRANT[^;]*;/g, '').replace(/ON DELETE RESTRICT/g, '');
  assert.ok(!/\b(UPDATE|DELETE|INSERT INTO)\b/i.test(sqlOnly), 'schema only: no row changes');
});

check('the register offers print/reprint and printed OK / failed on the existing screen', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public/accounting.html'), 'utf8');
  assert.ok(ui.includes('Print / reprint selected') && ui.includes("chkMarkPrint(['") && ui.includes("fetch('/api/checks/print-status'"));
  assert.ok(!/_chkOverride|override:useOverride/.test(ui), 'the same-day lock override is gone');
  assert.ok(/Actual size \(100%\)/.test(ui));
});

const bank = { account_name: 'Sample HOA Operating', bank_name: 'Sample Bank', routing: '111000025', account_number: '123456789', micr_serial_digits: 6,
  company_address_lines: ['1 Main St', 'Houston, TX 77001'], ready_for_print: true };
const inv = (n) => Array.from({ length: n }, (_, i) => ({ invoice_number: 'INV-' + (1000 + i), invoice_date: '2026-10-0' + (1 + (i % 9)), description: 'Landscape maintenance with a very long description that keeps going and going and going', amount_cents: 12345 }));
const mk = (n, k, addrLines = 4) => ({ check_number: String(1000 + n), issue_date: '2026-11-10', amount_cents: Math.max(1, k) * 12345,
  memo: 'October invoices for services rendered at the community clubhouse, pool and every common area of the association',
  payee_name: 'A Very Long Vendor Name Landscaping and Irrigation Services of Greater Houston and Surrounding Counties LLC',
  payee_address_lines: ['PO Box 12345 Suite 900 Attention Accounts Receivable Department Building C', 'Houston, TX 77001-1234', 'Line three', 'Line four', 'Line five'].slice(0, addrLines), invoices: inv(k) });

check('layout: every check stays inside its regions; one page per check plus continuation pages; actual-size printing', async () => {
  const checks = [mk(1, 0, 1), mk(2, 3), mk(3, STUB_ROWS), mk(4, STUB_ROWS + 1), mk(5, STUB_ROWS + CONT_ROWS + 5, 5)];
  const expectPages = checks.reduce((t, c) => t + 1 + (c.invoices.length > STUB_ROWS ? Math.ceil(c.invoices.length / CONT_ROWS) : 0), 0);
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(renderChecksHTML(checks, bank), { waitUntil: 'networkidle0' });
    const geo = await page.evaluate(() => {
      const out = [];
      for (const pg of document.querySelectorAll('.page')) {
        const r = { h: pg.getBoundingClientRect().height, regions: [] };
        for (const el of pg.children) r.regions.push({ cls: el.className, client: el.clientHeight, scroll: el.scrollHeight });
        const ck = pg.querySelector('.check:not(.cont-void)');
        if (ck) {
          const box = (sel) => { const e = ck.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
          const words = box('.ck-words'), addr = box('.ck-addr'), memo = box('.ck-memo'), micr = box('.micr'), c = ck.getBoundingClientRect();
          r.addrBelowWords = !addr || !words || addr.top >= words.bottom - 0.5;
          r.memoAboveMicr = !memo || !micr || memo.bottom <= micr.top + 0.5;
          const py = ck.querySelector('.payee'); r.payeeWhole = !py || py.scrollHeight <= py.clientHeight + 1;
          r.insideCheck = [addr, memo, micr].every((b) => !b || (b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5));
        }
        out.push(r);
      }
      return out;
    });
    assert.strictEqual(geo.length, expectPages, 'page count');
    for (const [i, g] of geo.entries()) {
      assert.ok(Math.abs(g.h - 1056) < 1, `page ${i + 1} is exactly 11in`);
      for (const rg of g.regions) assert.ok(rg.scroll <= rg.client + 1, `page ${i + 1} ${rg.cls}: content ${rg.scroll}px > region ${rg.client}px`);
      if ('addrBelowWords' in g) { assert.ok(g.addrBelowWords, `page ${i + 1}: payee address overlaps the amount line`); assert.ok(g.memoAboveMicr, `page ${i + 1}: memo reaches the MICR band`); assert.ok(g.insideCheck, `page ${i + 1}: a field leaves the check area`); assert.ok(g.payeeWhole, `page ${i + 1}: the payee name is cut off`); }
    }
  } finally { await browser.close(); }
  const pdf = await renderChecksPDF(checks, bank);
  assert.ok(Buffer.isBuffer(pdf) && pdf.slice(0, 4).toString() === '%PDF');
  const { PDFDocument, PrintScaling } = require('pdf-lib');
  const doc = await PDFDocument.load(pdf);
  assert.strictEqual(doc.getPageCount(), expectPages, 'PDF page count');
  for (const pg of doc.getPages()) { const { width, height } = pg.getSize(); assert.ok(Math.abs(width - 612) < 1 && Math.abs(height - 792) < 1, 'Letter, no scaling'); }
  assert.strictEqual(doc.catalog.getViewerPreferences().getPrintScaling(), PrintScaling.None, 'viewer told to print at actual size');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, fn] of tests) { try { await fn(); pass++; console.log('  ✓ ' + n); } catch (e) { fail++; console.log('  ✗ ' + n + '\n    ' + e.message); } }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
