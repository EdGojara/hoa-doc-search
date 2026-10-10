// tests/test_board_budget_funds.js  (Ed 2026-10-10)
// Board portal budget tile + Ask Amanda budget context, by fund, with the same fund
// definitions as the financial statements and the working forecast. Scar: the tile
// folded Adopt-a-School income into Operating (Canyon Gate operating net $145,668
// instead of $140,718) and treated any Reserve revenue as the reserve contribution.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const BFS = require('../lib/accounting/budget_fund_summary');
const WF = require('../lib/forecast/working_forecast');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const money = (c) => `${c < 0 ? '(' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}${c < 0 ? ')' : ''}`;

// Canyon Gate FY2026 approved budget, by fund (production figures, 2026-10-10).
const FUNDS = [{ id: 'opr', fund_code: 'OPR', fund_name: 'Operating Fund', fund_type: 'operating' }, { id: 'res', fund_code: 'RES', fund_name: 'Reserve Fund', fund_type: 'reserve' }, { id: 'ado', fund_code: 'ADO', fund_name: 'Adopt a School', fund_type: 'other' }];
const acct = (id, n, name, type, fund, extra = {}) => ({ id, account_number: n, account_name: name, account_type: type, account_subtype: type === 'revenue' ? 'operating_revenue' : 'operating_expense', fund_id: fund, interfund_from_fund_id: null, interfund_to_fund_id: null, ...extra });
const XFER = { account_subtype: 'interfund_transfer', interfund_from_fund_id: 'opr', interfund_to_fund_id: 'res' };
const ACCTS = (cfg = XFER) => [acct('a4000', '4000', 'Current Year Assessment Income', 'revenue', 'opr'), acct('a4210', '4210', 'Miscellaneous Income', 'revenue', 'opr'),
  acct('a5000', '5000', 'Operating expenses', 'expense', 'opr'), acct('a4010', '4010', 'Reserve Contribution', 'revenue', 'res', cfg), acct('a4050', '4050', 'Adopt a School Income', 'revenue', 'ado')];
const LINES = [{ account_id: 'a4000', fund_id: 'opr', annual_amount_cents: 102742500 }, { account_id: 'a4210', fund_id: 'opr', annual_amount_cents: 7837100 },
  { account_id: 'a5000', fund_id: 'opr', annual_amount_cents: 96507800 }, { account_id: 'a4010', fund_id: 'res', annual_amount_cents: -16400000 }, { account_id: 'a4050', fund_id: 'ado', annual_amount_cents: 495000 }];
const B = { fiscal_year: 2026, status: 'approved' };

console.log('Canyon Gate: three funds, 4010 configured Operating -> Reserve');
const sum = BFS.summarizeBudgetByFund({ lines: LINES, accounts: ACCTS(), funds: FUNDS });
const h = BFS.budgetHeadline(B, sum);
check('Operating revenue excludes Adopt-a-School ($1,105,796, not $1,110,746)', h.operating_revenue_cents === 110579600);
check('Operating net before reserve funding is $140,718 (not $145,668), labelled before reserve funding', h.operating_net_cents === 14071800 && h.operating_net_basis === 'before_reserve_funding');
check('planned reserve funding $164,000 comes from the configured transfer', h.reserve_contribution_cents === 16400000 && sum.transfers.length === 1 && sum.transfers[0].from_fund_code === 'OPR' && sum.transfers[0].to_fund_code === 'RES');
check('Operating after reserve funding is ($23,282)', h.operating_net_after_reserve_funding_cents === -2328200);
const fund = (c) => h.funds.find((f) => f.fund_code === c);
check('Reserve shows the $164,000 transfer IN and no revenue (the transfer is not revenue, not double-counted)', fund('RES').transfers_in_cents === 16400000 && fund('RES').revenue_cents === 0 && fund('OPR').transfers_out_cents === 16400000 && fund('OPR').revenue_cents === 110579600);
check('Adopt-a-School is reported on its own ($4,950)', fund('ADO').revenue_cents === 495000 && fund('ADO').net_after_transfers_cents === 495000 && h.funds.length === 3);
check('the tile fields it already reads keep their names (operating_expense_cents, reserve_contribution_cents)', h.operating_expense_cents === 96507800 && 'reserve_contribution_cents' in h && h.fiscal_year === 2026);
check('no warnings for a correctly configured community', h.warnings.length === 0);
const txt = BFS.budgetContextText(B, sum, money);
check('Ask Amanda: Operating before / planned reserve funding / after, and each fund separately', /before reserve funding: \$140,718\.00/.test(txt) && /Planned reserve funding \(transfer to Reserve\): \$164,000\.00/.test(txt) && /after reserve funding: \(\$23,282\.00\)/.test(txt)
  && /RESERVE FUND \(RES, reserve\)/.test(txt) && /Transfers in: \$164,000\.00/.test(txt) && /ADOPT A SCHOOL \(ADO, other\)/.test(txt) && /never add them together/.test(txt));

console.log('same fund definitions as the working forecast');
const L = (o) => ({ account_id: o.id, account_number: o.n, account_name: o.name, account_type: o.type, fund_id: o.fund, fund_code: o.code, fund_type: o.ftype, budget_months: (() => { const m = Array(12).fill(Math.trunc(o.annual / 12)); m[0] += o.annual - m.reduce((a, b) => a + b, 0); return m; })(), ytd_actual: 0, month_actuals: { 8: 0, 9: 0 }, ...(o.transfer ? { transfer: o.transfer } : {}) });
const wf = WF.buildWorkingForecast({ community: { id: 'c', name: 'CG' }, base_year: 2026, target_year: 2027, as_of: '2026-09-30', as_of_month: 9, post_cutover_months: [8, 9], policy: {}, facts: {}, lines: [
  L({ id: 'a4000', n: '4000', name: 'Assessments', type: 'revenue', fund: 'opr', code: 'OPR', ftype: 'operating', annual: 102742500 }), L({ id: 'a4210', n: '4210', name: 'Misc', type: 'revenue', fund: 'opr', code: 'OPR', ftype: 'operating', annual: 7837100 }),
  L({ id: 'a5000', n: '5000', name: 'Opex', type: 'expense', fund: 'opr', code: 'OPR', ftype: 'operating', annual: 96507800 }),
  L({ id: 'a4010', n: '4010', name: 'Reserve Contribution', type: 'revenue', fund: 'res', code: 'RES', ftype: 'reserve', annual: -16400000, transfer: { from_fund_id: 'opr', from_fund_code: 'OPR', from_fund_type: 'operating', to_fund_id: 'res', to_fund_code: 'RES', to_fund_type: 'reserve' } }),
  L({ id: 'a4050', n: '4050', name: 'Adopt a School', type: 'revenue', fund: 'ado', code: 'ADO', ftype: 'other', annual: 495000 })] });
const same = ['OPR', 'RES', 'ADO'].every((c) => { const w = wf.summary.funds.find((f) => f.fund_code === c).approved_base_year, t = fund(c);
  return w.revenue === t.revenue_cents && w.expense === t.expense_cents && w.transfers_in === t.transfers_in_cents && w.transfers_out === t.transfers_out_cents && w.net_after_transfers === t.net_after_transfers_cents; });
check('every fund matches the working forecast\'s 2026 approved figures exactly', same);

console.log('controls');
const unc = BFS.summarizeBudgetByFund({ lines: LINES, accounts: ACCTS({}), funds: FUNDS });
check('Waterview pattern (4010 in Reserve, NOT configured): not treated as a transfer; reported in its fund with a warning', unc.reserve_funding_cents === 0 && unc.funds.find((f) => f.fund_code === 'RES').revenue_cents === -16400000 && unc.warnings.some((w) => w.code === 'negative_revenue_budget') && unc.operating_net_basis === 'before_reserve_funding');
const lopfAccts = ACCTS({}).map((a) => (a.id === 'a4010' ? { ...a, fund_id: 'opr' } : a));
const lopf = BFS.summarizeBudgetByFund({ lines: LINES.map((l) => (l.account_id === 'a4010' ? { ...l, fund_id: 'opr' } : l)), accounts: lopfAccts, funds: FUNDS });
check('LOPF pattern (4010 in Operating, NOT configured): the operating net is labelled "as budgeted", never "before reserve funding"', lopf.operating_net_basis === 'as_budgeted_includes_unconfigured_transfer' && /as budgeted: \(?\$/.test(BFS.budgetContextText(B, lopf, money)) && !/before reserve funding/.test(BFS.budgetContextText(B, lopf, money)));
const bad = BFS.summarizeBudgetByFund({ lines: LINES, accounts: ACCTS({ account_subtype: 'interfund_transfer', interfund_from_fund_id: 'opr', interfund_to_fund_id: null }), funds: FUNDS });
check('an incomplete transfer configuration is reported, not guessed', bad.reserve_funding_cents === 0 && bad.warnings.some((w) => w.code === 'transfer_config_invalid'));
const byName = BFS.summarizeBudgetByFund({ lines: LINES, accounts: ACCTS({ account_name: 'Transfer to Reserves' }), funds: FUNDS });
check('the account name alone never makes a transfer', byName.transfers.length === 0);
const nofund = BFS.summarizeBudgetByFund({ lines: [...LINES, { account_id: 'a9999', fund_id: null, annual_amount_cents: 100000 }], accounts: [...ACCTS(), acct('a9999', '9999', 'Orphan', 'revenue', null)], funds: FUNDS });
check('a line with no fund stays in its own group, never in Operating', nofund.operating.revenue_cents === 110579600 && nofund.funds.some((f) => f.fund_type === 'unassigned' && f.revenue_cents === 100000));
const twoOp = BFS.summarizeBudgetByFund({ lines: LINES, accounts: ACCTS(), funds: [...FUNDS.slice(0, 2), { ...FUNDS[2], fund_type: 'operating' }] });
check('two operating funds: no combined Operating figure is invented', twoOp.operating === null && BFS.budgetHeadline(B, twoOp).operating_net_cents === null && twoOp.warnings.some((w) => w.code === 'no_operating_fund'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
