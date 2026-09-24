#!/usr/bin/env node
// ============================================================================
// No native AP posting may land before a community's gl_cutover_date
// (lib/accounting/cutover.js + the hard guard in lib/accounting/posting.js).
// Scar 2026-09-24: AP intake posted an NRG bill dated 7/13 into LOPF's certified
// July (cutover 8/1) and moved the 7/31 trial balance by $440.72.
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { apInvoicePostingDate, assertNotBeforeCutover, getGlCutoverDate } = require('../lib/accounting/cutover');

let failed = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const CUT = '2026-08-01';

t('invoice dated BEFORE cutover posts on the cutover date', () => {
  assert.strictEqual(apInvoicePostingDate('2026-07-13', CUT), CUT);
});
t('invoice dated ON cutover posts on its own date', () => {
  assert.strictEqual(apInvoicePostingDate('2026-08-01', CUT), '2026-08-01');
});
t('invoice dated AFTER cutover posts on its own date', () => {
  assert.strictEqual(apInvoicePostingDate('2026-08-11', CUT), '2026-08-11');
});
t('late-arriving invoice (dated 7/13, processed 9/24) posts at cutover; invoice date is not rewritten', () => {
  const invoice = { invoice_date: '2026-07-13', processed_at: '2026-09-24' };
  assert.strictEqual(apInvoicePostingDate(invoice.invoice_date, CUT), CUT);
  assert.strictEqual(invoice.invoice_date, '2026-07-13');
});
t('no cutover on file: the invoice date stands', () => {
  assert.strictEqual(apInvoicePostingDate('2026-07-13', null), '2026-07-13');
});
t('a timestamp invoice date is handled as its day', () => {
  assert.strictEqual(apInvoicePostingDate('2026-07-31T23:00:00Z', CUT), CUT);
});
t('a missing invoice date is refused, never guessed', () => {
  assert.throws(() => apInvoicePostingDate(null, CUT), /invoice_date_required/);
});
t('hard guard: a posting dated before cutover throws before_gl_cutover', () => {
  assert.throws(() => assertNotBeforeCutover('2026-07-31', CUT), (e) => e.code === 'before_gl_cutover');
});
t('hard guard: on / after cutover and no-cutover pass', () => {
  assertNotBeforeCutover('2026-08-01', CUT);
  assertNotBeforeCutover('2026-09-24', CUT);
  assertNotBeforeCutover('2020-01-01', null);
});
t('an unreadable cutover throws; it never reads as "no cutover"', async () => {
  const bad = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
  await assert.rejects(() => getGlCutoverDate(bad, 'c1'), (e) => e.code === 'cutover_lookup_failed');
});
t('every AP posting call site is covered by the guard', () => {
  const files = ['lib/ap/intake.js', 'lib/accounting/ap_engine.js', 'lib/ap/add_convenience_fee.js', 'lib/ap/early_prepay.js', 'lib/accounting/record_vendor_payment.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const re = /postJ(?:ournalEntry|E)\(\{([\s\S]*?)\}\);/g;
    let m; let n = 0;
    while ((m = re.exec(src))) {
      n++;
      const body = m[1];
      const guarded = /ap_posting:\s*true/.test(body) || /source_module:\s*'(ap_invoice|payment_intake)'/.test(body);
      assert.ok(guarded, `${f}: an AP posting call is not covered by the cutover guard:\n${body.slice(0, 160)}`);
    }
    assert.ok(n > 0, `${f}: no posting call found (test is stale)`);
  }
});
t('LIVE: the real poster refuses an AP entry dated before LOPF cutover (checked before any write)', async () => {
  if (!process.env.SUPABASE_URL) return console.log('      (skipped: no SUPABASE_URL)');
  const { postJournalEntry } = require('../lib/accounting/posting');
  await assert.rejects(() => postJournalEntry({
    community_id: 'a0000000-0000-4000-8000-000000000002', posting_date: '2026-07-13',
    description: 'TEST cutover guard (must be refused; never written)', source_module: 'ap_invoice',
    lines: [{ account_id: '00000000-0000-0000-0000-000000000001', debit_cents: 1 }, { account_id: '00000000-0000-0000-0000-000000000002', credit_cents: 1 }],
  }), (e) => e.code === 'before_gl_cutover');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
  }
  console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
