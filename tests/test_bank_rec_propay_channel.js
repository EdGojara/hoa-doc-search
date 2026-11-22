// ProPay credits and payment channels in Kat's bank reconciliation (lib/banking/monthly_rec).
// A "PROPAY TRANSFER" credit is a homeowner e-payment (a receipt to identify by payer), never an
// inter-account transfer. A GL line recorded as one channel's settlement (a Vantaca Pay payout)
// never clears a bank line of another channel (a ProPay credit) of the same amount: otherwise the
// ProPay receipt is hidden and the real payout shows as unrecorded. All ids, accounts, addresses and
// amounts are invented.
const B = require('../lib/banking/monthly_rec');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

console.log('classification');
check('a ProPay credit is a receipt, not a transfer', B.classifyBankLine({ amount_cents: 15000, description: 'PROPAY TRANSFER XXXXX0001', transaction_type: 'transfer' }) === 'unrecorded_receipt');
check('a ProPay credit typed ach_in is a receipt', B.classifyBankLine({ amount_cents: 7300, description: 'PROPAY TRANSFER XXXXX0002', transaction_type: 'ach_in' }) === 'unrecorded_receipt');
check('a ProPay debit is unchanged (transfer, for a person)', B.classifyBankLine({ amount_cents: -16000, description: 'PROPAY TRANSFER XXXXX0003', transaction_type: 'ach_out' }) === 'transfer');
check('an ICS sweep is still a transfer', B.classifyBankLine({ amount_cents: 1000000, description: 'TRANSFER FROM SWEEP ACCOUNT' }) === 'transfer');

const account = { id: 'opr', label: 'Operating', gl_account_number: '1000' };
const opening = { as_of_date: '2026-07-31', bank_balance_cents: 100000, outstanding_checks: [], deposits_in_transit: [] };
const settings = { stale_check_days: 90, stale_deposit_days: 10, match_window_days: 45 };
const gl0 = { id: 'g0', je_id: 'j0', reference: 'OPEN', posting_date: '2026-07-31', amount_cents: 100000, memo: 'Opening', description: 'Opening', source_module: 'opening_entry' };
const vp = { id: 'g1', je_id: 'j1', reference: 'JE-T-1', posting_date: '2026-09-04', amount_cents: 15000, memo: 'Vantaca Pay payout 2026-09-09', description: 'Payment - Vantaca Pay Card 2026-09-04 (settled 2026-09-09)', source_module: 'manual' };
const s8 = { id: 'i8', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', beginning_balance_cents: 100000, ending_balance_cents: 115000 };
const s9 = { id: 'i9', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', beginning_balance_cents: 115000, ending_balance_cents: 130000 };
const propay = { id: 'b-propay', bank_statement_import_id: 'i8', posting_date: '2026-08-31', amount_cents: 15000, description: 'PROPAY TRANSFER XXXXX0001', check_number: null, transaction_type: 'ach_in' };
const payout = { id: 'b-payout', bank_statement_import_id: 'i9', posting_date: '2026-09-09', amount_cents: 15000, description: 'Vantaca - Payout Vantaca - ST-TEST0001', check_number: null, transaction_type: 'ach_in' };
const base = { account, period_start: '2026-09-01', period_end: '2026-09-30', opening, statements: [s8, s9], bankTxns: [propay, payout], glLines: [gl0, vp], otherBankTxns: [], homeownerPayments: [], settings, codings: [] };

console.log('channel-aware matching');
const r = B.reconcileAccountMonth(base);
const m = r.items.find((i) => i.category === 'matched' && i.gl_ref === 'JE-T-1');
check('the Vantaca Pay GL line clears the Vantaca payout, not the nearer ProPay credit', m && m.bank_transaction_id === 'b-payout', JSON.stringify(r.items));
check('the ProPay credit stays a receipt to identify (not a transfer)', r.exceptions.some((e) => e.bank_transaction_id === 'b-propay' && e.code === 'unrecorded_receipt') && !r.exceptions.some((e) => e.code === 'transfer'), JSON.stringify(r.exceptions.map((e) => e.code)));
check('the books still tie', r.totals.difference_cents === 0, JSON.stringify(r.totals));

const plainGl = { ...vp, memo: 'Payment', description: 'Homeowner payment' };
const r2 = B.reconcileAccountMonth({ ...base, glLines: [gl0, plainGl] });
// (it clears the nearer 8/31 line, an August clearing, so the 9/9 payout is the one left open)
check('a GL line naming no channel still matches by amount and nearest date', !r2.exceptions.some((e) => e.bank_transaction_id === 'b-propay') && r2.exceptions.some((e) => e.bank_transaction_id === 'b-payout'), JSON.stringify(r2.exceptions));

console.log('the ProPay credit can then be coded to its owner');
const owners = { '9000001': { property_id: 'p001', tenure_id: 't001', contact_id: 'k001', trusted_account_number: 'T-001', address: '100 Test Lane' } };
const coding = { bank_transaction_id: 'b-propay', basis: 'ProPay transaction report', receipts: [{ vantaca_account_id: '9000001', payment_date: '2026-08-31', amount_cents: 15000, method: 'ProPay eCheck' }] };
const r3 = B.reconcileAccountMonth({ ...base, codings: [coding], receiptOwners: owners, undepositedAccount: '1020' });
const p = r3.proposals.find((x) => x.kind === 'homeowner_receipts');
check('proposed as a homeowner payment: Dr 1020 / Cr 1300 on 8/31, deposit Dr 1000 / Cr 1020', p && p.receipts.length === 1 && p.receipts[0].lines[1].account_number === '1300' && p.receipts[0].lines[1].property_id === 'p001' && p.lines[0].account_number === '1000' && p.lines[1].account_number === '1020', JSON.stringify(r3.exceptions.map((e) => e.text)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
