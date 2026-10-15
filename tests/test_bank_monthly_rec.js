// Kat's monthly bank reconciliation (lib/banking/monthly_rec.reconcileAccountMonth): pure engine tests.
// Shapes mirror Canyon Gate's August/September 2026 (NewFirst 5313 / GL 1000).
const { reconcileAccountMonth, classifyBankLine, reportText } = require('../lib/banking/monthly_rec');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const account = { id: 'ba1', label: 'Operating 5313', gl_account_number: '1000' };
const opening = { as_of_date: '2026-07-31', bank_balance_cents: 100000, book_balance_cents: 115000,
  outstanding_checks: [{ check_number: '27', amount_cents: 20000, issue_date: '2026-07-14', payee: 'Welder' }],
  deposits_in_transit: [{ amount_cents: 35000, date: '2026-07-31', description: 'Payout ST-A' }], opening_book_refs: ['JE-SPLIT'] };
const settings = { bank_fee_account: '5010', stale_check_days: 90, stale_deposit_days: 10, match_window_days: 45 };
let n = 0;
const gl = (date, amt, memo, ref, extra = {}) => ({ id: `g${++n}`, je_id: extra.je_id || `je${n}`, reference: ref || `JE-${n}`, posting_date: date, amount_cents: amt, memo, description: memo, source_module: extra.source_module || 'ap', reverses_je_id: extra.reverses_je_id || null });
const bk = (imp, date, amt, desc, chk = null, type = null) => ({ id: `b${++n}`, bank_statement_import_id: imp, posting_date: date, amount_cents: amt, description: desc, check_number: chk, transaction_type: type });

// ---- GL: opening 140,000 at 7/31 (incl. a 25,000 split out 8/1) + August activity
const glLines = [
  gl('2026-07-31', 140000, 'Opening balance', 'JE-OPEN', { source_module: 'opening_entry' }),
  gl('2026-08-01', -25000, 'Split to other account', 'JE-SPLIT', { source_module: 'manual' }),
  gl('2026-08-05', -10000, 'AP payment check #1001', 'JE-A'),
  gl('2026-08-06', -5000, 'AP payment check #1002', 'JE-B'),           // same amount as 1003: must match by number
  gl('2026-08-07', -5000, 'AP payment check #1003', 'JE-C'),
  gl('2026-08-10', 8000, 'Payout ST-B', 'JE-D'),
  gl('2026-08-12', -42250, 'AP payment check #1004', 'JE-E'),           // clears for 42,210: variance
  gl('2026-08-20', -3000, 'AP payment check #1005', 'JE-V', { je_id: 'jeV' }),       // voided in the month
  gl('2026-08-22', 3000, 'Reversal of JE-V', 'JE-VR', { reverses_je_id: 'jeV' }),
  gl('2026-08-28', -7000, 'AP payment check #1006', 'JE-F'),            // outstanding at 8/31
];
const s8 = { id: 'imp8', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', beginning_balance_cents: 100000 };
const aug = [
  bk('imp8', '2026-08-03', 35000, 'Vantaca - Payout ST-A', null, 'ach_in'),       // opening DIT clears
  bk('imp8', '2026-08-08', -5000, 'Check 1003', '1003', 'check'),                 // clears 1003, not 1002
  bk('imp8', '2026-08-09', -10000, 'Check 1001', '1001', 'check'),
  bk('imp8', '2026-08-11', 8000, 'Vantaca - Payout ST-B', null, 'ach_in'),
  bk('imp8', '2026-08-15', -42210, 'Check 1004', '1004', 'check'),
  bk('imp8', '2026-08-18', -2003, 'AMAZON BUSINESS INTERNET 0430', null, 'ach_out'),
  bk('imp8', '2026-08-20', -20000, 'Check 27 - Welder', '27', 'check'),           // opening OC clears
  bk('imp8', '2026-08-26', -52500, 'RETURNED DEPOSIT ITEMS', null, 'nsf'),
  bk('imp8', '2026-08-26', -2000, 'CHARGEBACK FEE', null, 'fee'),
  bk('imp8', '2026-08-27', 5000, 'Vantaca - Payout ST-K', null, 'ach_in'),        // receipt not in the GL
];
s8.ending_balance_cents = s8.beginning_balance_cents + aug.reduce((t, x) => t + x.amount_cents, 0);
const pays = [
  { id: 'p1', property_id: 'prop1', vantaca_account_id: '105', transaction_date: '2026-08-24', amount_cents: -22500, description: 'Check #1004', address: '1 Main' },
  { id: 'p2', property_id: 'prop1', vantaca_account_id: '105', transaction_date: '2026-08-24', amount_cents: -30000, description: 'Check #1005', address: '1 Main' },
  { id: 'p3', property_id: 'prop2', vantaca_account_id: '106', transaction_date: '2026-08-24', amount_cents: -10000, description: 'eCheck', address: '2 Oak' },
];
const others = [{ account_label: 'Columbia 3170', posting_date: '2026-08-18', amount_cents: -2003, description: 'AMAZON MKTPL' }];
const base = { account, period_start: '2026-08-01', period_end: '2026-08-31', opening, statements: [s8], bankTxns: aug, glLines, otherBankTxns: others, homeownerPayments: pays, settings };

console.log('classification');
check('fee', classifyBankLine({ amount_cents: -2000, description: 'CHARGEBACK FEE' }) === 'bank_fee');
check('returned deposit', classifyBankLine({ amount_cents: -52500, description: 'RETURNED DEPOSIT ITEMS' }) === 'returned_payment');
check('payout receipt', classifyBankLine({ amount_cents: 5000, description: 'Vantaca - Payout ST-K' }) === 'unrecorded_receipt');
check('card purchase', classifyBankLine({ amount_cents: -1225, description: 'ATM DEBIT POS PURCHASE TERMINAL VBASE2 AMAZON MKTPL' }) === 'card_purchase');
check('transfer', classifyBankLine({ amount_cents: -15654, description: 'TRANSFER TO HOA BUS. ANALYSIS CK ACCOUNT' }) === 'transfer');
check('unknown stays unexplained', classifyBankLine({ amount_cents: -999, description: 'WIRE 8812' }) === 'unexplained');

console.log('August');
const r = reconcileAccountMonth(base);
const t = r.totals;
const cat = (c) => r.items.filter((i) => i.category === c);
check('opening position ties (no blocking exception)', !r.exceptions.some((e) => e.severity === 'blocking'), JSON.stringify(r.exceptions.filter((e) => e.severity === 'blocking')));
check('GL balance through 8/31', t.gl_ending_cents === 140000 - 25000 - 10000 - 5000 - 5000 + 8000 - 42250 - 3000 + 3000 - 7000, String(t.gl_ending_cents));
check('opening deposit in transit and check 27 cleared', r.cleared_since_prior.length === 2 && r.cleared_since_prior.every((c) => c.ref === 'opening 2026-07-31'));
const oc = cat('outstanding_check');
check('1002 and 1006 are outstanding, 1003 matched by number', oc.map((i) => i.gl_ref).sort().join(',') === 'JE-B,JE-F', oc.map((i) => i.gl_ref).join(','));
check('void pair is internal (not outstanding)', !r.items.some((i) => ['JE-V', 'JE-VR'].includes(i.gl_ref)) && t.internal_pairs === 1);
const adj = cat('manual_adjustment');
check('check 1004 variance carried as a +40 bank-side adjustment', adj.length === 1 && adj[0].amount_cents === 40 && r.exceptions.some((e) => e.code === 'check_amount_variance'));
const fee = r.proposals.find((p) => p.kind === 'journal_entry');
check('bank fee proposed Dr 5010 / Cr 1000 with evidence', fee && fee.amount_cents === 2000 && fee.lines[0].account_number === '5010' && fee.lines[1].account_number === '1000' && fee.evidence.bank_transaction_id && fee.source_reference.startsWith('bankrec:'));
const ret = r.proposals.find((p) => p.kind === 'returned_payment');
check('returned deposit matched to the one owner whose payments total 525.00', ret && ret.payments.map((p) => p.id).sort().join(',') === 'p1,p2' && ret.lines[0].account_number === '1300' && ret.lines[0].property_id === 'prop1');
check('unrecorded payout is an exception with no proposal', r.exceptions.some((e) => e.code === 'unrecorded_receipt') && !r.proposals.some((p) => p.amount_cents === 5000));
const amz = r.exceptions.find((e) => e.code === 'needs_receipt');
check('Amazon charge needs a receipt and is flagged as a possible duplicate', amz && amz.possible_duplicate === true && /Columbia 3170/.test(amz.text));
check('reconciles to $0.00', t.difference_cents === 0, `${t.adjusted_bank_cents} vs ${t.adjusted_book_cents}`);
check('not complete while exceptions are open', r.status === 'in_progress');
check('report has no em dashes', !/—/.test(reportText(r)));

console.log('posting the proposals, then re-running');
const afterGl = [...glLines, gl('2026-08-26', -2000, 'Bank charge', 'JE-FEE'), gl('2026-08-26', -52500, 'Returned deposit', 'JE-RET'), gl('2026-08-27', 5000, 'Unapplied receipt 105', 'JE-UNAP')];
const vant = aug.filter((x) => !/AMAZON/.test(x.description));
const s8b = { ...s8, ending_balance_cents: s8.beginning_balance_cents + vant.reduce((q, x) => q + x.amount_cents, 0) };
const glFixed = afterGl.map((l) => (l.reference === 'JE-E' ? { ...l, amount_cents: -42210 } : l));
const r2 = reconcileAccountMonth({ ...base, statements: [s8b], bankTxns: vant, glLines: glFixed });
check('every bank line now matches; no proposals left', r2.proposals.length === 0 && !r2.items.some((i) => i.category === 'bank_only'), JSON.stringify(r2.items.filter((i) => i.category === 'bank_only')));
check('only timing items remain, so it is reconciled', r2.status === 'reconciled' && r2.totals.difference_cents === 0, `${r2.status} ${JSON.stringify(r2.exceptions)}`);

console.log('September carry-forward');
const s9 = { id: 'imp9', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', beginning_balance_cents: s8b.ending_balance_cents };
const sep = [bk('imp9', '2026-09-03', -7000, 'Check 1006', '1006', 'check')];
s9.ending_balance_cents = s9.beginning_balance_cents - 7000;
const r3 = reconcileAccountMonth({ ...base, period_start: '2026-09-01', period_end: '2026-09-30', statements: [s8b, s9], bankTxns: [...vant, ...sep], glLines: glFixed });
check('1006 cleared since the prior month-end', r3.cleared_since_prior.some((c) => c.ref === 'JE-F'));
check('1002 still outstanding', r3.items.some((i) => i.category === 'outstanding_check' && i.gl_ref === 'JE-B'));

console.log('confirmed bank error (check image shows the GL amount)');
const glBooks = afterGl;   // check 1004 stays 42,250 in the GL: the books are right, the bank paid 42,210
const c1004 = vant.find((x) => x.check_number === '1004');
const runBE = (codings, extra = {}) => reconcileAccountMonth({ ...base, statements: [s8b], bankTxns: vant, glLines: glBooks, codings, ...extra });
const be0 = runBE([]);
check('without evidence the variance is an open, unresolved difference', be0.status === 'in_progress' && be0.exceptions.some((e) => e.code === 'check_amount_variance' && e.severity === 'open'));
const beCoding = { bank_transaction_id: c1004.id, bank_error: true, expected_cents: 42250, basis: 'Check image p.5: courtesy and legal amounts 422.50' };
const be1 = runBE([beCoding]);
const beItem = be1.items.find((i) => i.match_method === 'confirmed_bank_error');
check('a confirmed bank error is reported as info, not as an open difference', be1.exceptions.some((e) => e.code === 'confirmed_bank_error' && e.severity === 'info') && !be1.exceptions.some((e) => e.code === 'check_amount_variance'));
check('it stays a +40 bank-side reconciling item and nothing is proposed for it', beItem && beItem.amount_cents === 40 && be1.proposals.length === 0 && be1.totals.manual_adjustments_cents === 40);
check('the month balances and can reconcile with the documented bank error', be1.totals.difference_cents === 0 && be1.status === 'reconciled', `${be1.status} ${JSON.stringify(be1.exceptions)}`);
check('the report names it as a bank error for the bank to correct', /Confirmed bank errors \(the books are right; the bank is to correct\): Check 1004/.test(reportText(be1)));
const beWrong = runBE([{ ...beCoding, expected_cents: 42210 }]);
check('an expected amount that is not the GL amount is refused and stays open', beWrong.status === 'in_progress' && beWrong.exceptions.some((e) => e.code === 'check_amount_variance' && /not accepted: the expected amount/.test(e.text)));
const beNoBasis = runBE([{ ...beCoding, basis: ' ' }]);
check('a bank-error coding with no evidence is refused and stays open', beNoBasis.exceptions.some((e) => e.code === 'check_amount_variance' && /no evidence/.test(e.text)));
const s9e = { id: 'imp9e', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', beginning_balance_cents: s8b.ending_balance_cents };
const fix = bk('imp9e', '2026-09-12', -40, 'ENCODING CORRECTION CHECK 1004', null, 'adjustment');
s9e.ending_balance_cents = s9e.beginning_balance_cents - 40;
const be2 = reconcileAccountMonth({ ...base, period_start: '2026-09-01', period_end: '2026-09-30', statements: [s8b, s9e], bankTxns: [...vant, fix], glLines: glBooks,
  codings: [beCoding, { bank_transaction_id: fix.id, bank_error_correction_of: c1004.id, basis: 'NewFirst correction 9/12' }] });
check('the bank correction offsets the error: no bank-only line, adjustments net to zero', !be2.items.some((i) => i.category === 'bank_only') && be2.totals.manual_adjustments_cents === 0 && be2.totals.difference_cents === 0 && be2.status === 'reconciled', `${be2.status} ${JSON.stringify(be2.totals)}`);
check('the error is shown as corrected', be2.exceptions.some((e) => e.code === 'confirmed_bank_error' && /corrected 2026-09-12/.test(e.text)));
const be3 = reconcileAccountMonth({ ...base, period_start: '2026-09-01', period_end: '2026-09-30', statements: [s8b, s9e], bankTxns: [...vant, fix], glLines: glBooks,
  codings: [beCoding, { bank_transaction_id: fix.id, bank_error_correction_of: c1004.id, basis: '' }] });
check('a correction with no evidence is not accepted', be3.exceptions.some((e) => e.code === 'bank_error_correction_unmatched'));

console.log('stale items');
const r4 = reconcileAccountMonth({ ...base, period_start: '2026-11-01', period_end: '2026-11-30', statements: [s8b, s9, { id: 'imp10', statement_period_start: '2026-10-01', statement_period_end: '2026-10-31', beginning_balance_cents: s9.ending_balance_cents, ending_balance_cents: s9.ending_balance_cents }, { id: 'imp11', statement_period_start: '2026-11-01', statement_period_end: '2026-11-30', beginning_balance_cents: s9.ending_balance_cents, ending_balance_cents: s9.ending_balance_cents }], bankTxns: [...vant, ...sep], glLines: glFixed });
check('check outstanding over 90 days is a stale-check exception', r4.exceptions.some((e) => e.code === 'stale_check' && e.gl_ref === 'JE-B') && r4.status === 'in_progress');

console.log('controls');
const m = reconcileAccountMonth({ ...base, period_start: '2026-10-01', period_end: '2026-10-31', statements: [s8b, s9], bankTxns: [...vant, ...sep], glLines: glFixed });
check('missing statement blocks', m.status === 'blocked' && m.exceptions[0].code === 'statement_missing');
const gap = reconcileAccountMonth({ ...base, statements: [{ ...s8, beginning_balance_cents: 99000 }] });
check('statement that does not chain from the prior balance blocks', gap.status === 'blocked' && gap.exceptions.some((e) => e.code === 'statement_gap'));
const inc = reconcileAccountMonth({ ...base, bankTxns: aug.slice(1) });
check('statement whose transactions do not tie blocks (incomplete feed)', inc.status === 'blocked' && inc.exceptions.some((e) => e.code === 'statement_incomplete'));
const tie = reconcileAccountMonth({ ...base, opening: { ...opening, deposits_in_transit: [] } });
check('opening position that does not tie to the book blocks', tie.status === 'blocked' && tie.exceptions.some((e) => e.code === 'opening_does_not_tie'));
const none = reconcileAccountMonth({ ...base, opening: null });
check('no opening position blocks', none.status === 'blocked' && none.exceptions[0].code === 'opening_position_missing');
const amb = reconcileAccountMonth({ ...base, homeownerPayments: [...pays, { id: 'p9', property_id: 'prop9', vantaca_account_id: '109', transaction_date: '2026-08-25', amount_cents: -52500, description: 'Check', address: '9 Elm' }] });
check('two owners with matching payments: no proposal, exception asks for the return notice', !amb.proposals.some((p) => p.kind === 'returned_payment') && amb.exceptions.some((e) => e.code === 'returned_payment_unidentified'));
const nofee = reconcileAccountMonth({ ...base, settings: { ...settings, bank_fee_account: null } });
check('no fee account configured: fee is an exception, nothing invented', !nofee.proposals.some((p) => p.id.startsWith('fee:')) && nofee.exceptions.some((e) => e.code === 'uncoded_bank_fee'));
const off = reconcileAccountMonth({ ...base, glLines: [...glLines, gl('2026-08-30', 100, 'stray', 'JE-X')] });
check('a book-only stray is outstanding, never forced to balance', off.items.some((i) => i.gl_ref === 'JE-X' && i.category === 'deposit_in_transit'));

console.log('fund split on the cash account');
{
  // JE-2026-00429 shape: two lines on the same cash account in different funds, netting to 0.
  const split = [gl('2026-08-01', -697130, 'Reimbursement (AAS fund)', 'JE-FS', { je_id: 'jeFS', source_module: 'manual' }), gl('2026-08-01', 697130, 'Clear Operating-fund share', 'JE-FS', { je_id: 'jeFS', source_module: 'manual' })];
  const rs = reconcileAccountMonth({ ...base, glLines: [...glLines, ...split] });
  check('a same-entry fund split netting to zero is not an outstanding item or exception', !rs.items.some((i) => i.gl_ref === 'JE-FS') && !rs.exceptions.some((e) => e.gl_ref === 'JE-FS'), JSON.stringify(rs.items.filter((i) => i.gl_ref === 'JE-FS')));
  check('...and does not change the difference or the void-pair count', rs.totals.difference_cents === t.difference_cents && rs.totals.internal_pairs === t.internal_pairs);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
