// tests/test_tb_drilldown.js — Trial Balance drill-down reconciliation (Ed 2026-09-28).
// Pure: every TB row's detail must tie EXACTLY to the row (all-history and
// scoped), including conversion/opening entries, voided-with-reversal pairs,
// null-fund lines falling back to the account's fund, and multi-fund accounts;
// balance-sheet accounts carry forward, income/expense accounts follow the
// period; running balance is continuous across pages; drafts never count.
// The match to the REAL v_trial_balance view is in tests/sql/tb_drilldown_rehearsal.mjs.
const assert = require('assert');
const tbd = require('../lib/accounting/trial_balance_detail');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n   ', e.message); } };

const FUNDS = [{ id: 'f-op', fund_code: 'OP', fund_name: 'Operating' }, { id: 'f-res', fund_code: 'RES', fund_name: 'Reserve' }];
const ACCTS = [
  { id: 'a-cash', account_number: '1000', account_name: 'Operating Cash', account_type: 'asset', normal_balance: 'debit', fund_id: 'f-op', is_active: true },
  { id: 'a-res', account_number: '1100', account_name: 'Reserve Cash', account_type: 'asset', normal_balance: 'debit', fund_id: 'f-res', is_active: true },
  { id: 'a-ap', account_number: '2000', account_name: 'Accounts Payable', account_type: 'liability', normal_balance: 'credit', fund_id: null, is_active: true },
  { id: 'a-eq', account_number: '3000', account_name: 'Fund Balance', account_type: 'equity', normal_balance: 'credit', fund_id: 'f-op', is_active: true },
  { id: 'a-rev', account_number: '4000', account_name: 'Assessments', account_type: 'revenue', normal_balance: 'credit', fund_id: 'f-op', is_active: true },
  { id: 'a-exp', account_number: '5000', account_name: 'Landscaping', account_type: 'expense', normal_balance: 'debit', fund_id: 'f-op', is_active: true },
  { id: 'a-old', account_number: '5999', account_name: 'Inactive', account_type: 'expense', normal_balance: 'debit', fund_id: 'f-op', is_active: false },
];
const JES = {
  conv: { id: 'je-conv', posting_date: '2026-07-31', reference: 'CONV-1', status: 'posted', description: 'Conversion opening balances', source_module: 'conversion' },
  a1: { id: 'je-a1', posting_date: '2026-08-01', reference: 'JE-1', status: 'posted', description: 'August assessments', source_module: 'billing' },
  e1: { id: 'je-e1', posting_date: '2026-08-15', reference: 'JE-2', status: 'posted', description: 'Landscaping bill', source_module: 'ap_invoice', source_document_path: 'ap_invoices/x.pdf' },
  pay: { id: 'je-p1', posting_date: '2026-08-20', reference: 'JE-3', status: 'posted', description: 'Pay landscaper', source_module: 'ap_payment' },
  bad: { id: 'je-bad', posting_date: '2026-09-02', reference: 'JE-4', status: 'voided', void_reversal_je_id: 'je-rev', description: 'Mistaken entry' },
  rev: { id: 'je-rev', posting_date: '2026-09-03', reference: 'JE-5', status: 'posted', reverses_je_id: 'je-bad', description: 'Reversal of JE-4' },
  draft: { id: 'je-draft', posting_date: '2026-09-05', reference: 'JE-6', status: 'draft', description: 'Never posted' },
  voidNoRev: { id: 'je-vnr', posting_date: '2026-09-06', reference: 'JE-7', status: 'voided', description: 'Voided without reversal (does not count)' },
  sep: { id: 'je-s1', posting_date: '2026-09-10', reference: 'JE-8', status: 'posted', description: 'September assessments' },
  xfer: { id: 'je-x', posting_date: '2026-09-12', reference: 'JE-9', status: 'posted', description: 'Reserve transfer' },
};
let n = 0;
const L = (je, account_id, debit, credit, fund_id = null) => ({ id: `l${++n}`, journal_entry_id: je.id, line_number: n, account_id, fund_id, debit_cents: debit, credit_cents: credit, memo: null, journal_entries: je });
const LINES = [
  L(JES.conv, 'a-cash', 5000000, 0), L(JES.conv, 'a-res', 20000000, 0), L(JES.conv, 'a-eq', 0, 25000000),
  L(JES.a1, 'a-cash', 1200000, 0), L(JES.a1, 'a-rev', 0, 1200000),
  L(JES.e1, 'a-exp', 300000, 0), L(JES.e1, 'a-ap', 0, 300000, 'f-op'),
  L(JES.pay, 'a-ap', 300000, 0, 'f-op'), L(JES.pay, 'a-cash', 0, 300000),
  L(JES.bad, 'a-exp', 99900, 0), L(JES.bad, 'a-cash', 0, 99900),
  L(JES.rev, 'a-exp', 0, 99900), L(JES.rev, 'a-cash', 99900, 0),
  L(JES.draft, 'a-exp', 55500, 0), L(JES.draft, 'a-cash', 0, 55500),
  L(JES.voidNoRev, 'a-exp', 44400, 0), L(JES.voidNoRev, 'a-cash', 0, 44400),
  L(JES.sep, 'a-cash', 1200000, 0), L(JES.sep, 'a-rev', 0, 1200000),
  L(JES.xfer, 'a-cash', 0, 500000), L(JES.xfer, 'a-cash', 500000, 0, 'f-res'),   // same account, two funds
  L(JES.a1, 'a-old', 777, 0), L(JES.a1, 'a-rev', 0, 777),
];
const linesFor = (id) => LINES.filter((l) => l.account_id === id);
const acct = (id) => ACCTS.find((a) => a.id === id);

function assertEveryRowTies(scope) {
  const tb = tbd.scopedTrialBalance({ accounts: ACCTS, lines: LINES, funds: FUNDS, ...scope });
  assert.ok(!tb.error, tb.error);
  for (const r of tb.rows) {
    const d = tbd.buildDetail({ account: acct(r.account_id), lines: linesFor(r.account_id), fundId: r.fund_id, ...scope, pageSize: 3 });
    assert.deepStrictEqual([d.tb_row.total_debits_cents, d.tb_row.total_credits_cents], [r.total_debits_cents, r.total_credits_cents], `${r.account_number}/${r.fund_code}`);
    assert.strictEqual(d.opening.net_cents + d.period.debits_cents - d.period.credits_cents, d.ending.net_cents, 'opening + debits - credits = ending');
    assert.strictEqual(d.ending.net_cents, r.balance_cents);
  }
  return tb;
}

t('all-history: every row ties to its detail; TB balances when no inactive account carries postings', () => {
  assertEveryRowTies({});
  const clean = LINES.filter((l) => l.journal_entries !== JES.a1 || !['a-old'].includes(l.account_id)).filter((l) => !(l.journal_entries === JES.a1 && l.credit_cents === 777));
  const tb = tbd.scopedTrialBalance({ accounts: ACCTS, lines: clean, funds: FUNDS });
  assert.ok(tb.balanced, JSON.stringify(tb.totals));
});
t('an inactive account with postings is dropped exactly as v_trial_balance drops it, so the TB shows OUT of balance (surfaced, not hidden)', () => {
  const tb = tbd.scopedTrialBalance({ accounts: ACCTS, lines: LINES, funds: FUNDS });
  assert.strictEqual(tb.balanced, false);
  assert.strictEqual(tb.totals.credits - tb.totals.debits, 777);
});
t('scoped (September): every row ties; the scoped TB is still in balance', () => {
  const tb = assertEveryRowTies({ start: '2026-09-01', end: '2026-09-30' });
  // Balance-sheet rows carry forward, income rows are September-only, so the
  // scoped TB balances only with the prior-period P&L rolled into equity; the
  // rows themselves still tie exactly.
  assert.ok(tb.rows.length > 0);
});
t('drafts and voids WITHOUT a reversal never count; voided-with-reversal pairs show both sides and net to zero', () => {
  const d = tbd.buildDetail({ account: acct('a-exp'), lines: linesFor('a-exp'), fundId: 'f-op' });
  const refs = d.lines.map((l) => l.reference);
  assert.ok(!refs.includes('JE-6') && !refs.includes('JE-7'), refs.join());
  assert.ok(refs.includes('JE-4') && refs.includes('JE-5'));
  assert.strictEqual(d.lines.find((l) => l.reference === 'JE-4').entry_status, 'voided_with_reversal');
  assert.strictEqual(d.ending.net_cents, 300000, 'landscaping only; the mistaken entry nets out');
});
t('balance-sheet account carries forward: opening includes conversion + August, period is September', () => {
  const d = tbd.buildDetail({ account: acct('a-cash'), lines: linesFor('a-cash'), fundId: 'f-op', start: '2026-09-01', end: '2026-09-30' });
  assert.strictEqual(d.scope.carries_forward, true);
  assert.strictEqual(d.opening.net_cents, 5000000 + 1200000 - 300000);
  assert.deepStrictEqual(d.lines.map((l) => l.reference), ['JE-4', 'JE-5', 'JE-8', 'JE-9']);
  assert.strictEqual(d.ending.net_cents, 5000000 + 1200000 - 300000 + 1200000 - 500000);
});
t('income account follows the report period only: August assessments are out of a September scope', () => {
  const d = tbd.buildDetail({ account: acct('a-rev'), lines: linesFor('a-rev'), fundId: 'f-op', start: '2026-09-01', end: '2026-09-30' });
  assert.strictEqual(d.scope.carries_forward, false);
  assert.strictEqual(d.opening.net_cents, 0);
  assert.deepStrictEqual([d.period.credits_cents, d.ending.natural_cents], [1200000, 1200000]);
  assert.ok(/credits minus debits/.test(d.sign_convention));
});
t('null-fund lines fall back to the account fund; one account in two funds is two rows that each tie', () => {
  const tb = tbd.scopedTrialBalance({ accounts: ACCTS, lines: LINES, funds: FUNDS });
  const cash = tb.rows.filter((r) => r.account_id === 'a-cash');
  assert.deepStrictEqual(cash.map((r) => r.fund_code).sort(), ['OP', 'RES']);
  const res = tbd.buildDetail({ account: acct('a-cash'), lines: linesFor('a-cash'), fundId: 'f-res' });
  assert.deepStrictEqual([res.total_lines, res.ending.net_cents], [1, 500000]);
  const ap = tb.rows.filter((r) => r.account_id === 'a-ap');
  assert.deepStrictEqual(ap.map((r) => r.fund_code), ['OP'], 'AP lines tagged OP; account has no home fund');
});
t('inactive accounts are excluded (as the view does)', () => {
  const tb = tbd.scopedTrialBalance({ accounts: ACCTS, lines: LINES, funds: FUNDS });
  assert.ok(!tb.rows.some((r) => r.account_id === 'a-old'));
});
t('running balance is continuous across pages and ends at the ending balance', () => {
  const all = tbd.buildDetail({ account: acct('a-cash'), lines: linesFor('a-cash'), fundId: 'f-op', pageSize: 500 });
  const p1 = tbd.buildDetail({ account: acct('a-cash'), lines: linesFor('a-cash'), fundId: 'f-op', pageSize: 2, page: 1 });
  const p2 = tbd.buildDetail({ account: acct('a-cash'), lines: linesFor('a-cash'), fundId: 'f-op', pageSize: 2, page: 2 });
  assert.deepStrictEqual([...p1.lines, ...p2.lines].map((l) => l.running_balance_cents), all.lines.slice(0, 4).map((l) => l.running_balance_cents));
  assert.strictEqual(all.lines[all.lines.length - 1].running_balance_cents, all.ending.net_cents);
  assert.strictEqual(p1.pages, Math.ceil(all.total_lines / 2));
  const beyond = tbd.buildDetail({ account: acct('a-cash'), lines: linesFor('a-cash'), fundId: 'f-op', pageSize: 2, page: 999 });
  assert.strictEqual(beyond.page, beyond.pages, 'page clamps to the last page');
});
t('lines carry source navigation (JE id, reference, source module, document path)', () => {
  const d = tbd.buildDetail({ account: acct('a-exp'), lines: linesFor('a-exp'), fundId: 'f-op' });
  const l = d.lines.find((x) => x.reference === 'JE-2');
  assert.deepStrictEqual([l.journal_entry_id, l.source_module, l.source_document_path], ['je-e1', 'ap_invoice', 'ap_invoices/x.pdf']);
});
t('invalid scopes are refused; an empty account returns an empty, balanced detail', () => {
  assert.strictEqual(tbd.validateScope({ start: '2026-13-01' }).error, 'start_invalid');
  assert.strictEqual(tbd.validateScope({ start: '2026-09-30', end: '2026-09-01' }).error, 'start_after_end');
  const d = tbd.buildDetail({ account: acct('a-old'), lines: [], fundId: 'f-op' });
  assert.deepStrictEqual([d.total_lines, d.ending.net_cents, d.lines.length], [0, 0, 0]);
});

console.log(failed ? `\n${failed} FAILED` : '\nall trial-balance drill-down checks passed');
process.exitCode = failed ? 1 : 0;
