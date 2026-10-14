// Kat's bank reconciliation (lib/banking/monthly_rec): one bank line that is several GL lines.
// Shape: LOPF 8/31/2026, the Harned premium recorded as the AP payment (JE-2026-00238, $12,242.00)
// plus the ACH convenience fee (JE-2026-00239, $12.00); the bank drafted one $12,254.00 on 9/1.
const B = require('../lib/banking/monthly_rec');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const opening = { as_of_date: '2026-07-31', bank_balance_cents: 5000000, book_balance_cents: 5000000, outstanding_checks: [], deposits_in_transit: [] };
const openGl = { id: 'g0', je_id: 'j0', reference: 'OPEN', posting_date: '2026-07-31', amount_cents: 5000000, memo: 'Opening', description: 'Opening', source_module: 'opening_entry' };
const gl = (id, ref, date, cents, desc) => ({ id, je_id: 'je-' + id, reference: ref, posting_date: date, amount_cents: cents, memo: desc, description: desc, source_module: 'payment_intake' });
const run = ({ glLines, bankTxns, end }) => B.reconcileAccountMonth({ account: { id: 'opr', label: 'Operating 2449', gl_account_number: '1000' }, period_start: '2026-09-01', period_end: '2026-09-30', opening,
  statements: [{ id: 'imp8', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', beginning_balance_cents: 5000000, ending_balance_cents: 5000000 },
    { id: 'imp9', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', beginning_balance_cents: 5000000, ending_balance_cents: end }],
  bankTxns, glLines: [openGl, ...glLines], otherBankTxns: [], homeownerPayments: [], settings: {}, codings: [] });
const draft = (id, date, cents, desc) => ({ id, bank_statement_import_id: 'imp9', posting_date: date, amount_cents: cents, description: desc, transaction_type: 'debit' });

console.log('payment + fee drafted as one bank line');
{
  const r = run({ glLines: [gl('p', 'JE-2026-00238', '2026-08-31', -1224200, 'AP payment ach'), gl('f', 'JE-2026-00239', '2026-08-31', -1200, 'Harned Insurance ACH convenience fee')],
    bankTxns: [draft('b1', '2026-09-01', -1225400, 'INFOTEXAS CONSUL PAYMENTS 33696082')], end: 5000000 - 1225400 });
  const m = r.items.filter((i) => i.category === 'matched' && i.bank_transaction_id === 'b1');
  check('both GL lines clear against the one bank line', m.length === 2 && m.every((i) => i.match_method === 'combined_exact'), JSON.stringify(m));
  check('each names the other entry it cleared with', m.some((i) => /cleared together with JE-2026-00239/.test(i.operator_notes)) && m.some((i) => /cleared together with JE-2026-00238/.test(i.operator_notes)));
  check('no "unexplained" exception, no outstanding items, nothing proposed', !r.exceptions.some((e) => e.code === 'unexplained') && !r.items.some((i) => ['outstanding_check', 'bank_only'].includes(i.category)) && !r.proposals.length, JSON.stringify(r.exceptions));
  check('the month reconciles', r.totals.difference_cents === 0 && r.status === 'reconciled', JSON.stringify(r.totals));
}

console.log('one-to-one matching still wins');
{
  const r = run({ glLines: [gl('p', 'JE-1', '2026-09-02', -50000, 'AP payment'), gl('a', 'JE-2', '2026-09-02', -30000, 'AP payment'), gl('c', 'JE-3', '2026-09-02', -20000, 'AP payment')],
    bankTxns: [draft('b1', '2026-09-03', -50000, 'ACH VENDOR')], end: 5000000 - 50000 });
  const m = r.items.find((i) => i.category === 'matched' && i.bank_transaction_id === 'b1');
  check('an exact single GL line is matched 1:1, not as 30,000 + 20,000', m && m.gl_ref === 'JE-1' && m.match_method === 'amount_date_proximity', JSON.stringify(m));
}

console.log('ambiguous or distant combinations stay for a person');
{
  const r = run({ glLines: [gl('a', 'JE-A', '2026-09-02', -60000, 'x'), gl('b', 'JE-B', '2026-09-02', -40000, 'x'), gl('c', 'JE-C', '2026-09-02', -70000, 'x'), gl('d', 'JE-D', '2026-09-02', -30000, 'x')],
    bankTxns: [draft('b1', '2026-09-03', -100000, 'ACH')], end: 5000000 - 100000 });
  check('two combinations fit (60+40, 70+30): nothing clears, the bank line stays unexplained', !r.items.some((i) => i.match_method === 'combined_exact') && r.exceptions.some((e) => e.bank_transaction_id === 'b1'));
  const far = run({ glLines: [gl('a', 'JE-A', '2026-09-02', -60000, 'x'), gl('b', 'JE-B', '2026-09-20', -40000, 'x')], bankTxns: [draft('b1', '2026-09-21', -100000, 'ACH')], end: 5000000 - 100000 });
  check('GL lines 18 days apart are not combined', !far.items.some((i) => i.match_method === 'combined_exact'));
  const chk = run({ glLines: [{ ...gl('a', 'JE-A', '2026-09-02', -60000, 'Check 1001'), }, gl('b', 'JE-B', '2026-09-02', -40000, 'Check 1002')], bankTxns: [draft('b1', '2026-09-03', -100000, 'ACH')], end: 5000000 - 100000 });
  check('checks are never combined (a check clears as itself)', !chk.items.some((i) => i.match_method === 'combined_exact'));
  const sign = run({ glLines: [gl('a', 'JE-A', '2026-09-02', -110000, 'x'), gl('b', 'JE-B', '2026-09-02', 10000, 'x')], bankTxns: [draft('b1', '2026-09-03', -100000, 'ACH')], end: 5000000 - 100000 });
  check('lines of opposite sign are not netted into a match', !sign.items.some((i) => i.match_method === 'combined_exact'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
