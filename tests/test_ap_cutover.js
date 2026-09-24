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

t('date rule for a reviewed NOT_IN invoice: dated BEFORE cutover -> the cutover date', () => {
  assert.strictEqual(apInvoicePostingDate('2026-07-13', CUT), CUT);
});
t('date rule: dated ON cutover -> its own date', () => {
  assert.strictEqual(apInvoicePostingDate('2026-08-01', CUT), '2026-08-01');
});
t('date rule: dated AFTER cutover -> its own date', () => {
  assert.strictEqual(apInvoicePostingDate('2026-08-11', CUT), '2026-08-11');
});
t('date rule for a late-arriving invoice (dated 7/13, processed 9/24) -> cutover; invoice date is not rewritten', () => {
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
// ---- pre-cutover review policy (mig 458, lib/ap/cutover_review.js) ----------
const { isPreCutover, reviewPreCutoverInvoice, preCutoverHold } = require('../lib/ap/cutover_review');
function fakeDb(seed) {
  const db = JSON.parse(JSON.stringify(seed));
  const from = (table) => {
    const f = []; let upd = null;
    const api = {
      select() { return api; }, eq(c, v) { f.push((r) => r[c] === v); return api; },
      update(p) { upd = p; return api; },
      maybeSingle() { return api._run(true); }, single() { return api._run(true); },
      then(res, rej) { return api._run(false).then(res, rej); },
      _run(one) {
        const rows = (db[table] || []).filter((r) => f.every((fn) => fn(r)));
        if (upd) rows.forEach((r) => Object.assign(r, upd));
        return Promise.resolve({ data: one ? rows[0] || null : rows, error: null });
      },
    };
    return api;
  };
  return { db, client: { from } };
}
const seedDb = (inv) => ({
  communities: [{ id: 'c1', gl_cutover_date: CUT }],
  chart_of_accounts: [{ id: 'ap', community_id: 'c1', account_number: '2000', is_active: true }],
  ap_invoice_lines: [{ invoice_id: 'i1', gl_account_id: 'exp', amount_cents: 1700, tax_amount_cents: 34 }],
  ap_invoices: [{ id: 'i1', community_id: 'c1', vendor_id: 'v1', vendor_invoice_number: 'N-1', invoice_date: '2026-07-13', total_cents: 1734, status: 'awaiting_approval', posting_journal_entry_id: null, cutover_review: 'PENDING', ...inv }],
});

t('pre-cutover test: before / on / after cutover, and no cutover', () => {
  assert.deepStrictEqual([isPreCutover('2026-07-13', CUT), isPreCutover('2026-08-01', CUT), isPreCutover('2026-08-11', CUT), isPreCutover('2026-07-13', null)], [true, false, false, false]);
});
t('intake gate holds a pre-cutover invoice and lets on/after-cutover invoices post', async () => {
  const { client } = fakeDb(seedDb({}));
  assert.strictEqual((await preCutoverHold(client, 'c1', '2026-07-13')).hold, true);
  assert.strictEqual((await preCutoverHold(client, 'c1', '2026-08-01')).hold, false);
  assert.strictEqual((await preCutoverHold(client, 'c1', '2026-08-11')).hold, false);
});
t('ALREADY_IN_CONVERTED_BOOKS: recorded, no GL posting', async () => {
  const { client, db } = fakeDb(seedDb({}));
  let posted = 0;
  await reviewPreCutoverInvoice(client, { invoiceId: 'i1', decision: 'ALREADY_IN_CONVERTED_BOOKS', reviewedBy: 'Ed' }, { postJournalEntry: async () => { posted++; } });
  const inv = db.ap_invoices[0];
  assert.deepStrictEqual([posted, inv.cutover_review, inv.posting_journal_entry_id, inv.invoice_date, inv.cutover_reviewed_by], [0, 'ALREADY_IN_CONVERTED_BOOKS', null, '2026-07-13', 'Ed']);
});
t('NOT_IN_CONVERTED_BOOKS: posts once, effective the cutover date, through the guarded poster; invoice date kept', async () => {
  const { client, db } = fakeDb(seedDb({}));
  const calls = [];
  await reviewPreCutoverInvoice(client, { invoiceId: 'i1', decision: 'NOT_IN_CONVERTED_BOOKS', reviewedBy: 'Ed' },
    { postJournalEntry: async (o) => { calls.push(o); return { entry: { id: 'je-new' } }; } });
  assert.strictEqual(calls.length, 1);
  const o = calls[0];
  assert.strictEqual(o.posting_date, CUT);
  assert.strictEqual(o.ap_posting, true);
  const dr = o.lines.reduce((a, l) => a + (l.debit_cents || 0), 0); const cr = o.lines.reduce((a, l) => a + (l.credit_cents || 0), 0);
  assert.deepStrictEqual([dr, cr], [1734, 1734]);
  assert.deepStrictEqual([db.ap_invoices[0].posting_journal_entry_id, db.ap_invoices[0].invoice_date], ['je-new', '2026-07-13']);
});
t('NEEDS_REVIEW: stays out of the GL; can be decided later', async () => {
  const { client, db } = fakeDb(seedDb({}));
  let posted = 0;
  await reviewPreCutoverInvoice(client, { invoiceId: 'i1', decision: 'NEEDS_REVIEW', reviewedBy: 'Ed' }, { postJournalEntry: async () => { posted++; } });
  assert.deepStrictEqual([posted, db.ap_invoices[0].cutover_review, db.ap_invoices[0].needs_review], [0, 'NEEDS_REVIEW', true]);
  await reviewPreCutoverInvoice(client, { invoiceId: 'i1', decision: 'ALREADY_IN_CONVERTED_BOOKS', reviewedBy: 'Ed' });
  assert.strictEqual(db.ap_invoices[0].cutover_review, 'ALREADY_IN_CONVERTED_BOOKS');
});
t('a final decision cannot be flipped, and an on/after-cutover invoice cannot be put through review', async () => {
  const done = fakeDb(seedDb({ cutover_review: 'ALREADY_IN_CONVERTED_BOOKS' }));
  await assert.rejects(() => reviewPreCutoverInvoice(done.client, { invoiceId: 'i1', decision: 'NOT_IN_CONVERTED_BOOKS', reviewedBy: 'Ed' }), /already decided/);
  const late = fakeDb(seedDb({ invoice_date: '2026-08-11', cutover_review: null }));
  await assert.rejects(() => reviewPreCutoverInvoice(late.client, { invoiceId: 'i1', decision: 'NOT_IN_CONVERTED_BOOKS', reviewedBy: 'Ed' }), /not_dated_before_cutover/);
  await assert.rejects(() => reviewPreCutoverInvoice(done.client, { invoiceId: 'i1', decision: 'MAYBE', reviewedBy: 'Ed' }), /decision must be/);
});
t('intake no longer auto-posts pre-cutover invoices (review gate, not a date move)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/ap/intake.js'), 'utf8');
  assert.ok(!/apPostingDateFor|apInvoicePostingDate/.test(src), 'intake still moves pre-cutover invoices to the cutover date');
  assert.strictEqual((src.match(/await cutoverPostingDate\(a\)/g) || []).length, 2, 'both accrual paths must pass the review gate');
});
t('AP aging never counts an invoice already in the converted books', () => {
  const { openApAsOf } = require('../lib/accounting/ap_as_of');
  const rows = openApAsOf({ invoices: [{ id: 'x', invoice_date: '2026-07-13', total_cents: 1000, status: 'awaiting_approval', posting_journal_entry_id: null, cutover_review: 'ALREADY_IN_CONVERTED_BOOKS' }],
    jesById: {}, applications: [], paymentsById: {}, asOf: '2026-09-24', cutoverDate: CUT });
  assert.strictEqual(rows.length, 0);
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
