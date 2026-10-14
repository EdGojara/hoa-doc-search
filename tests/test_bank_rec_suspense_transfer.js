// Kat's bank reconciliation (lib/banking/monthly_rec): money in from an unknown payer held in
// suspense (traceable to its bank line, never an owner's credit), and a transfer between two of
// the association's own bank accounts in different funds posted with both cash sides, each line
// in its own fund, with an authorization flag reported beside the proposal. Shapes: LOPF
// September 2026 (ProPay deposit; Savings to Reserve "2025 Transfer" / "2026 Transfer").
const path = require('path');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const posted = [];
const postingPath = require.resolve(path.join(__dirname, '..', 'lib', 'accounting', 'posting'));
require.cache[postingPath] = { id: postingPath, filename: postingPath, loaded: true, exports: { postJournalEntry: async (e) => { const entry = { id: 'je' + (posted.length + 1), reference: 'JE-S-' + (posted.length + 1) }; posted.push({ ...e, entry }); return { entry }; } } };
const B = require('../lib/banking/monthly_rec');

const opening = { as_of_date: '2026-08-31', bank_balance_cents: 100000, book_balance_cents: 100000, outstanding_checks: [], deposits_in_transit: [] };
const gl = [{ id: 'g0', je_id: 'j0', reference: 'OPEN', posting_date: '2026-08-31', amount_cents: 100000, memo: 'Opening', description: 'Opening', source_module: 'opening_entry' }];
const S9 = (end) => ({ id: 'imp9', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', beginning_balance_cents: 100000, ending_balance_cents: end });
const settings = { stale_check_days: 90, stale_deposit_days: 10, match_window_days: 45,
  transfer_rules: [
    { bank_account_id: 'sav', match: '^2026 Transfer$', account: '4015', counter_cash_account: '1110', from_fund: 'SAV', to_fund: 'RES', basis: 'Budgeted 2026 contribution.' },
    { bank_account_id: 'sav', match: '^2025 Transfer$', account: '4015', counter_cash_account: '1110', from_fund: 'SAV', to_fund: 'RES', basis: 'Cash moved.', flag: 'No board authorization for a 2025 contribution is on file.' }] };

console.log('unidentified receipt (suspense)');
{
  const line = { id: 'b-propay', bank_statement_import_id: 'imp9', posting_date: '2026-09-04', amount_cents: 5000, description: 'PROPAY TRANSFER XXXXX4001', transaction_type: 'transfer' };
  const r = B.reconcileAccountMonth({ account: { id: 'opr', label: 'Operating 2449', gl_account_number: '1000' }, period_start: '2026-09-01', period_end: '2026-09-30', opening, statements: [S9(105000)], bankTxns: [line], glLines: gl, otherBankTxns: [], homeownerPayments: [], settings,
    codings: [{ bank_transaction_id: 'b-propay', account_number: '2400', unidentified: true, basis: 'ProPay deposit; payer not identified (Vantaca deposit register requested).' }] });
  const p = r.proposals.find((x) => x.id === 'coded:b-propay');
  check('money in coded to 2400: Dr 1000 / Cr 2400, dated the bank line, keyed to it', p && p.posting_date === '2026-09-04' && p.source_reference === 'bankrec:b-propay' && p.lines[0].account_number === '1000' && p.lines[0].debit_cents === 5000 && p.lines[1].account_number === '2400' && p.lines[1].credit_cents === 5000);
  check('described "Unidentified homeowner receipt" (the convention the owner tie-out sets aside); no property on any line', /^Unidentified homeowner receipt: PROPAY TRANSFER/.test(p.description) && p.lines.every((l) => !l.property_id));
  check('the exception says it is held until the payer is known', r.exceptions.some((e) => e.code === 'unidentified_receipt' && /until the payer is known/.test(e.text)));
  check('the month reconciles once proposed', r.totals.difference_cents === 0);
}

console.log('cross-fund transfer (Savings to Reserve)');
{
  const lines = [{ id: 'b-2025', bank_statement_import_id: 'imp9', posting_date: '2026-09-10', amount_cents: -4270000, description: '2025 Transfer', transaction_type: 'transfer' },
    { id: 'b-2026', bank_statement_import_id: 'imp9', posting_date: '2026-09-10', amount_cents: -4270000, description: '2026 Transfer', transaction_type: 'transfer' }];
  const r = B.reconcileAccountMonth({ account: { id: 'sav', label: 'Savings 2457', gl_account_number: '1100' }, period_start: '2026-09-01', period_end: '2026-09-30', opening: { ...opening, bank_balance_cents: 10000000, book_balance_cents: 10000000 }, statements: [{ ...S9(10000000 - 8540000), beginning_balance_cents: 10000000 }], bankTxns: lines,
    glLines: [{ ...gl[0], amount_cents: 10000000 }], otherBankTxns: [], homeownerPayments: [], settings, codings: [] });
  const p = r.proposals.find((x) => x.id === 'transfer:b-2025');
  const byFund = (pr) => { const m = {}; for (const l of pr.lines) { const f = l.fund_code || (l.account_number === '1100' ? 'SAV' : l.account_number === '1110' ? 'RES' : '?'); m[f] = (m[f] || 0) + l.debit_cents - l.credit_cents; } return m; };
  check('both cash sides and the transfer account once per fund: Dr 4015 SAV / Cr 1100; Dr 1110 / Cr 4015 RES', p && JSON.stringify(p.lines.map((l) => [l.account_number, l.fund_code || '', l.debit_cents, l.credit_cents])) === JSON.stringify([['4015', 'SAV', 4270000, 0], ['1100', '', 0, 4270000], ['1110', '', 4270000, 0], ['4015', 'RES', 0, 4270000]]));
  check('every fund balances on its own (no due-to / due-from needed)', p && Object.values(byFund(p)).every((v) => v === 0), JSON.stringify(p && byFund(p)));
  check('the 2025 line carries its authorization exception beside the proposal; the 2026 line does not', r.exceptions.filter((e) => e.code === 'authorization_exception').length === 1 && r.exceptions.some((e) => e.code === 'authorization_exception' && /2025 Transfer/.test(e.text) && /authorization remains open/.test(e.text)));
  check('the flag is written into the proposal\'s evidence', /EXCEPTION: No board authorization/.test(p.evidence.basis) && !/EXCEPTION/.test(r.proposals.find((x) => x.id === 'transfer:b-2026').evidence.basis));
  check('Savings reconciles once proposed', r.totals.difference_cents === 0);
  // Reserve's side matches the 1110 debit of the posted entry: no second proposal.
  const res = B.reconcileAccountMonth({ account: { id: 'res', label: 'Reserve 2465', gl_account_number: '1110' }, period_start: '2026-09-01', period_end: '2026-09-30', opening, statements: [S9(100000 + 4270000)],
    bankTxns: [{ id: 'r-2025', bank_statement_import_id: 'imp9', posting_date: '2026-09-10', amount_cents: 4270000, description: '2025 Transfer', transaction_type: 'transfer' }],
    glLines: [...gl, { id: 'g1', je_id: 'jx', reference: 'JE-X', posting_date: '2026-09-10', amount_cents: 4270000, memo: 'Received from Savings', description: 'Interfund transfer', source_module: 'bank_reconciliation' }], otherBankTxns: [], homeownerPayments: [], settings, codings: [] });
  check('Reserve matches its side to the posted entry and proposes nothing (no double transfer)', !res.proposals.length && res.items.some((i) => i.category === 'matched' && i.gl_ref === 'JE-X') && res.totals.difference_cents === 0);

  // Posting: each line in the fund it names.
  (async () => {
    const accts = [['4015', 'f-sav'], ['1100', 'f-sav'], ['1110', 'f-res']].map(([n, f], i) => ({ id: 'a' + i, account_number: n, fund_id: f }));
    const sb = { from: (t) => { const st = { t, f: [] }; const api = { select() { return api; }, eq(k, v) { st.f.push([k, v]); return api; }, in() { return api; }, limit() { return api; },
      then(res) { let d = []; if (t === 'chart_of_accounts') d = accts; else if (t === 'account_funds') d = [{ id: 'f-sav', fund_code: 'SAV' }, { id: 'f-res', fund_code: 'RES' }]; else if (t === 'journal_entries') d = []; return Promise.resolve({ data: d, error: null }).then(res); } }; return api; } };
    await B.postProposals(sb, { community_id: 'c', proposals: [p], actor: 'Kat', approver: 'owner' });
    const ls = posted[0].lines;
    check('posted lines carry their own fund: 4015 in SAV (debit) and in RES (credit)', ls[0].account_id === 'a0' && ls[0].fund_id === 'f-sav' && ls[3].account_id === 'a0' && ls[3].fund_id === 'f-res' && ls[2].fund_id === 'f-res' && ls[1].fund_id === 'f-sav');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
