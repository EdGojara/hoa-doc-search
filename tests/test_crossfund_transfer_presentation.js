// Financial-statement presentation of a cross-fund transfer and of unidentified receipts, through
// the ACTUAL statement engine (lib/statements/model + render), on the Drama Creek fixture extended
// with a Savings fund. The entries are exactly what Kat's reconciliation posts (PR 191): the
// transfer account once in each fund (Dr 4015 SAV / Cr 1100; Dr 1200 RES / Cr 4015 RES) and the
// suspense receipt (Dr 1000 / Cr 2400, "Unidentified homeowner receipt ...", no property).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const Module = require('module');
const F = require('./fixtures/drama_creek_statements');
const realLoad = Module._load;
Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return realLoad.apply(this, arguments); };
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };
const NOW = new Date('2026-10-14T18:00:00Z');
const CID = F.CID;
let seq = 900;

function addSavingsFund(db) {
  db.account_funds.push({ id: 'f-sav', community_id: CID, fund_code: 'SAV', fund_name: 'Savings', fund_type: 'other', is_active: true, display_order: 3 });
  const acct = (n, type, name, fund, extra = {}) => db.chart_of_accounts.push({ id: `a-${n}`, community_id: CID, account_number: String(n), account_name: name, account_type: type, normal_balance: ['asset', 'expense'].includes(type) ? 'debit' : 'credit', is_active: true, is_summary: false, fund_id: fund, account_subtype: null, account_funds: { fund_code: fund === 'f-sav' ? 'SAV' : fund === 'f-res' ? 'RES' : 'OPR' }, ...extra });
  acct(1100, 'asset', 'Savings Money Market', 'f-sav');
  acct(3030, 'equity', 'Savings Fund Balance', 'f-sav');
  acct(4015, 'revenue', 'Transfer Savings to Reserve', 'f-sav', { account_subtype: 'interfund_transfer', interfund_from_fund_id: 'f-sav', interfund_to_fund_id: 'f-res' });
}
function post(db, ref, date, lines, description) {
  const id = `je-x${++seq}`;
  db.journal_entries.push({ id, community_id: CID, reference: ref, posting_date: date, source_module: 'bank_reconciliation', status: 'posted', void_reversal_je_id: null, reverses_je_id: null, description: description || ref });
  lines.forEach(([n, fund, d, c, prop], i) => db.journal_entry_lines.push({ id: `jl-x${++seq}`, journal_entry_id: id, line_number: i + 1, account_id: `a-${n}`, fund_id: fund, debit_cents: d, credit_cents: c, memo: null, vendor_id: null, property_id: prop || null }));
}
const build = (fund) => M.buildIncomeBudgetModel(F.fakeClient(), { community_id: CID, period_end: '2026-09-30', fund, now: NOW });
const K = ['mtd_actual', 'mtd_budget', 'ytd_actual', 'ytd_budget'];
const same = (a, b) => K.every((k) => a[k] === b[k]);

(async () => {
  // Baseline: the fund exists with its opening balance, nothing moved yet.
  F.seed(); let db = F.getDb(); addSavingsFund(db);
  post(db, 'OPEN-SAV', '2026-07-31', [[1100, 'f-sav', 10000000, 0], [3030, 'f-sav', 0, 10000000]]);
  const base = { OPR: await build('OPR'), RES: await build('RES'), SAV: await build('SAV'), all: await build('all') };

  // After: the two 9/10 transfers and an unidentified receipt, posted as Kat posts them.
  F.seed(); db = F.getDb(); addSavingsFund(db);
  post(db, 'OPEN-SAV', '2026-07-31', [[1100, 'f-sav', 10000000, 0], [3030, 'f-sav', 0, 10000000]]);
  for (const ref of ['XFER-2025', 'XFER-2026']) post(db, ref, '2026-09-10', [[4015, 'f-sav', 4270000, 0], [1100, 'f-sav', 0, 4270000], [1200, 'f-res', 4270000, 0], [4015, 'f-res', 0, 4270000]], 'Interfund transfer SAV to RES');
  post(db, 'UNID-1', '2026-09-04', [[1000, 'f-opr', 5000, 0], [2400, 'f-opr', 0, 5000]], 'Unidentified homeowner receipt: PROPAY TRANSFER XXXXX4001 (Operating 9/4/2026)');
  const after = { OPR: await build('OPR'), RES: await build('RES'), SAV: await build('SAV'), all: await build('all') };

  console.log('transfer below net income, each fund its own side');
  const tline = (m) => m.transfers && m.transfers.groups[0].lines.find((l) => l.account_number === '4015');
  const s = tline(after.SAV), r = tline(after.RES);
  check('Savings: "Transfer to Reserve Fund" -$85,400 (month and YTD), in the transfers section below net income', s && /Transfer to Reserve/.test(s.account_name) && s.values.mtd_actual === -8540000 && s.values.ytd_actual === -8540000, JSON.stringify(s && [s.account_name, s.values]));
  check('Reserve: "Transfer from Savings Fund" +$85,400', r && /Transfer from Savings/.test(r.account_name) && r.values.ytd_actual === 8540000, JSON.stringify(r && [r.account_name, r.values]));
  check('neither fund shows 4015 as revenue or expense', ['SAV', 'RES'].every((f) => after[f].sections.every((sec) => sec.groups.every((g) => g.lines.every((l) => l.account_number !== '4015')))));
  check('Savings and Reserve net income BEFORE transfers are unchanged by the transfer', same(after.SAV.net.values, base.SAV.net.values) && same(after.RES.net.values, base.RES.net.values), JSON.stringify([after.SAV.net.values, base.SAV.net.values]));
  check('the change in fund balance after transfers moves by exactly -$85,400 / +$85,400', after.SAV.change && after.RES.change && after.SAV.change.values.ytd_actual - (base.SAV.change ? base.SAV.change.values.ytd_actual : base.SAV.net.values.ytd_actual) === -8540000 && after.RES.change.values.ytd_actual - (base.RES.change ? base.RES.change.values.ytd_actual : base.RES.net.values.ytd_actual) === 8540000);

  console.log('operating results and budgets undistorted');
  check('Operating revenue, expenses and net income are identical before and after (the suspense receipt is not revenue)', after.OPR.sections.every((sec, i) => same(sec.total.values, base.OPR.sections[i].total.values)) && same(after.OPR.net.values, base.OPR.net.values));
  check('budget columns everywhere are unchanged (4015 carries no budget; existing budgets untouched)', ['OPR', 'RES', 'SAV'].every((f) => after[f].sections.every((sec, i) => sec.total.values.ytd_budget === base[f].sections[i].total.values.ytd_budget)));

  console.log('consolidated: the transfer eliminates');
  const allT = after.all.transfers ? after.all.transfers.total.values.ytd_actual : 0;
  check('all funds: the $85,400 nets to zero and is not presented as a transfer line (it eliminates)', !after.all.transfers && allT === 0, JSON.stringify(after.all.transfers && after.all.transfers.total.values));
  check('all funds: association net income unchanged by the transfer and the suspense receipt', same(after.all.net.values, base.all.net.values));
  check('all funds: a note states what moved between the funds', after.all.notes.some((n) => /Interfund transfers are not association revenue or expense/.test(n.text) && /Savings Fund: Transfer to Reserve Fund/.test(n.text) && /actual \$85,400\.00/.test(n.text)), JSON.stringify(after.all.notes.map((n) => n.text)));

  console.log('balance sheet by fund');
  const bs = await M.buildBalanceSheetModel(F.fakeClient(), { community_id: CID, as_of: '2026-09-30', view: 'fund', now: NOW });
  const col = (code) => bs.columns.find((c) => c.fund_code === code);
  check('every fund balances (assets = liabilities + fund balance) with the transfer posted', bs.columns.every((c) => bs.totals.balanced[c.key] !== false), JSON.stringify(bs.totals.balanced));
  const cashOf = (code) => { const k = col(code) && col(code).key; let t = 0; for (const sec of bs.sections.filter((x) => x.key === 'asset')) for (const g of sec.groups) for (const l of g.lines) if (['1100', '1200'].includes(l.account_number)) t += Number(l.values[k] || 0); return t; };
  check('Savings cash is $14,600 (100,000 - 85,400); Reserve cash rose by $85,400', cashOf('SAV') === 1460000, String(cashOf('SAV')));

  console.log('printed statements');
  const html = R.renderDocument([after.SAV, after.RES]);
  check('the printed Savings and Reserve statements show the transfer lines below net income', /Transfer to Reserve Fund/.test(html) && /Transfer from Savings Fund/.test(html) && html.indexOf('Savings Fund net income before transfers') < html.indexOf('Transfer to Reserve Fund'));

  console.log('unidentified receipts: traceable, not on any homeowner');
  const unid = db.journal_entries.find((j) => j.reference === 'UNID-1');
  check('no line of the suspense entry names a property; no homeowner ledger row exists for it', db.journal_entry_lines.filter((l) => l.journal_entry_id === unid.id).every((l) => !l.property_id) && !(db.homeowner_transactions || []).length);
  // The owner tie-out's own function finds it by its description, from the 2400 lines.
  const AR = require('../lib/ar/ar_control');
  const mini = { from(t) { const st = { f: [] }; const q = { select() { return q; }, eq(c, v) { st.f.push((r) => r[c] === v); return q; }, ilike(c, p) { const re = new RegExp('^' + p.replace(/%/g, '.*'), 'i'); st.f.push((r) => re.test(r[c] || '')); return q; }, in(c, vs) { st.f.push((r) => vs.includes(r[c])); return q; }, limit() { return q; },
    then(res) { const src = t === 'journal_entries' ? db.journal_entries : t === 'chart_of_accounts' ? db.chart_of_accounts : db.journal_entry_lines; return Promise.resolve({ data: src.filter((r) => st.f.every((fn) => fn(r))), error: null }).then(res); } }; return q; } };
  const found = await AR.unidentifiedReceipts(mini, CID);
  check('the receivables tie-out identifies it as an unidentified receipt held in 2400 ($50.00, UNID-1), set aside from the owner comparison', found && found.cents === 5000 && found.references.includes('UNID-1'), JSON.stringify(found));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
