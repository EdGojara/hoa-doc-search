#!/usr/bin/env node
// ============================================================================
// test_ap_sales_tax_lines.js  (Ed 2026-10-15)
// ----------------------------------------------------------------------------
// A bill whose coded lines are its pre-tax subtotal must still reach the books;
// a bill whose lines don't add up for any other reason must be HELD, visibly.
//
// THE SCAR (Canyon Gate September close, 2026-10-15): two bills never posted.
//
//   Earthcare #1348         lines $8,862.58  tax $731.17  total $9,593.75
//   Star Protection #30053  lines $2,272.36  tax $187.48  total $2,459.84
//
// The extractor read the tax. Intake coded every line, then asked the split
// accrual to post lines == total without passing the tax, so the accrual
// refused, wrote one server log line, and the Payables screen said "GL coding
// incomplete". Nobody knew until Kat went hunting at close.
//
// Runs the REAL commitInvoice against an in-memory Supabase fake, with the
// line classifier and the journal-entry poster stubbed so the test sees exactly
// what would be written.
//
//   node tests/test_ap_sales_tax_lines.js
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const Module = require('module');

const { reconcileLines, salesTaxLines, LINES_HOLD_MARK } = require('../lib/ap/line_reconcile');

// ---- in-memory fake (same shape as tests/test_ap_commit_review_flag.js) ----
const db = { ap_invoices: [], ap_invoice_lines: [], journal_entries: [],
  communities: [{ id: 'c-cg', name: 'Canyon Gate at Cinco Ranch', management_status: 'active', books_of_record: 'trusted', financials_active: true }],
  chart_of_accounts: [{ id: 'acct-ap', community_id: 'c-cg', account_number: '2000', account_name: 'Accounts Payable', is_active: true }] };
function fakeClient() {
  return {
    from(table) {
      const st = { table, filters: [], op: 'select', payload: null };
      const rows = () => (db[table] || []).filter((r) => st.filters.every(([c, v]) => r[c] === v));
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        eq(c, v) { st.filters.push([c, v]); return q; }, neq() { return q; }, in() { return q; }, is() { return q; },
        ilike() { return q; }, or() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; }, gt() { return q; },
        insert(p) {
          st.op = 'insert';
          const list = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${table}-${(db[table] || []).length + i + 1}`, ...r }));
          if (!db[table]) db[table] = [];
          db[table].push(...list);
          st.inserted = list;
          return q;
        },
        update(p) { st.op = 'update'; st.payload = p; return q; },
        async single() { return { data: st.inserted ? st.inserted[0] : (rows()[0] || null), error: null }; },
        async maybeSingle() { return { data: st.op === 'insert' ? st.inserted[0] : (rows()[0] || null), error: null }; },
        then(res, rej) {
          if (st.op === 'update') { for (const r of rows()) Object.assign(r, st.payload); return Promise.resolve({ data: null, error: null }).then(res, rej); }
          if (st.op === 'insert') return Promise.resolve({ data: st.inserted, error: null }).then(res, rej);
          return Promise.resolve({ data: rows(), error: null }).then(res, rej);
        },
      };
      return q;
    },
    storage: { from() { return { upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }) }; } },
  };
}

// The classifier codes each line by a fixed map (5200 landscape, 5125 irrigation,
// 5770 security), and the poster records the journal entry it was handed.
const posted = [];
const CODE = (d) => (/valve|nozzle|solenoid/i.test(d) ? 'acct-5125' : /noncomm|supervisor|phone/i.test(d) ? 'acct-5770' : 'acct-5200');
const stubCodeLines = { codeInvoiceLines: async ({ lineItems }) => lineItems.map((l, i) => ({ line_number: i + 1, description: l.description, amount_cents: Math.round(Number(l.amount) * 100), is_credit: false, gl_account_id: CODE(l.description), confidence: 'high', reason: 'test map', needs_review: false })) };
const stubPosting = { postJournalEntry: async (je) => {
  const dr = je.lines.reduce((s, l) => s + l.debit_cents, 0), cr = je.lines.reduce((s, l) => s + l.credit_cents, 0);
  if (dr !== cr) throw new Error(`debits_${dr}_must_equal_credits_${cr}`);
  posted.push(je); return { entry: { id: `je-${posted.length}` } };
} };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient() };
  if (request === './code_lines' && /[\\/]lib[\\/]ap[\\/]intake\.js$/.test(parent && parent.filename)) return stubCodeLines;
  if (request === '../accounting/posting' && /[\\/]lib[\\/]ap[\\/]intake\.js$/.test(parent && parent.filename)) return stubPosting;
  return realLoad.apply(this, arguments);
};
const { commitInvoice, postAccrualForInvoice } = require('../lib/ap/intake');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });
const linesOf = (id) => db.ap_invoice_lines.filter((l) => l.invoice_id === id);
const inv = (id) => db.ap_invoices.find((r) => r.id === id);

// Real lines, scaled down: Star #30053's three lines, and an Earthcare-shaped
// repair bill split across two accounts.
const STAR = { invoice_number: '30053', invoice_date: '2026-10-05', vendor_name: 'Star Protection Agency LLC', total_cents: 245984, subtotal_cents: 227236, tax_cents: 18748,
  line_items: [{ description: 'Noncomm Regular', amount: 1650.91 }, { description: 'Site Supervisor Regular', amount: 604.80 }, { description: 'Phone', amount: 16.65 }] };

// ---- the rule ----
t('Earthcare #1348: lines $8,862.58 + stated tax $731.17 = $9,593.75 -> stated_tax', () => {
  const r = reconcileLines({ lineCents: [886258], totalCents: 959375, statedTaxCents: 73117 });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.kind, 'stated_tax'); assert.strictEqual(r.tax_cents, 73117);
});
t('Star #30053 with NO stated tax: the $187.48 gap is exactly 8.25% of $2,272.36 -> derived_tax', () => {
  const r = reconcileLines({ lineCents: [165091, 60480, 1665], totalCents: 245984, statedTaxCents: 0 });
  assert.strictEqual(r.kind, 'derived_tax'); assert.strictEqual(r.tax_cents, 18748); assert.strictEqual(r.rate, 0.0825);
  assert.match(r.message, /8\.25% Texas sales tax/);
});
t('Earthcare #1348 with no stated tax: also derivable (8.25%)', () => {
  assert.strictEqual(reconcileLines({ lineCents: [886258], totalCents: 959375 }).kind, 'derived_tax');
});
t('tax already itemized as a line (the usual Earthcare/Star shape): exact, nothing added', () => {
  const r = reconcileLines({ lineCents: [816875, 67393], totalCents: 884268, statedTaxCents: 67393 });
  assert.strictEqual(r.kind, 'exact'); assert.deepStrictEqual(salesTaxLines([{ amount_cents: 816875, gl_account_id: 'a' }], r), []);
});
t('any other gap is a mismatch with a plain reason (short, over, stated tax that does not explain it, odd rate)', () => {
  const short = reconcileLines({ lineCents: [900000], totalCents: 959375 });
  assert.strictEqual(short.kind, 'mismatch'); assert.match(short.message, /short by \$593\.75/);
  const over = reconcileLines({ lineCents: [500000, 500000], totalCents: 959375, statedTaxCents: 73117 });
  assert.strictEqual(over.kind, 'mismatch'); assert.match(over.message, /over by/); assert.match(over.message, /states \$731\.17 sales tax/);
  assert.strictEqual(reconcileLines({ lineCents: [880000], totalCents: 959375, statedTaxCents: 73117 }).kind, 'mismatch');
  assert.strictEqual(reconcileLines({ lineCents: [100000], totalCents: 110000 }).kind, 'mismatch', '10% is not a Texas sales tax rate');
  assert.strictEqual(reconcileLines({ lineCents: [], totalCents: 100 }).kind, 'no_lines');
});
t('tax splits proportionally across the accounts it taxes, to the cent', () => {
  const lines = [{ amount_cents: 500000, gl_account_id: 'L' }, { amount_cents: 300000, gl_account_id: 'I' }, { amount_cents: 86258, gl_account_id: 'L' }, { amount_cents: 0, gl_account_id: 'E' }];
  const tax = salesTaxLines(lines, { kind: 'stated_tax', tax_cents: 73117, rate: 0.0825 });
  assert.strictEqual(tax.reduce((s, l) => s + l.amount_cents, 0), 73117);
  assert.deepStrictEqual(tax.map((l) => l.gl_account_id).sort(), ['I', 'L']);
  assert.ok(tax.every((l) => l.description === 'Sales Tax'));
  assert.ok(Math.abs(tax.find((l) => l.gl_account_id === 'I').amount_cents - Math.round(73117 * 300000 / 886258)) <= 1);
});

// ---- intake, end to end ----
t('Star #30053 (stated tax) loads, gets a Sales Tax line on 5770, and POSTS a balanced accrual for the full $2,459.84', async () => {
  posted.length = 0;
  const out = await commitInvoice({ extracted: { ...STAR }, vendorId: 'v-star', communityId: 'c-cg', sha256: 'sha-star', storagePath: 's.pdf', intakeMethod: 'email', sourceRef: 'email:star' });
  const lines = linesOf(out.invoice_id);
  assert.deepStrictEqual(lines.map((l) => [l.description, l.amount_cents, l.gl_account_id]), [
    ['Noncomm Regular', 165091, 'acct-5770'], ['Site Supervisor Regular', 60480, 'acct-5770'], ['Phone', 1665, 'acct-5770'], ['Sales Tax', 18748, 'acct-5770']]);
  assert.strictEqual(out.posting_journal_entry_id, 'je-1', 'the accrual posts');
  const je = posted[0];
  assert.strictEqual(je.lines.find((l) => l.account_id === 'acct-ap').credit_cents, 245984);
  assert.strictEqual(je.lines.filter((l) => l.account_id === 'acct-5770').reduce((s, l) => s + l.debit_cents, 0), 245984);
  assert.strictEqual(out.lines_hold, null);
});

t('Earthcare-shaped repair bill split across two accounts: tax follows each account in proportion, posts for the total', async () => {
  posted.length = 0;
  const ex = { invoice_number: '1348', invoice_date: '2026-09-30', vendor_name: 'Earthcare Management, Inc.', total_cents: 959375, subtotal_cents: 886258, tax_cents: 73117,
    line_items: [{ description: 'Clock F Zone 2-8 - Broken Wires.', amount: 6000.00 }, { description: 'Clock A Zone 5 - Replace 2in valve that is not working.', amount: 2862.58 }] };
  const out = await commitInvoice({ extracted: ex, vendorId: 'v-earth', communityId: 'c-cg', sha256: 'sha-1348', storagePath: 'e.pdf', intakeMethod: 'email', sourceRef: 'email:1348' });
  const tax = linesOf(out.invoice_id).filter((l) => l.description === 'Sales Tax');
  assert.strictEqual(tax.reduce((s, l) => s + l.amount_cents, 0), 73117);
  assert.deepStrictEqual(tax.map((l) => l.gl_account_id).sort(), ['acct-5125', 'acct-5200']);
  assert.ok(out.posting_journal_entry_id);
  const je = posted[0];
  const debit = (a) => je.lines.filter((l) => l.account_id === a).reduce((s, l) => s + l.debit_cents, 0);
  assert.strictEqual(debit('acct-5200') + debit('acct-5125'), 959375);
  assert.ok(Math.abs(debit('acct-5125') - Math.round(286258 * 1.0825)) <= 2, `irrigation carries its own tax: ${debit('acct-5125')}`);
});

t('lines that do not add up (and the gap is not tax) are HELD: no journal entry of any shape, reason on the bill, manager review', async () => {
  posted.length = 0;
  const ex = { ...STAR, invoice_number: 'BAD-1', total_cents: 300000, tax_cents: 0 };
  const out = await commitInvoice({ extracted: ex, vendorId: 'v-star', communityId: 'c-cg', sha256: 'sha-bad', storagePath: 'b.pdf', intakeMethod: 'email', sourceRef: 'email:bad' });
  assert.strictEqual(out.posting_journal_entry_id, null);
  assert.strictEqual(posted.length, 0, 'not even the single-account fallback');
  const row = inv(out.invoice_id);
  assert.strictEqual(row.needs_review, true); assert.strictEqual(out.needs_review, true);
  assert.strictEqual(row.approval_path, 'manager_review');
  assert.ok(row.approval_path_reason.startsWith(`${LINES_HOLD_MARK}: `), row.approval_path_reason);
  assert.match(row.notes, /^Emma: ⚠ LINES DON'T ADD UP: Lines add up to \$2,272\.36 but the bill total is \$3,000\.00/);
  assert.match(out.lines_hold, /short by \$727\.64/);
  assert.ok(!linesOf(out.invoice_id).some((l) => l.description === 'Sales Tax'), 'no invented tax line');
});

t('staff-directed single account: the tax line goes to the directed account and keeps staff provenance', async () => {
  posted.length = 0;
  const GL = { account_id: 'acct-5770', account_number: '5770', account_name: 'Security Services' };
  const out = await commitInvoice({ extracted: { ...STAR, invoice_number: '30053-S' }, vendorId: 'v-star2', communityId: 'c-cg', sha256: 'sha-s', storagePath: 's2.pdf', intakeMethod: 'email', sourceRef: 'email:s', staffGl: GL });
  const tax = linesOf(out.invoice_id).find((l) => l.description === 'Sales Tax');
  assert.strictEqual(tax.amount_cents, 18748); assert.strictEqual(tax.gl_account_id, 'acct-5770');
  assert.match(tax.notes, /^Staff-directed: code 5770 Security Services/);
  assert.ok(out.posting_journal_entry_id);
});

t('Post as coded on an already-loaded bill whose lines are the subtotal (the two September bills today): posts, tax folded in', async () => {
  posted.length = 0;
  const id = await postAccrualForInvoice({ invoiceId: 'existing-30053', communityId: 'c-cg', vendorId: 'v-star',
    glLines: [{ accountId: 'acct-5770', cents: 165091 }, { accountId: 'acct-5770', cents: 60480 }, { accountId: 'acct-5770', cents: 1665 }],
    totalCents: 245984, taxCents: 18748, invoiceDate: '2026-10-05', vendorInvoiceNumber: '30053', vendorName: 'Star Protection Agency LLC' });
  assert.ok(id);
  assert.strictEqual(posted[0].lines.reduce((s, l) => s + l.debit_cents, 0), 245984);
  posted.length = 0;
  const refused = await postAccrualForInvoice({ invoiceId: 'existing-bad', communityId: 'c-cg', vendorId: 'v-star',
    glLines: [{ accountId: 'acct-5770', cents: 100000 }], totalCents: 245984, taxCents: 18748, invoiceDate: '2026-10-05' });
  assert.strictEqual(refused, null); assert.strictEqual(posted.length, 0);
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
  }
  Module._load = realLoad;
  console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} AP sales-tax line checks passed`);
  process.exit(failed ? 1 : 0);
})();
