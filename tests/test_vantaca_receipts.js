// ============================================================================
// tests/test_vantaca_receipts.js  (Ed 2026-10-31) — post-cutover Vantaca receipts
// ----------------------------------------------------------------------------
// Synthetic fixtures only (the repo is public; real reports carry homeowner
// account numbers and emails). Proves:
//   - Payout Contents page pairs read positionally, tie to the printed total, and a
//     row/amount count mismatch is a defect, never a silent shift;
//   - the Deposit Register reads wrapped online lines, keeps bank interest out of
//     receipts, and ties every section and the grand total;
//   - an online payment on both reports is ONE receipt;
//   - idempotency: a second plan after posting proposes nothing; the 10/11 Canyon
//     Gate refs (report ordinal) and refs listed on GL entries count as imported;
//   - unmatched accounts, same-amount payments from other paths and unlinked GL AR
//     credits are HELD while valid items still post;
//   - before-cutover items (and returns of them) stay with the conversion; the window
//     is the bank (settlement) date;
//   - each GL entry balances and its cash line equals the payout net;
//   - every proposed ledger value is one the database constraints accept;
//   - postPlan: refuses without an approver, writes draft -> GL -> commit, and skips
//     an entry whose reference already exists.
// Real reports, when present locally (VANTACA_RECEIPT_FIXTURES dir), must tie too.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/onboarding/adapters/vantaca/parsers');
const V = require('../lib/onboarding/adapters/vantaca');
const R = require('../lib/ar/vantaca_receipts');

let n = 0; const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const A = { sha256: 'a'.repeat(64) };

const PAYOUT = [
  '      Vantaca Pay Payout Contents for 8/1/2026 to 9/30/2026',
  '   Trxn Date    Payout Date   Description                         Type',
  '   Assoc: Example Ridge Homeowners Association, Inc (7) - ER Operating - 1234 ...1234',
  '   7/30/2026    8/4/2026      9000001 eCheck                       Payment',
  '   8/2/2026     8/4/2026      9000002 Card                         Payment',
  '   8/3/2026     8/6/2026      9000003 eCheck                       Payment',
  '   8/3/2026     8/6/2026      9000003 eCheck                       Payment',
  '   8/6/2026     8/6/2026      Failed Payment Fee                   Fee',
  '   8/6/2026     8/6/2026      9000004 The customer\'s bank account is frozen   Refund',
  '   8/20/2026    8/24/2026     9000099 Card                         Payment',
  '   Report generated on 10/1/2026 - V3.1                          Page 1',
  '      Vantaca Pay Payout Contents for 8/1/2026 to 9/30/2026',
  '       Amount',
  '            100.00',
  '            260.00',
  '            50.00',
  '            50.00',
  '            -5.00',
  '           -260.00',
  '            75.00',
  '   Report generated on 10/1/2026 - V3.1                          Page 2',
  '      Vantaca Pay Payout Contents for 8/1/2026 to 9/30/2026',
  '   Trxn Date    Payout Date   Description                         Type',
  '   9/28/2026    9/30/2026     9000005 eCheck                       Payment',
  '                                                                  Total 7',
  '                                              Total payout 9/30/2026',
  '   Report generated on 10/1/2026 - V3.1                          Page 3',
  '      Vantaca Pay Payout Contents for 8/1/2026 to 9/30/2026',
  '       Amount',
  '            300.00',
  '            570.00',
  '            570.00',
  '   Report generated on 10/1/2026 - V3.1                          Page 4',
].join('\n');

const REGISTER = [
  '                         Example Ridge',
  '                  Deposit Register For 8/1/2026 - 9/30/2026',
  '          Deposit Date      Description                                   Check          Amount',
  '   ER - Operating Cash',
  '                 8/2/2026    One time payment - Account Number: 9000002     1111          260.00',
  '                             Guest payment - a@b.com - Account',
  '                 8/3/2026                                                   2222           50.00',
  '                             Number: 9000003',
  '                 8/10/2026   Acct: 9000006 Check #501                                     400.00',
  '                 8/10/2026   Acct: 9000007 Check #77                                      125.00',
  '                 9/29/2026   Recurring Payment - Account Number: 9000008    3333           90.00',
  '                                                                                         $925.00',
  '   ER - Reserve',
  '                 8/31/2026   August Interest                                                1.10',
  '                                                                                           $1.10',
  '                                                                    Total:               $926.10',
  '   Report generated on 10/1/2026 9:35 AM - V3.21                                        Page 1',
].join('\n');

console.log('Vantaca receipts');

// ---------------------------------------------------------------- parsers
const pay = P.parseVantacaPayPayoutContents(PAYOUT, A);
const reg = P.parseDepositRegister(REGISTER, A);
t('payout contents: page pairs read positionally and tie to the printed total', () => {
  assert.deepStrictEqual(pay.defects, []);
  assert.strictEqual(pay.rows.length, 8);
  assert.strictEqual(pay.printed.total_payout_cents, 57000);
  assert.strictEqual(pay.rows.reduce((s, r) => s + r.amount_cents, 0), 57000);
  assert.strictEqual(pay.associations[0].bank_last4, '1234');
  assert.strictEqual(pay.associations[0].printed_total_cents, 57000);
  const fee = pay.rows.find((r) => r.type === 'Fee');
  assert.strictEqual(fee.source_account_key, null); assert.strictEqual(fee.amount_cents, -500);
  assert.ok(pay.rows.every((r) => r.provenance.artifact_sha256 === A.sha256 && r.provenance.locator.amount_line));
});
t('payout contents: a missing amount is a defect, never a shifted pairing', () => {
  const broken = PAYOUT.replace('            260.00\n', '');
  const p = P.parseVantacaPayPayoutContents(broken, A);
  assert.ok(p.defects.some((d) => d.code === 'PAYOUT_ROW_AMOUNT_COUNT_MISMATCH'));
});
t('deposit register: wrapped online line, checks, interest kept out, totals tie', () => {
  assert.deepStrictEqual(reg.defects, []);
  assert.strictEqual(reg.community, 'Example Ridge');
  const kinds = reg.rows.map((r) => r.item_kind);
  assert.deepStrictEqual(kinds, ['deposit_online', 'deposit_online', 'deposit_check', 'deposit_check', 'deposit_online', 'deposit_other']);
  assert.strictEqual(reg.rows[1].source_account_key, '9000003');
  assert.strictEqual(reg.rows[2].check_number, '501');
});
t('deposit register: a total that does not tie is a defect', () => {
  const p = P.parseDepositRegister(REGISTER.replace('$926.10', '$926.11'), A);
  assert.ok(p.defects.some((d) => d.code === 'DEPOSIT_TOTAL_MISMATCH'));
});
t('adapter identifies both reports', () => {
  assert.strictEqual(V.identify(PAYOUT).type, 'vantaca_pay_payouts');
  assert.strictEqual(V.identify(REGISTER).type, 'deposit_register');
  assert.strictEqual(V.cutoffCheck(V.identify(PAYOUT), '2026-07-31').ok, null);
});

// ---------------------------------------------------------------- plan
const acct = (pid, tid, current = true) => [{ property_id: pid, tenure_id: tid, current }];
function facts(over = {}) {
  return {
    community: { id: 'c1', slug: 'er', gl_cutover_date: '2026-08-01', management_company_id: 'm1' },
    accounts: new Map([['9000002', acct('p2', 't2')], ['9000003', acct('p3', 't3')], ['9000004', acct('p4', 't4')], ['9000005', acct('p5', 't5')],
      ['9000006', acct('p6', 't6', false)], ['9000007', acct('p7', 't7')], ['9000001', acct('p1', 't1')], ['9000008', acct('p8', 't8')]]),
    existingRefs: [], existingPayments: [], glArCredits: [], existingJeRefs: new Set(),
    gl: { ar: '1300', default_cash: '1000', cash_by_last4: { 1234: '1000' }, fee: '1380' },
    ...over,
  };
}
const norm = R.normalizeReceipts({ payouts: [pay], registers: [reg] });
const W = { from: '2026-08-01', to: '2026-10-31' };
const byStatus = (plan) => plan.items.reduce((m, i) => { m[i.status] = (m[i.status] || 0) + 1; return m; }, {});

t('an online payment on both reports is one receipt', () => {
  assert.strictEqual(norm.items.filter((i) => i.account === '9000002' && i.category === 'payment').length, 1);
  assert.ok(norm.items.find((i) => i.account === '9000002').corroborated_by);
  assert.strictEqual(norm.excluded.length, 1);   // bank interest
});
t('identical lines on one report keep separate identities', () => {
  const refs = norm.items.filter((i) => i.account === '9000003' && i.source === 'vantaca_pay').map((i) => i.vantaca_ref);
  assert.deepStrictEqual(refs.map((r) => r.slice(-2)), ['#1', '#2']);
});
const plan = R.planReceipts(norm, facts(), W);
t('statuses: before cutover, held unknown account, awaiting payout report, rest proposed', () => {
  const it = (a, c = 'payment') => plan.items.find((i) => i.account === a && i.category === c);
  assert.strictEqual(it('9000001').status, 'before_cutover');
  assert.strictEqual(it('9000099').status, 'held'); assert.strictEqual(it('9000099').reason, 'account_not_found_in_community');
  assert.strictEqual(it('9000008').status, 'held'); assert.strictEqual(it('9000008').reason, 'awaiting_payout_report');
  assert.strictEqual(it('9000004', 'returned_payment').status, 'proposed');
  assert.strictEqual(it('9000006').match.owner, 'former_owner');
  assert.ok(plan.reconciliation.every_item_in_one_bucket);
});
t('each GL entry balances and its cash line equals the payout net', () => {
  for (const e of plan.entries) assert.ok(e.balanced, e.source_reference);
  const aug6 = plan.entries.find((e) => e.posting_date === '2026-08-06');
  assert.strictEqual(aug6.net_cents, 5000 + 5000 - 500 - 26000);   // two payments, fee, return
  assert.strictEqual(aug6.lines[0].credit_cents, 16500);            // net debit to the bank, a cash credit
  assert.ok(aug6.lines.some((l) => l.account === '1380' && l.debit_cents === 500));
  const dep = plan.entries.find((e) => e.posting_date === '2026-08-10');
  assert.strictEqual(dep.net_cents, 52500); assert.strictEqual(dep.items.length, 2);
});
t('held items never stop the rest of the batch', () => {
  assert.ok(plan.entries.length >= 4);
  assert.ok(plan.items.filter((i) => i.status === 'held').length >= 2);
});
t('every proposed ledger value is one the database constraints accept', () => {
  const TXN = ['charge', 'payment', 'credit', 'adjustment', 'balance_brought_forward'];
  const CAT = ['assessment', 'late_fee', 'interest', 'fine', 'attorney_fee', 'admin_fee', 'payment', 'credit', 'refund', 'adjustment', 'prior_balance', 'other', 'certified_letter', 'attorney_fee_other', 'nsf_fee', 'payment_reversal', 'chargeback'];
  for (const r of plan.ledgerRows) {
    assert.ok(TXN.includes(r.txn_type)); assert.ok(CAT.includes(r.charge_category));
    if (r.reduction_source) assert.ok(r.reduction_source === 'cash_payment' && r.amount_cents < 0);
    if (r.charge_category === 'payment_reversal') assert.ok(r.amount_cents > 0);
    assert.strictEqual(r.raw_row_jsonb.source, 'vantaca_receipt'); assert.ok(r.raw_row_jsonb.vantaca_ref);
  }
});
t('idempotent: after posting, a second plan proposes nothing', () => {
  const postedRefs = plan.ledgerRows.map((r) => r.raw_row_jsonb.vantaca_ref);
  const feeRefs = plan.items.filter((i) => i.status === 'proposed' && i.category === 'processor_fee').map((i) => i.vantaca_ref);
  const again = R.planReceipts(norm, facts({ existingRefs: [...postedRefs, ...feeRefs], existingJeRefs: new Set(plan.entries.map((e) => e.source_reference)) }), W);
  assert.strictEqual(again.entries.length, 0); assert.strictEqual(again.ledgerRows.length, 0);
  assert.strictEqual(byStatus(again).already_imported, postedRefs.length + feeRefs.length);
});
t('the 10/11 Canyon Gate refs (report ordinal suffix) count as imported', () => {
  const it = norm.items.find((i) => i.account === '9000005');
  const legacy = it.vantaca_ref.replace(/#1$/, ':57');
  assert.strictEqual(R.legacyTuple(legacy), it.tuple);
  const p2 = R.planReceipts(norm, facts({ existingRefs: [legacy] }), W);
  assert.strictEqual(p2.items.find((i) => i.account === '9000005').status, 'already_imported');
});
t('same-amount payment from another path is held as a possible duplicate', () => {
  const p2 = R.planReceipts(norm, facts({ existingPayments: [{ id: 'x', vantaca_account_id: null, property_id: 'p7', date: '2026-08-08', amount_cents: 12500, source: 'check_receipt' }] }), W);
  const it = p2.items.find((i) => i.account === '9000007');
  assert.strictEqual(it.status, 'held'); assert.strictEqual(it.reason, 'possible_duplicate_of_existing_payment');
  assert.strictEqual(p2.items.find((i) => i.account === '9000006').status, 'proposed');
});
t('an unlinked GL credit to AR for the same owner and amount is held', () => {
  const p2 = R.planReceipts(norm, facts({ glArCredits: [{ line_id: 'l1', property_id: 'p6', date: '2026-08-11', amount_cents: 40000, reference: 'JE-1', linked: false }] }), W);
  assert.strictEqual(p2.items.find((i) => i.account === '9000006').reason, 'possible_duplicate_of_gl_ar_credit');
});
t('window is the settlement date; a fee without an account decision is held', () => {
  const p2 = R.planReceipts(norm, facts({ gl: { ar: '1300', default_cash: '1000', cash_by_last4: {}, fee: null } }), { from: '2026-09-01', to: '2026-10-31' });
  assert.strictEqual(p2.items.find((i) => i.account === '9000005').status, 'proposed');          // trxn 9/28, paid 9/30
  assert.strictEqual(p2.items.find((i) => i.account === '9000002').status, 'outside_window');    // paid 8/4
  const p3 = R.planReceipts(norm, facts({ gl: { ar: '1300', default_cash: '1000', cash_by_last4: {}, fee: null } }), W);
  assert.strictEqual(p3.items.find((i) => i.category === 'processor_fee').reason, 'fee_account_decision');
});
t('a return of a pre-cutover payment in the same payout stays with the conversion', () => {
  const extra = { ...norm, items: [...norm.items, { ...norm.items[0], category: 'returned_payment', signed_cents: -10000, amount_cents: 10000, trxn_date: '2026-08-04', vantaca_ref: 'VPAY:ret#1', tuple: 'VPAY:ret' }] };
  const p2 = R.planReceipts(extra, facts(), W);
  assert.strictEqual(p2.items.find((i) => i.vantaca_ref === 'VPAY:ret#1').status, 'before_cutover');
});

// ---------------------------------------------------------------- postPlan (fake database)
function fakeDb() {
  const calls = []; let id = 0;
  const api = {
    calls,
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    from(table) {
      const q = { table, op: null, payload: null, filters: [] };
      const chain = {
        select() { if (!q.op) q.op = 'select'; return chain; }, insert(p) { q.op = 'insert'; q.payload = p; return chain; }, update(p) { q.op = 'update'; q.payload = p; return chain; },
        eq(k, v) { q.filters.push([k, v]); return chain; }, neq() { return chain; }, limit() { return chain; },
        single() { return chain; },
        then(res, rej) {
          calls.push(q);
          let data = null;
          if (q.op === 'select') data = [];
          if (q.op === 'insert') data = Array.isArray(q.payload) ? q.payload.map(() => ({ id: `id${++id}` })) : { id: `id${++id}` };
          if (q.op === 'insert' && q.table === 'vantaca_imports') data = [{ id: `id${++id}` }];
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return chain;
    },
  };
  return api;
}
const coa = { 1000: { id: 'a1000', fund_id: 'f' }, 1300: { id: 'a1300', fund_id: 'f' }, 1380: { id: 'a1380', fund_id: 'f' } };
(async () => {
  await assert.rejects(R.postPlan(fakeDb(), plan, { ...facts(), coa }, { approvedBy: null }), /approvedBy required/);
  n++; console.log('  ok  postPlan refuses without a named approval');
  const db = fakeDb(); const posts = [];
  const skip = plan.entries[0].source_reference;
  const res = await R.postPlan(db, plan, { ...facts({ existingJeRefs: new Set([skip]) }), coa }, {
    approvedBy: 'Ed Gojara', sourceFiles: [{ name: 'p.pdf', sha256: 'b'.repeat(64), buffer: Buffer.from('x'), report_type: 'vantaca_pay_payouts', row_count: 8 }],
    post: async (o) => { posts.push(o); return { entry: { id: `je${posts.length}`, reference: `JE-${posts.length}` } }; },
  });
  const ops = db.calls.map((c) => `${c.op}:${c.table}`);
  assert.strictEqual(res.status, 'posted');
  assert.ok(ops.indexOf('insert:transaction_upload_batches') < ops.indexOf('insert:homeowner_transactions'));
  assert.strictEqual(db.calls.find((c) => c.op === 'insert' && c.table === 'transaction_upload_batches').payload.status, 'draft');
  assert.strictEqual(ops[ops.length - 1], 'update:transaction_upload_batches');
  assert.strictEqual(posts.length, plan.entries.length - 1);
  assert.ok(posts.every((p) => p.source_module === 'payment_intake' && p.lines.every((l) => l.account_id)));
  assert.ok(res.entries.find((e) => e.ref === skip).status === 'already_posted');
  assert.ok(ops.includes('insert:vantaca_imports'));
  n++; console.log('  ok  postPlan: source kept, draft batch -> GL -> commit, existing entry skipped');

  // Real reports, when available locally: they must read cleanly and tie.
  const dir = process.env.VANTACA_RECEIPT_FIXTURES;
  if (dir && fs.existsSync(dir)) {
    const { pdfToLayoutText } = require('../lib/onboarding/pdf_layout');
    for (const f of fs.readdirSync(dir).filter((x) => /\.pdf$/i.test(x))) {
      const text = await pdfToLayoutText(fs.readFileSync(path.join(dir, f)));
      const id = V.identify(text); if (!id || !['vantaca_pay_payouts', 'deposit_register'].includes(id.type)) continue;
      const p = V.parse(id.type, text, A);
      const printed = id.type === 'vantaca_pay_payouts' ? p.printed.total_payout_cents : p.printed.total_cents;
      assert.deepStrictEqual(p.defects, [], f);
      assert.strictEqual(p.rows.reduce((s, r) => s + r.amount_cents, 0), printed, f);
      n++; console.log(`  ok  real report ties: ${f} (${p.rows.length} rows)`);
    }
  }
  console.log(`\n${n} passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
