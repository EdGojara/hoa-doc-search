// tests/test_board_reporting.js  (Ed 2026-10-10)
// Board portal financial presentation: the reporting period (last completed month, never a
// partial current month), provisional vs closed, the month-end close's completeness findings,
// annual vs year-to-date bases, and interfund transfer status from the books (offsetting 4010
// entries are a transfer; an unreconcilable period shows no amount, never an unsupported $0).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const BR = require('../lib/portal/board_reporting');
const TA = require('../lib/accounting/transfer_activity');
const BFS = require('../lib/accounting/budget_fund_summary');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };

// Minimal fake client: journal_entries month counts, accounting_periods, period_closes, close_closed_through.
const fake = ({ counts = {}, period = null, closeRec = null, closedThrough = null } = {}) => ({
  from: (t) => { const f = {}; const q = { select: () => q, eq: (k, v) => { f[k] = v; return q; }, in: () => q, gte: (k, v) => { f.gte = v; return q; }, lte: (k, v) => { f.lte = v; return q; },
    maybeSingle: async () => ({ data: t === 'accounting_periods' ? period : t === 'period_closes' ? closeRec : null, error: null }),
    then: (res) => res({ count: t === 'journal_entries' ? (counts[String(f.lte).slice(0, 7)] || 0) : 0, error: null }) }; return q; },
  rpc: async () => ({ data: closedThrough, error: null }),
});

(async () => {
  console.log('reporting period: the last completed month, never a partial current month');
  check('mid-month (October 10) reports through September 30', BR.lastCompletedMonthEnd('2026-10-10') === '2026-09-30');
  check('on the last day of a month, the month in progress is still not used (September 30 -> August 31)', BR.lastCompletedMonthEnd('2026-09-30') === '2026-08-31');
  check('in January, the last completed month is December of the prior year', BR.lastCompletedMonthEnd('2027-01-05') === '2026-12-31');
  check('leap-year February month end', BR.monthEndBack('2028-03-31', 1) === '2028-02-29');
  const p1 = await BR.chooseReportingPeriod(fake({ counts: { '2026-09': 12 } }), 'c', { today: '2026-10-10' });
  check('default = last completed month with posted activity (September)', p1.period_end === '2026-09-30' && p1.basis === 'last_completed_month' && !p1.stepped_back_from);
  const p2 = await BR.chooseReportingPeriod(fake({ counts: { '2026-08': 5 } }), 'c', { today: '2026-10-10' });
  check('no activity posted yet for September: steps back to August and says so', p2.period_end === '2026-08-31' && p2.stepped_back_from === '2026-09-30');
  const p3 = await BR.chooseReportingPeriod(fake({}), 'c', { today: '2026-10-10', requested: '2026-10-10' });
  check('an explicitly requested date is honored', p3.period_end === '2026-10-10' && p3.basis === 'requested');

  console.log('provisional vs closed: a month is not closed because it ended');
  const s1 = await BR.periodStatus(fake({ period: { id: 'p9', period_end: '2026-09-30', status: 'open' } }), 'c', '2026-09-30');
  check('an open period is provisional ("has not been closed")', s1.status === 'provisional' && /not been closed/.test(s1.status_label) && s1.period_id === 'p9');
  const s2 = await BR.periodStatus(fake({ period: { id: 'p9', period_end: '2026-09-30', status: 'closed' }, closeRec: { status: 'closed', close_label: 'closed' } }), 'c', '2026-09-30');
  check('a period closed by the month-end close is "Closed"', s2.status === 'closed' && /^Closed/.test(s2.status_label));
  const s3 = await BR.periodStatus(fake({ period: { id: 'p8', period_end: '2026-08-31', status: 'open' }, closedThrough: '2026-09-30' }), 'c', '2026-08-31');
  check('a month locked by a later close counts as closed', s3.status === 'closed');
  const s4 = await BR.periodStatus(fake({ period: { id: 'p10', period_end: '2026-10-31', status: 'closed' }, closedThrough: '2026-10-31' }), 'c', '2026-10-10');
  check('a requested mid-month date is a provisional partial month even in a closed month', s4.status === 'provisional' && /partial/.test(s4.status_label) && s4.month_end === '2026-10-31');

  console.log('incomplete data: the month-end close\'s own findings, not invented here');
  const closeResults = [
    { code: 'GL-01', group: 'General ledger', label: 'Trial balance balances', status: 'PASS', explanation: 'ok' },
    { code: 'DATA-01', group: 'Data completeness', label: 'Homeowner billing and receipt feed complete', status: 'BLOCK', explanation: 'No homeowner billing/receipt feed covers September 2026.', action: 'Load the homeowner billing...' },
    { code: 'DATA-03', group: 'Data completeness', label: 'Deferred and prepaid balances have schedules', status: 'BLOCK', explanation: '5 balances have no schedule.' },
    { code: 'REC-01', group: 'Recognition', label: 'Every recognition due through period end is posted', status: 'PASS', explanation: 'ok' },
    { code: 'DATA-05', group: 'Data completeness', label: 'Recurring vendors billed this month', status: 'WARNING', explanation: 'Splash Pools not billed.' },
    { code: 'AP-02', group: 'Bills', label: 'Held bills', status: 'WARNING', explanation: 'x' },
  ];
  const input = { period: { period_start: '2026-09-01', period_end: '2026-09-30' }, bank: {
    accounts: [{ id: 'b1', account_nickname: 'Operating Checking', account_last4: '5313', gl_account_number: '1000' }, { id: 'b2', account_nickname: 'Old Savings', account_last4: '0000', gl_account_number: '1090' }],
    gl_balances: { 1000: 12345600, 1090: 0 }, statements: [], recs: [] } };
  const cashResults = [...closeResults,
    { code: 'DATA-02', group: 'Data completeness', label: 'Bank and investment statements received', status: 'BLOCK', explanation: '2 of 2 accounts have no statement.' },
    { code: 'CASH-01', group: 'Cash', label: 'Every bank and investment account reconciled to $0.00', status: 'BLOCK', explanation: '2 of 2 accounts not reconciled.' }];
  const cf = BR.classifyFindings(cashResults, input);
  const mcodes = cf.material.map((x) => x.code), pcodes = cf.procedures.map((x) => x.code);
  check('Canyon Gate: incomplete homeowner billing (assessment revenue) is a MATERIAL exception', mcodes.includes('DATA-01') && /Assessment billing/.test(cf.material.find((x) => x.code === 'DATA-01').title));
  check('unscheduled prepaid / deferred balances are material', mcodes.includes('DATA-03'));
  check('missing bank statement on an account carrying cash is MATERIAL (cash unverified), with the balance shown', mcodes.includes('CASH') && /\$123,456\.00/.test(cf.material.find((x) => x.code === 'CASH').explanation) && /Operating Checking/.test(cf.material.find((x) => x.code === 'CASH').explanation));
  check('the same gap on a zero-balance account is a routine close procedure, not dismissed', pcodes.includes('CASH-ZERO') && /Old Savings/.test(cf.procedures.find((x) => x.code === 'CASH-ZERO').explanation) && !/Old Savings/.test(cf.material.find((x) => x.code === 'CASH').explanation));
  check('warning-level housekeeping (held bills, recurring bills to confirm) is listed as an outstanding procedure', pcodes.includes('AP-02') && pcodes.includes('DATA-05'));
  const nonPass = cashResults.filter((r) => r.status !== 'PASS').map((r) => r.code);
  const covered = new Set([...cf.material.flatMap((x) => x.codes || [x.code]), ...cf.procedures.flatMap((x) => x.codes || [x.code])]);
  check('nothing is dropped: every non-passing finding is in one of the two lists', nonPass.every((c) => covered.has(c)));
  const unknownBal = BR.classifyFindings([{ code: 'DATA-02', group: 'Data completeness', label: 'x', status: 'BLOCK', explanation: 'x' }], { ...input, bank: { ...input.bank, gl_balances: {} } });
  check('an account whose balance is unknown is treated as carrying cash (material), never assumed empty', unknownBal.material.some((x) => x.code === 'CASH'));
  const okBank = BR.classifyFindings([{ code: 'DATA-01', group: 'Data completeness', label: 'x', status: 'BLOCK', explanation: 'x' }], { ...input, bank: { ...input.bank, statements: [{ bank_account_id: 'b1', status: 'completed', statement_period_end: '2026-09-30' }, { bank_account_id: 'b2', status: 'completed', statement_period_end: '2026-09-30' }],
    recs: [{ bank_account_id: 'b1', status: 'reconciled', difference_cents: 0, period_end: '2026-09-30' }, { bank_account_id: 'b2', status: 'reconciled', difference_cents: 0, period_end: '2026-09-30' }] } });
  check('with statements and $0.00 reconciliations, no cash item appears', !okBank.material.some((x) => x.code === 'CASH') && !okBank.procedures.some((x) => x.code === 'CASH-ZERO'));

  console.log('interfund transfers: what the books show, never the budget line');
  const C = { account_type: 'revenue', recorded_leg: 'outgoing', from: '2026-01-01', to: '2026-09-30' };
  const off = TA.classifyTransferActivity({ ...C, lines: [{ debit_cents: 20000000, credit_cents: 0 }, { debit_cents: 0, credit_cents: 20000000 }] });
  check('Vantaca offsetting entries (Dr and Cr on 4010, net zero) are a recorded transfer of the gross amount, not $0', off.status === 'offsetting' && off.amount_cents === 20000000 && /nets to zero/.test(off.note));
  const none = TA.classifyTransferActivity({ ...C, lines: [] });
  check('full-year detail and no entry: "No transfer found" ($0 is supported)', none.status === 'not_found' && none.amount_cents === 0);
  const gap = TA.classifyTransferActivity({ ...C, lines: [], detail_from: '2026-08-01' });
  check('part of the year carried from the prior system: needs reconciliation, NO amount (never an unsupported $0)', gap.status === 'requires_reconciliation' && gap.amount_cents === null && /prior accounting system/.test(gap.note) && /August 1, 2026/.test(gap.note));
  const gapSeen = TA.classifyTransferActivity({ ...C, lines: [{ debit_cents: 1366700, credit_cents: 0 }], detail_from: '2026-08-01' });
  check('entries after the cutover but a pre-cutover gap: still needs reconciliation (the visible part is reported in the note)', gapSeen.status === 'requires_reconciliation' && gapSeen.amount_cents === null && /\$13,667\.00 recorded/.test(gapSeen.note));
  const conf = TA.classifyTransferActivity({ ...C, lines: [{ debit_cents: 4100000, credit_cents: 0 }] });
  check('a posted transfer in the configured direction is "Recorded" with its amount', conf.status === 'confirmed' && conf.amount_cents === 4100000);
  const rev = TA.classifyTransferActivity({ ...C, lines: [{ debit_cents: 0, credit_cents: 500000 }] });
  check('entries against the configured direction need reconciliation (no amount)', rev.status === 'requires_reconciliation' && rev.amount_cents === null);
  const inc = TA.classifyTransferActivity({ account_type: 'revenue', recorded_leg: 'incoming', from: '2026-01-01', to: '2026-09-30', lines: [{ debit_cents: 0, credit_cents: 700000 }] });
  check('incoming-side transfer account: a credit is the transfer', inc.status === 'confirmed' && inc.amount_cents === 700000);

  console.log('transfer actuals flow into the fund results; annual budgets are unaffected');
  const FUNDS = [{ id: 'opr', fund_code: 'OPR', fund_type: 'operating' }, { id: 'res', fund_code: 'RES', fund_type: 'reserve' }];
  const ACCTS = [{ id: 'a4000', account_number: '4000', account_name: 'Assessments', account_type: 'revenue', fund_id: 'opr' }, { id: 'a5000', account_number: '5000', account_name: 'Opex', account_type: 'expense', fund_id: 'opr' },
    { id: 'a4010', account_number: '4010', account_name: 'Reserve Contribution', account_type: 'revenue', fund_id: 'res', account_subtype: 'interfund_transfer', interfund_from_fund_id: 'opr', interfund_to_fund_id: 'res' }];
  const ROWS = [{ account_id: 'a4000', fund_id: 'opr', annual_budget_cents: 110579600, ytd_budget_cents: 82934700, ytd_actual_cents: 80000000 },
    { account_id: 'a5000', fund_id: 'opr', annual_budget_cents: 96507800, ytd_budget_cents: 72380850, ytd_actual_cents: 75000000 },
    { account_id: 'a4010', fund_id: 'res', annual_budget_cents: -16400000, ytd_budget_cents: -12300000, ytd_actual_cents: 0 }];
  const M = ['annual_budget_cents', 'ytd_budget_cents', 'ytd_actual_cents'];
  const rec = BFS.classifyByFund({ rows: ROWS, accounts: ACCTS, funds: FUNDS, measures: M, transferActuals: { a4010: { ...gap, status_label: 'Needs reconciliation' } } });
  const op = rec.funds.find((f) => f.fund_code === 'OPR');
  check('needs reconciliation: Actual YTD after reserve funding is unavailable (null), never "before minus $0"', op.totals.ytd_actual_cents.net_after_transfers === null && op.totals.ytd_actual_cents.net_before_transfers === 5000000 && op.transfers[0].actual_status === 'requires_reconciliation');
  check('annual and budget-to-date figures are unaffected by the actual transfer status', op.totals.annual_budget_cents.net_after_transfers === -2328200 && op.totals.ytd_budget_cents.transfers_out === 12300000 && op.totals.ytd_budget_cents.net_after_transfers === 82934700 - 72380850 - 12300000);
  const offF = BFS.classifyByFund({ rows: ROWS, accounts: ACCTS, funds: FUNDS, measures: M, transferActuals: { a4010: { ...off, status_label: 'Recorded through offsetting entries' } } });
  check('offsetting entries: the gross amount is the actual transfer in both funds (not netted to $0, not counted twice)', offF.funds.find((f) => f.fund_code === 'OPR').totals.ytd_actual_cents.transfers_out === 20000000 && offF.funds.find((f) => f.fund_code === 'RES').totals.ytd_actual_cents.transfers_in === 20000000);

  console.log('all six communities: approved FY2026 operating results are unchanged by this PR');
  const SIX = [['Canyon Gate', 110579600, 96507800, 16400000, 14071800, -2328200], ['Waterview', 121096500, 119688000, 9300000, 1408500, -7891500], ['Lakes of Pine Forest', 38969800, 38682800, 4270000, 287000, -3983000],
    ['Quail Ridge', 2626000, 3101500, 0, -475500, -475500], ['Still Creek Ranch', 24502500, 24394200, 0, 108300, 108300], ['Eaglewood', 38458000, 38575117, 0, -117117, -117117]];
  for (const [n, revC, expC, fund, before, after] of SIX) {
    const accts = [{ id: 'r', account_number: '4000', account_name: 'Income', account_type: 'revenue', fund_id: 'opr' }, { id: 'e', account_number: '5000', account_name: 'Expense', account_type: 'expense', fund_id: 'opr' },
      ...(fund ? [{ id: 't', account_number: '4010', account_name: 'Reserve Contribution', account_type: 'revenue', fund_id: 'res', account_subtype: 'interfund_transfer', interfund_from_fund_id: 'opr', interfund_to_fund_id: 'res' }] : [])];
    const lines = [{ account_id: 'r', fund_id: 'opr', annual_amount_cents: revC }, { account_id: 'e', fund_id: 'opr', annual_amount_cents: expC }, ...(fund ? [{ account_id: 't', fund_id: 'res', annual_amount_cents: -fund }] : [])];
    const h = BFS.budgetHeadline({ fiscal_year: 2026, status: 'approved' }, BFS.summarizeBudgetByFund({ lines, accounts: accts, funds: FUNDS }));
    check(`${n}: before ${before / 100}, reserve funding ${fund / 100}, after ${after / 100}`, h.operating_net_cents === before && h.reserve_contribution_cents === fund && h.operating_net_after_reserve_funding_cents === after);
  }

  console.log('page labels');
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'board-portal.html'), 'utf8');
  check('explicit column labels; "Spent YTD" and "vs. plan" headings are gone', /Annual Budget<\/th>/.test(html) && /Actual YTD<\/th>/.test(html) && /Variance vs\. Budget to Date<\/th>/.test(html) && !/>Spent YTD</.test(html) && !/>vs\. plan</.test(html));
  check('the reporting period, status, budget-to-date basis and the bar basis are stated on the page', /Reporting period: January 1 through/.test(html) && /Bars show Actual YTD as a share of the <b>annual<\/b> budget/.test(html) && /budget for January through/.test(html));
  check('material exceptions prominent, close procedures in a concise labelled section, Provisional explained in plain language, full detail for staff only', /Items that affect these financial statements/.test(html) && /Month-end close procedures still outstanding/.test(html) && /<b>Provisional<\/b> means Bedrock's accounting team has not yet formally closed/.test(html) && /Staff only: all close findings in full/.test(html));
  check('transfer rows show their status ("Needs reconciliation", "Offsetting entries", "None recorded", "Recorded")', ['Needs reconciliation', 'Offsetting entries', 'None recorded', "chip('Recorded'"].every((t) => html.includes(t)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
