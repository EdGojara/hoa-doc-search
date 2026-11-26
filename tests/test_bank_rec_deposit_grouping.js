// Kat's bank reconciliation (lib/banking/monthly_rec): consolidated deposits.
// Receipts are recorded one per homeowner payment; the bank receives them as one processor payout
// (net of fees) or one remote/lockbox deposit of several checks. All ids, accounts, check numbers
// and amounts are invented.
const B = require('../lib/banking/monthly_rec');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const opening = { as_of_date: '2026-07-31', bank_balance_cents: 5000000, book_balance_cents: 5000000, outstanding_checks: [], deposits_in_transit: [] };
const openGl = { id: 'g0', je_id: 'j0', reference: 'OPEN', posting_date: '2026-07-31', amount_cents: 5000000, memo: 'Opening', description: 'Opening', source_module: 'opening_entry' };
const rcpt = (id, date, cents, memo, acct) => ({ id, je_id: 'je-' + id, reference: 'JE-' + id, posting_date: date, amount_cents: cents, memo, description: `Payment ${date} (Vantaca account ${acct})`, source_module: 'manual' });
const line = (id, date, cents, desc) => ({ id, bank_statement_import_id: 'imp9', posting_date: date, amount_cents: cents, description: desc, transaction_type: cents > 0 ? 'deposit' : 'debit' });
const run = ({ glLines, bankTxns, payouts = [], deposits = [], op = opening }) => {
  const aug = op.bank_balance_cents + bankTxns.filter((t) => t.bank_statement_import_id === 'imp8').reduce((s, t) => s + t.amount_cents, 0);
  const end = aug + bankTxns.filter((t) => t.bank_statement_import_id === 'imp9').reduce((s, t) => s + t.amount_cents, 0);
  return B.reconcileAccountMonth({ account: { id: 'opr', label: 'Operating 0001', gl_account_number: '1000' }, period_start: '2026-09-01', period_end: '2026-09-30', opening: op,
    statements: [{ id: 'imp8', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', beginning_balance_cents: op.bank_balance_cents, ending_balance_cents: aug },
      { id: 'imp9', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', beginning_balance_cents: aug, ending_balance_cents: end }],
    bankTxns, glLines: [openGl, ...glLines], otherBankTxns: [], homeownerPayments: [], settings: {}, codings: [], payouts, deposits });
};
const pay = (trxn, payout, acct, cents, type = 'Payment') => ({ trxn_date: trxn, payout_date: payout, account_ref: acct, amount_cents: cents, txn_type: type });

console.log('processor payout: one bank line, the payments listed in its payout contents');
{
  const gl = [rcpt('a', '2026-09-01', 50000, 'Vantaca 2026-09-01: Credit Card (VP) 0101', '20000001'), rcpt('b', '2026-09-01', 30000, 'Vantaca 2026-09-01: eCheck (VP) 0102', '20000002'),
    rcpt('c', '2026-09-01', 26500, 'Vantaca 2026-09-01: Credit Card (VP) 0103', '20000003'), rcpt('d', '2026-09-02', 30000, 'Vantaca 2026-09-02: eCheck (VP) 0104', '20000004')];
  const payouts = [pay('2026-09-01', '2026-09-03', '20000001', 50000), pay('2026-09-01', '2026-09-03', '20000002', 30000), pay('2026-09-01', '2026-09-03', '20000003', 26500), pay('2026-09-02', '2026-09-04', '20000004', 30000)];
  const r = run({ glLines: gl, payouts, bankTxns: [line('b1', '2026-09-03', 106500, 'Vantaca - Payout Vantaca - ST-TEST0001'), line('b2', '2026-09-04', 30000, 'Vantaca - Payout Vantaca - ST-TEST0003')] });
  const m1 = r.items.filter((i) => i.category === 'matched' && i.bank_transaction_id === 'b1');
  check('the three payments clear against the $1,065.00 payout', m1.length === 3 && m1.every((i) => i.match_method === 'payout_group' && i.match_confidence === 'high'), JSON.stringify(m1));
  check('the same-amount $300.00 payment from the next payout is not taken by the first', m1.every((i) => i.gl_ref !== 'JE-d') && r.items.some((i) => i.bank_transaction_id === 'b2' && i.gl_ref === 'JE-d'));
  check('nothing in transit, nothing bank-only, reconciled', !r.items.some((i) => ['deposit_in_transit', 'bank_only'].includes(i.category)) && r.status === 'reconciled' && r.totals.difference_cents === 0, JSON.stringify(r.totals));
  check('nothing is proposed (receipts are never re-posted)', r.proposals.length === 0);
}

console.log('a fee netted inside the payout is a bank item, not booked');
{
  const r = run({ glLines: [rcpt('a', '2026-09-08', 16000, 'Vantaca 2026-09-08: eCheck (VP) 0105', '20000050')],
    payouts: [pay('2026-09-08', '2026-09-14', '20000050', 16000), pay('2026-09-14', '2026-09-14', null, -500, 'Fee')],
    bankTxns: [line('b1', '2026-09-14', 15500, 'Vantaca - Payout Vantaca - ST-TEST0002')] });
  check('the payment clears against the net payout', r.items.some((i) => i.category === 'matched' && i.gl_ref === 'JE-a' && i.match_method === 'payout_group'));
  const n = r.items.find((i) => i.match_method === 'payout_group_net');
  check('the $5.00 fee is a bank item not in the GL', n && n.category === 'bank_only' && n.amount_cents === -500, JSON.stringify(n));
  check('balances to $0.00 with the fee open as an exception', r.totals.difference_cents === 0 && r.exceptions.some((e) => e.code === 'payout_net_item') && r.status === 'in_progress', JSON.stringify(r.totals));
}

console.log('a payout whose payments are not all in the books is not forced');
{
  const r = run({ glLines: [rcpt('a', '2026-09-01', 50000, 'Vantaca (VP)', '20000001')],
    payouts: [pay('2026-09-01', '2026-09-03', '20000001', 50000), pay('2026-09-01', '2026-09-03', '20000009', 12500)],
    bankTxns: [line('b1', '2026-09-03', 62500, 'Vantaca - Payout Vantaca - ST-TEST0004')] });
  check('no group match', !r.items.some((i) => i.match_method === 'payout_group'));
  const b = r.items.find((i) => i.bank_transaction_id === 'b1' && i.category === 'bank_only');
  check('the bank line names the payment missing from the GL', b && /20000009/.test(b.operator_notes) && /not in the GL/.test(b.operator_notes), b && b.operator_notes);
}

console.log('remote deposit of check receipts, no register');
{
  const gl = [rcpt('a', '2026-09-16', 65000, 'Vantaca 2026-09-16: Chk #1001 - Payment', '1'), rcpt('b', '2026-09-16', 20500, 'Vantaca 2026-09-16: Chk #1002 - Payment', '2'),
    rcpt('c', '2026-09-16', 2000, 'Vantaca 2026-09-16: Chk #1003 - Payment', '3'), rcpt('v', '2026-09-16', 71628, 'Vantaca 2026-09-16: eCheck (VP) 0106 - One time payment', '4')];
  const r = run({ glLines: gl, bankTxns: [line('b1', '2026-09-17', 87500, 'REMOTE DEPOSIT')] });
  const m = r.items.filter((i) => i.bank_transaction_id === 'b1' && i.category === 'matched');
  check('the three checks recorded 9/16 clear against the one deposit', m.length === 3 && m.every((i) => i.match_method === 'deposit_date_group'), JSON.stringify(m));
  check('the online payment of the same day is not pulled into the check deposit', r.items.some((i) => i.gl_ref === 'JE-v' && i.category === 'deposit_in_transit'));
}

console.log('opening deposits in transit deposited together (7/31 checks as one $2,205.00 deposit)');
{
  const dits = [2000, 2000, 2500, 12000, 60000, 7000, 61500, 6000, 61500, 6000].map((c, i) => ({ date: '2026-07-31', description: i < 6 ? 'Owner check' : 'Owner check #3001', amount_cents: c }));
  const op = { ...opening, bank_balance_cents: 5000000 - 220500, deposits_in_transit: dits };
  const r = run({ op, glLines: [], bankTxns: [{ ...line('b1', '2026-08-10', 220500, 'REMOTE DEPOSIT'), bank_statement_import_id: 'imp8' }] });
  check('all ten opening checks cleared against the $2,205.00 deposit (8/10)', r.cleared_since_prior.length === 0 && !r.items.some((i) => i.category === 'deposit_in_transit') && !r.items.some((i) => i.category === 'bank_only'), JSON.stringify(r.items));
  const late = run({ op, glLines: [], bankTxns: [line('b1', '2026-09-10', 220500, 'REMOTE DEPOSIT')] });
  check('a deposit 41 days later is outside the window and not grouped', late.items.some((i) => i.category === 'deposit_in_transit'));
  check('reconciled', r.totals.difference_cents === 0 && r.status === 'reconciled', JSON.stringify(r.totals));
}

console.log('ambiguity is left for a person');
{
  const gl = [rcpt('a', '2026-09-10', 10000, 'Chk #1', '1'), rcpt('b', '2026-09-10', 5000, 'Chk #2', '2'), rcpt('c', '2026-09-11', 7500, 'Chk #3', '3'), rcpt('d', '2026-09-11', 7500, 'Chk #4', '4')];
  const r = run({ glLines: gl, bankTxns: [line('b1', '2026-09-12', 15000, 'REMOTE DEPOSIT')] });
  check('two book dates both total $150.00: no group match', !r.items.some((i) => i.match_method === 'deposit_date_group'));
}

console.log('deposit register: check numbers decide between same-amount receipts');
{
  const gl = [rcpt('a', '2026-09-15', 3500, 'Vantaca 2026-09-15: Chk #2001 - Payment', '1'), rcpt('b', '2026-09-15', 3500, 'Vantaca 2026-09-15: Chk #2002 - Payment', '2'),
    rcpt('c', '2026-09-16', 3500, 'Vantaca 2026-09-16: Chk #2003 - Payment', '3'), rcpt('d', '2026-09-16', 12000, 'Vantaca 2026-09-16: Chk #2004 - Payment', '4')];
  const deposits = [{ deposit_date: '2026-09-16', check_number: '2003', amount_cents: 3500 }, { deposit_date: '2026-09-16', check_number: '2004', amount_cents: 12000 }];
  const r = run({ glLines: gl, deposits, bankTxns: [line('b1', '2026-09-16', 15500, 'REMOTE DEPOSIT')] });
  const m = r.items.filter((i) => i.bank_transaction_id === 'b1' && i.category === 'matched');
  check('register group clears exactly checks 2003 and 2004', m.length === 2 && m.every((i) => i.match_method === 'deposit_register_group') && m.some((i) => i.gl_ref === 'JE-c') && m.some((i) => i.gl_ref === 'JE-d'), JSON.stringify(m.map((i) => i.gl_ref)));
}

console.log('no payout or register data: behavior unchanged');
{
  const r = run({ glLines: [rcpt('a', '2026-09-02', 10000, 'x', '1')], bankTxns: [line('b1', '2026-09-03', 10000, 'Vantaca - Payout')] });
  check('a single payment still clears 1:1', r.items.some((i) => i.gl_ref === 'JE-a' && i.match_method === 'amount_date_proximity'));
}

check('groupConsolidatedDeposits is exported for reuse', typeof B.groupConsolidatedDeposits === 'function');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
