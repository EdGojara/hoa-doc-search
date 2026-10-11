// tests/test_statement_transfers.js  (Ed 2026-10-11, Canyon Gate close)
// Interfund transfers present separately from revenue and expense on the
// statements, with the SAME rules as the budget-by-fund classification and the
// working forecast (migration 506 configuration: account_subtype
// 'interfund_transfer' + from / to fund). Preparer management notes ride on the
// statement model. Drama Creek fixture: 4900 Reserve Contribution Income (RES)
// carries the Operating -> Reserve transfer ($12,500/month budget, $12,500 posted
// in September); the fixture's two-line 5900 expense side is removed so the
// transfer is recorded once, as configured communities record it.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'; process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const Module = require('module');
const F = require('./fixtures/drama_creek_statements');
const realLoad = Module._load;
Module._load = function (r) { if (r === '@supabase/supabase-js') return { createClient: () => F.fakeClient() }; return realLoad.apply(this, arguments); };
const M = require('../lib/statements/model');
const R = require('../lib/statements/render');
const SNAP = require('../lib/statements/snapshot');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };
const NOW = new Date('2026-10-09T18:00:00Z');
const has = (model, num) => model.sections.some((s) => s.groups.some((g) => g.lines.some((l) => l.account_number === String(num))));
const leg = (model, dir) => (model.transfers ? model.transfers.lines.find((l) => l.direction === dir) : null);

function configure(db, { budgetSign = 1 } = {}) {
  for (const f of db.account_funds) f.fund_type = f.fund_code === 'OPR' ? 'operating' : 'reserve';   // as in production (fund_type drives the label)
  const fundId = (code) => db.account_funds.find((f) => f.fund_code === code).id;
  const a = db.chart_of_accounts.find((x) => x.account_number === '4900');
  Object.assign(a, { account_subtype: 'interfund_transfer', interfund_from_fund_id: fundId('OPR'), interfund_to_fund_id: fundId('RES') });
  const a59 = db.chart_of_accounts.find((x) => x.account_number === '5900').id;
  db.budget_line_items = db.budget_line_items.filter((b) => b.account_id !== a59);
  db.journal_entry_lines = db.journal_entry_lines.filter((l) => l.account_id !== a59);
  if (budgetSign < 0) for (const b of db.budget_line_items.filter((x) => x.account_id === a.id)) { b.annual_amount_cents = -b.annual_amount_cents; b.monthly_amounts_cents = b.monthly_amounts_cents.map((n) => -n); }
}

(async () => {
  console.log('pure helpers');
  check('outgoing leg of a negative revenue line (Vantaca 4010) is a positive amount', M.transferAmount(-1366700, 'revenue', true) === 1366700);
  check('incoming revenue line and outgoing expense line are positive as stored; null stays null', M.transferAmount(500, 'revenue', false) === 500 && M.transferAmount(500, 'expense', true) === 500 && M.transferAmount(null, 'revenue', true) === null);
  const out = M.transferLegValues({ budget: { mtd: -1000, ytd: -9000 }, actual: { mtd: 0, ytd: null }, accountType: 'revenue', outgoingLeg: true, direction: 'out' });
  check('OUT leg is negative; a null actual stays null (n/a, never $0); variance = actual - budget', out.mtd_budget === -1000 && out.ytd_budget === -9000 && out.mtd_actual === 0 && out.mtd_var === 1000 && out.ytd_actual === null && out.ytd_var === null);
  const inn = M.transferLegValues({ budget: { mtd: -1000, ytd: -9000 }, actual: { mtd: 0, ytd: null }, accountType: 'revenue', outgoingLeg: true, direction: 'in' });
  check('IN leg is the same amount, positive', inn.mtd_budget === 1000 && inn.ytd_budget === 9000);
  check('notes: strings and {text} kept, blanks dropped', JSON.stringify(M.normalizeNotes(['a', { text: ' b ' }, '', null, { text: '' }])) === JSON.stringify([{ code: 'management', text: 'a' }, { code: 'management', text: 'b' }]) && M.normalizeNotes(undefined).length === 0);

  console.log('unconfigured: unchanged behavior');
  F.seed(); let sb = F.fakeClient();
  const plain = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
  check('no transfers block; 4900 stays in Reserve revenue (subtype alone without funds never reclassifies)', !plain.transfers && has(plain, 4900));
  F.getDb().chart_of_accounts.find((x) => x.account_number === '4900').account_subtype = 'interfund_transfer';
  const half = await M.buildIncomeBudgetModel(F.fakeClient(), { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
  check('subtype set but from / to funds missing: not treated as a transfer', !half.transfers && has(half, 4900));

  console.log('configured transfer (Operating -> Reserve)');
  F.seed(); configure(F.getDb()); sb = F.fakeClient();
  const notes = ['August includes a one-time reclassification of earlier project costs to the Reserve.'];
  const opr = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW, management_notes: notes });
  const res = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
  check('4900 leaves Reserve revenue', !has(res, 4900));
  const o = leg(opr, 'out'), i = leg(res, 'in');
  check('Operating shows the OUT leg; Reserve shows the IN leg; neither shows the other', !!o && !!i && !leg(opr, 'in') && !leg(res, 'out'));
  check('budget: Operating (12,500) per month and (112,500) YTD; Reserve +12,500 / +112,500', o.values.mtd_budget === -1250000 && o.values.ytd_budget === -11250000 && i.values.mtd_budget === 1250000 && i.values.ytd_budget === 11250000, JSON.stringify({ o: o.values, i: i.values }));
  check('September actual comes from the books: $12,500 moved (Operating -12,500, Reserve +12,500)', o.values.mtd_actual === -1250000 && i.values.mtd_actual === 1250000, JSON.stringify([o.values.mtd_actual, i.values.mtd_actual, o.actual_status]));
  check('labels name the direction', /Planned reserve funding \(to RES\)/.test(o.account_name) && /Transfer in from OPR/.test(i.account_name));
  check('net change in fund balance = net income + transfers (month)', opr.net_change.values.mtd_actual === opr.net.values.mtd_actual + opr.transfers.total.values.mtd_actual && res.net_change.values.mtd_budget === res.net.values.mtd_budget + res.transfers.total.values.mtd_budget);
  const all = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'all', now: NOW });
  check('all funds: both legs shown and they net to zero (never double-counted)', all.transfers.lines.length === 2 && all.transfers.total.values.mtd_budget === 0 && all.transfers.total.values.mtd_actual === 0);
  check('management note is a model note; snapshot hash covers transfers', opr.notes.some((n) => n.code === 'management' && n.text === notes[0]) && M.statementContent(opr).transfers && M.statementContent(opr).net_change);

  console.log('Vantaca one-negative-line budget (Canyon Gate 4010 shape)');
  F.seed(); configure(F.getDb(), { budgetSign: -1 }); sb = F.fakeClient();
  const opr2 = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'OPR', now: NOW });
  const res2 = await M.buildIncomeBudgetModel(sb, { community_id: F.CID, period_end: '2026-09-30', fund: 'RES', now: NOW });
  check('a negative budget on the Reserve 4010 line still presents Operating OUT and Reserve IN', leg(opr2, 'out').values.ytd_budget === -11250000 && leg(res2, 'in').values.ytd_budget === 11250000);

  console.log('render');
  const pr = R.renderHtml(opr, { mode: 'print' });
  check('print shows the transfers block, its total and the net change line', /Interfund transfers in \(out\)/.test(pr) && /Total interfund transfers/.test(pr) && /Net change in fund balance/.test(pr) && /Planned reserve funding/.test(pr));
  check('the management note renders in the header notes', pr.includes(notes[0]));
  const xr = R.xlsxRows(opr).map((x) => (Array.isArray(x) ? x : x.cells)).map((c) => c[0]);
  check('xlsx rows include the transfers block and net change', xr.includes('Interfund transfers in (out)') && xr.includes('Net change in fund balance'));

  console.log('snapshot + balance sheet notes');
  const snap = await SNAP.buildSectionSnapshot(sb, { community_id: F.CID, section_key: 'income_statement', cutoff: '2026-09-30', now: NOW, management_notes: notes });
  check('snapshot passes notes to every fund statement', snap.models.length >= 2 && snap.models.every((m) => m.notes.some((n) => n.code === 'management')));
  F.seed(); sb = F.fakeClient();
  const bs = await M.buildBalanceSheetModel(sb, { community_id: F.CID, as_of: '2026-09-30', now: NOW, management_notes: ['BS note'] });
  check('balance sheet carries management notes and still balances', bs.notes.some((n) => n.text === 'BS note') && bs.totals.balanced.current === true);

  console.log(`\nstatement_transfers: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
