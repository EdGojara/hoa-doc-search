// tests/test_je_transaction_summary.js — "what actually happened?" mapping for a
// journal entry (Ed 2026-09-28). Offline, in-memory fake. Proves each displayed
// fact comes from the named record, missing optional fields/documents/tables are
// handled (stated as gaps, never invented), and batch entries aren't mislabeled.
const assert = require('assert');
const { summarizeJournalEntry } = require('../lib/accounting/je_transaction_summary');

let failed = 0;
const results = [];
const t = (name, fn) => results.push({ name, fn });

function fake(tables, missing = []) {
  const db = JSON.parse(JSON.stringify(tables));
  return {
    from(name) {
      const st = { f: [], one: false };
      const api = {
        select() { return api; }, order() { return api; }, limit() { return api; },
        eq(c, v) { st.f.push((r) => r[c] === v); return api; },
        in(c, vs) { st.f.push((r) => vs.includes(r[c])); return api; },
        not(c, op, v) { st.f.push((r) => r[c] !== v); return api; },
        maybeSingle() { st.one = true; return api; },
        then(res) {
          if (missing.includes(name)) return res({ data: null, error: { message: `relation "${name}" does not exist` } });
          const rows = (db[name] || []).filter((r) => st.f.every((f) => f(r)));
          return res({ data: st.one ? (rows[0] || null) : rows, error: null });
        },
      };
      return api;
    },
  };
}
const COA = [{ id: 'a-ap', account_number: '2000', account_name: 'Accounts Payable' }, { id: 'a-cash', account_number: '1000', account_name: 'Operating Cash' },
  { id: 'a-disc', account_number: '4900', account_name: 'Early-pay Discounts' }, { id: 'a-sav', account_number: '1100', account_name: 'Savings', account_subtype: 'cash' },
  { id: 'a-clear', account_number: '1090', account_name: 'Cash in Transit - Clearing', account_subtype: 'current_asset' },
  { id: 'a-light', account_number: '5105', account_name: 'Electricity - Street Lights' }, { id: 'a-land', account_number: '5200', account_name: 'Landscaping' }];
const base = () => ({
  chart_of_accounts: COA, vendors: [{ id: 'v-nrg', name: 'NRG Business' }, { id: 'v-land', name: 'ABC Landscaping' }],
  bank_accounts: [{ id: 'b-op', community_id: 'c1', account_nickname: 'Operating Checking', bank_name: 'NewFirst', gl_account_number: '1000' }], user_profiles: [{ id: 'u-ed', full_name: 'Ed Gojara' }],
  properties: [{ id: 'p1', street_address: '603 Meadow Knoll Drive' }],
  journal_entries: [], journal_entry_lines: [], journal_entry_edits: [], ap_payments: [], ap_payment_applications: [], ap_invoices: [], ap_invoice_lines: [], ap_invoice_approvals: [],
  check_register: [], ar_payments: [], ar_charges: [],
});
const je = (o) => ({ id: 'je1', community_id: 'c1', reference: 'JE-1', status: 'posted', posting_date: '2026-08-05', total_debits_cents: 302085, total_credits_cents: 302085, ...o });
const noInvented = (s) => { for (const f of s.facts) assert.ok(f.value && !/null|undefined|NaN/.test(f.value) && f.source, JSON.stringify(f)); };

t('AP ACH payment: payee, method, date, amount, bill paid, bill expense account, invoice document, and the gaps', async () => {
  const d = base();
  d.journal_entries.push(je({ description: 'AP payment ach', source_module: 'payment_intake' }), { id: 'je-bill', reference: 'JE-0', status: 'posted' });
  d.journal_entry_lines.push({ journal_entry_id: 'je1', line_number: 1, account_id: 'a-ap', debit_cents: 302085, credit_cents: 0 }, { journal_entry_id: 'je1', line_number: 2, account_id: 'a-cash', debit_cents: 0, credit_cents: 302085 });
  d.ap_payments.push({ id: 'pay1', vendor_id: 'v-nrg', payment_date: '2026-08-05', amount_cents: 302085, payment_method: 'ach', check_number: null, bank_account_id: null, posting_journal_entry_id: 'je1', status: 'completed' });
  d.ap_payment_applications.push({ payment_id: 'pay1', invoice_id: 'inv1', applied_cents: 302085 });
  d.ap_invoices.push({ id: 'inv1', vendor_invoice_number: '114 014 568 021', invoice_date: '2026-07-20', total_cents: 302085, status: 'paid', source_storage_path: 'ap_invoices/nrg.pdf', posting_journal_entry_id: 'je-bill' });
  d.ap_invoice_lines.push({ invoice_id: 'inv1', description: 'Current Charges', amount_cents: 302085, gl_account_id: 'a-light' });
  const s = await summarizeJournalEntry(fake(d), 'je1');
  assert.deepStrictEqual([s.headline.kind, s.headline.title, s.headline.counterparty, s.headline.date], ['ap_payment', 'ACH payment — $3,020.85', 'NRG Business', '2026-08-05']);
  const f = Object.fromEntries(s.facts.map((x) => [x.label, x]));
  assert.strictEqual(f['Payee'].source, 'ap_payments.vendor_id → vendors.name');
  assert.ok(/Invoice 114 014 568 021 dated 2026-07-20/.test(f['Pays bill(s)'].value));
  assert.strictEqual(f['Bill originally charged to'].value, '5105 Electricity - Street Lights');
  assert.strictEqual(f['Paid from (GL cash account)'].value, '1000 Operating Cash');
  assert.ok(s.documents.some((x) => x.href === '/api/homeowner/file?kind=document&path=ap_invoices%2Fnrg.pdf'));
  assert.ok(s.links.some((l) => l.journal_entry_id === 'je-bill'), 'link to the bill entry');
  assert.ok(s.gaps.some((g) => /No bank account/.test(g)) && s.gaps.includes('No ACH reference number is recorded.'));
  assert.ok(/bank_accounts.gl_account_number/.test(f['Paid from (GL cash account)'].source));
  assert.deepStrictEqual(s.accounting.map((a) => [a.account, a.debit_cents, a.credit_cents]), [['2000 Accounts Payable', 302085, 0], ['1000 Operating Cash', 0, 302085]]);
  noInvented(s);
});
t('check payment: bank account and check register status; the check number is not repeated', async () => {
  const d = base();
  d.journal_entries.push(je({ description: 'AP payment check #1000', source_module: 'payment_intake' }));
  d.ap_payments.push({ id: 'pay1', vendor_id: 'v-land', payment_date: '2026-07-16', amount_cents: 833400, payment_method: 'check', check_number: '1000', bank_account_id: 'b-op', posting_journal_entry_id: 'je1', status: 'completed' });
  d.check_register.push({ ap_payment_id: 'pay1', check_number: '1000', status: 'cleared', cleared_date: '2026-07-30' });
  const s = await summarizeJournalEntry(fake(d), 'je1');
  const labels = s.facts.map((x) => x.label);
  assert.strictEqual(labels.filter((l) => /Check/.test(l) && /#/.test(l)).length, 1, labels.join());
  assert.strictEqual(s.facts.find((x) => x.label === 'Paid from').value, 'Operating Checking · NewFirst');
  assert.ok(/cleared 2026-07-30/.test(s.facts.find((x) => x.label === 'Check status').value));
  assert.ok(s.gaps.some((g) => /not applied to any bill/.test(g)), 'a payment with no bill says so');
  noInvented(s);
});
t('AP bill: vendor, invoice #, dates, charged-to accounts, approvals, paid-by, document', async () => {
  const d = base();
  d.journal_entries.push(je({ description: 'AP invoice 45721 — ABC Landscaping', source_module: 'ap_invoice', source_reference: 'inv1' }));
  d.ap_invoices.push({ id: 'inv1', vendor_id: 'v-land', vendor_invoice_number: '45721', invoice_date: '2026-08-01', due_date: '2026-08-31', total_cents: 150000, amount_paid_cents: 150000, status: 'paid', source_storage_path: 'ap_invoices/abc.pdf', intake_method: 'email', posting_journal_entry_id: 'je1' });
  d.ap_invoice_lines.push({ invoice_id: 'inv1', description: 'Monthly landscaping', amount_cents: 150000, gl_account_id: 'a-land' });
  d.ap_invoice_approvals.push({ invoice_id: 'inv1', action: 'released_for_payment', user_name: 'Ed', created_at: '2026-08-02T10:00:00Z' });
  d.ap_payment_applications.push({ payment_id: 'pay9', invoice_id: 'inv1', applied_cents: 150000 });
  d.ap_payments.push({ id: 'pay9', payment_date: '2026-08-05', payment_method: 'check', check_number: '1001', posting_journal_entry_id: 'je-pay' });
  const s = await summarizeJournalEntry(fake(d), 'je1');
  const f = Object.fromEntries(s.facts.map((x) => [x.label, x.value]));
  assert.deepStrictEqual([f['Vendor'], f['Invoice #'], f['Charged to'], f['Paid by']], ['ABC Landscaping', '45721', '5200 Landscaping', 'Check #1001 on 2026-08-05']);
  assert.ok(/released for payment by Ed 2026-08-02/.test(f['Approvals']));
  assert.ok(s.links.some((l) => l.journal_entry_id === 'je-pay'));
  noInvented(s);
});
t('reversal and voided entries point at each other; the void reason is shown', async () => {
  const d = base();
  d.journal_entries.push(je({ id: 'je-rev', reference: 'JE-9', source_module: 'reversal', reverses_je_id: 'je-orig', notes: 'Void reason: duplicate' }),
    je({ id: 'je-orig', reference: 'JE-5', status: 'voided', void_reversal_je_id: 'je-rev', description: 'AP invoice 17112' }));
  const r = await summarizeJournalEntry(fake(d), 'je-rev');
  assert.ok(/JE-5/.test(r.facts.find((x) => x.label === 'Reverses').value) && r.links[0].journal_entry_id === 'je-orig');
  assert.strictEqual(r.facts.find((x) => x.label === 'Why').value, 'Void reason: duplicate');
  const o = await summarizeJournalEntry(fake(d), 'je-orig');
  assert.ok(/JE-9/.test(o.facts.find((x) => x.label === 'Voided by').value));
});
t('migrated Vantaca entry: nothing invented; the gap says the source records were not migrated', async () => {
  const d = base();
  d.journal_entries.push(je({ source_module: 'vantaca_import', description: 'Daily activity 2026-01-02 (migrated from Vantaca GL detail)' }));
  const s = await summarizeJournalEntry(fake(d), 'je1');
  assert.strictEqual(s.facts.length, 0);
  assert.strictEqual(s.headline.counterparty, null);
  assert.ok(s.gaps.some((g) => /not migrated/.test(g)) && s.gaps.some((g) => /No supporting document/.test(g)));
});
t('a batch/conversion entry linked to many homeowner records is not headlined as one of them', async () => {
  const d = base();
  d.journal_entries.push(je({ source_module: 'opening_entry', description: 'Opening balances' }));
  d.ar_payments.push({ property_id: 'p1', posting_journal_entry_id: 'je1', amount_cents: 10960, payment_date: '2026-06-20' }, { property_id: 'p1', posting_journal_entry_id: 'je1', amount_cents: 500, payment_date: '2026-06-20' });
  const s = await summarizeJournalEntry(fake(d), 'je1');
  assert.strictEqual(s.headline.title, 'Opening balances');
  assert.ok(/2 payment\(s\)/.test(s.facts[0].value));
});
t('single homeowner payment: property address from the payment record', async () => {
  const d = base();
  d.journal_entries.push(je({ source_module: 'payment_intake' }));
  d.ar_payments.push({ property_id: 'p1', posting_journal_entry_id: 'je1', amount_cents: 25000, payment_date: '2026-09-01', source: 'stripe', source_reference: 'pi_123', status: 'received' });
  const s = await summarizeJournalEntry(fake(d), 'je1');
  assert.deepStrictEqual([s.headline.kind, s.headline.counterparty], ['homeowner_payment', '603 Meadow Knoll Drive']);
});
t('graceful: missing tables, no documents, manual entry with no poster, unknown entry', async () => {
  const d = base();
  d.journal_entries.push(je({ source_module: 'manual', description: 'Reclass' }));
  d.journal_entry_lines.push({ journal_entry_id: 'je1', line_number: 1, account_id: 'a-land', debit_cents: 100, credit_cents: 0, vendor_id: 'v-land' });
  const s = await summarizeJournalEntry(fake(d, ['ap_payments', 'check_register', 'ar_payments', 'ar_charges', 'journal_entry_edits']), 'je1');
  assert.strictEqual(s.facts.find((x) => x.label === 'Vendor').source, 'journal_entry_lines.vendor_id → vendors.name');
  assert.ok(s.gaps.some((g) => /not recorded \(posted_by_user_id/.test(g)) && s.gaps.some((g) => /No supporting document/.test(g)));
  assert.strictEqual(s.origin.posted_by, null);
  assert.deepStrictEqual(s.audit.edits, []);
  assert.strictEqual((await summarizeJournalEntry(fake(d), 'nope')).error, 'not_found');
});

// ---- "Paid from" never guesses; gap wording follows the actual method ----
const payWith = (method, creditLines, extra = {}) => {
  const d = base();
  d.journal_entries.push(je({ description: `AP payment ${method}`, source_module: 'payment_intake' }));
  d.journal_entry_lines.push({ journal_entry_id: 'je1', line_number: 1, account_id: 'a-ap', debit_cents: 302085, credit_cents: 0 },
    ...creditLines.map((c, i) => ({ journal_entry_id: 'je1', line_number: i + 2, account_id: c[0], debit_cents: 0, credit_cents: c[1], bank_account_id: c[2] || null })));
  d.ap_payments.push({ id: 'pay1', vendor_id: 'v-nrg', payment_date: '2026-08-05', amount_cents: 302085, payment_method: method, check_number: null, bank_account_id: null, posting_journal_entry_id: 'je1', status: 'completed', ...extra });
  return d;
};
t('a multi-credit entry whose first credit is NOT cash (discount first) is not mislabeled; the real cash line is used', async () => {
  const s = await summarizeJournalEntry(fake(payWith('ach', [['a-disc', 5000], ['a-cash', 297085]])), 'je1');
  assert.strictEqual(s.facts.find((x) => /Paid from/.test(x.label)).value, '1000 Operating Cash');
});
t('no credited account is a known bank/cash account (clearing only): no "Paid from" at all, stated as a gap', async () => {
  const s = await summarizeJournalEntry(fake(payWith('credit_card', [['a-clear', 302085]])), 'je1');
  assert.ok(!s.facts.some((x) => /Paid from/.test(x.label)), JSON.stringify(s.facts));
  assert.ok(s.gaps.some((g) => /can't be determined from the ledger lines \(no credited account is a known bank\/cash account\)/.test(g)), s.gaps.join(' | '));
  assert.ok(s.gaps.includes('No card transaction reference is recorded.'));
});
t('two cash accounts credited: ambiguous, so no guess', async () => {
  const s = await summarizeJournalEntry(fake(payWith('wire', [['a-cash', 200000], ['a-sav', 102085]])), 'je1');
  assert.ok(!s.facts.some((x) => /Paid from/.test(x.label)));
  assert.ok(s.gaps.some((g) => /2 cash accounts credited/.test(g)) && s.gaps.includes('No wire reference number is recorded.'));
});
t('a credit line explicitly tagged with a bank account names that bank', async () => {
  const s = await summarizeJournalEntry(fake(payWith('ach', [['a-cash', 302085, 'b-op']])), 'je1');
  const f = s.facts.find((x) => x.label === 'Paid from');
  assert.deepStrictEqual([f.value, f.source], ['Operating Checking · NewFirst', 'journal_entry_lines.bank_account_id → bank_accounts.account_nickname']);
});
t('reference-number gap wording follows the method; none when a reference exists', async () => {
  for (const [m, want] of [['cash', 'No payment reference number is recorded.'], ['other', 'No payment reference number is recorded.'], ['check', 'No check number is recorded.']]) {
    const s = await summarizeJournalEntry(fake(payWith(m, [['a-cash', 302085]])), 'je1');
    assert.ok(s.gaps.includes(want), `${m}: ${s.gaps.join(' | ')}`);
    assert.ok(!s.gaps.some((g) => /ACH/.test(g)), `${m} must not be called ACH`);
  }
  const withRef = await summarizeJournalEntry(fake(payWith('wire', [['a-cash', 302085]], { check_number: 'FED-123' })), 'je1');
  assert.ok(!withRef.gaps.some((g) => /reference|check number/.test(g)));
});

(async () => {
  for (const { name, fn } of results) {
    try { await fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall transaction-summary checks passed');
  process.exitCode = failed ? 1 : 0;
})();
