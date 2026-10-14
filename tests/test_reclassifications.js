// Controlled reclassifications (lib/accounting/reclassifications) and contract line rules
// (lib/ap/line_rules). Shapes are Canyon Gate's 2026 onsite staffing: Bedrock bills $2,500 management
// fee + $2,700 onsite staff + $150 website a month; the staffing sat in 5810 Management Fees and moves
// to 5855 Clubhouse Office Staffing. Jan-Jul is in the converted 5810 opening balance ($36,400 at
// 7/31), Aug-Oct in posted entries; GL cutover 8/1/2026.
const R = require('../lib/accounting/reclassifications');
const LR = require('../lib/ap/line_rules');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const facts = () => ({
  community_id: 'cg', cutover_date: '2026-08-01',
  accounts: { 5810: { id: 'a5810', account_type: 'expense', fund_id: 'opr' }, 5855: { id: 'a5855', account_type: 'expense', fund_id: 'opr' }, 1000: { id: 'a1000', account_type: 'asset', fund_id: 'opr' }, 5711: { id: 'a5711', account_type: 'expense', fund_id: 'rsv' } },
  balances: { 5810: [{ posting_date: '2026-07-31', cents: 3640000 }, { posting_date: '2026-08-25', cents: 520000 }, { posting_date: '2026-09-03', cents: 520000 }, { posting_date: '2026-10-01', cents: 520000 }], 5855: [] },
  posted_refs: new Set(),
});
const ev = (s) => ({ source: s, basis: 'Bedrock agreement Exhibit A: Onsite Staff $2,700 monthly.' });
const item = (id, date, cents, extra = {}) => ({ id, label: `Onsite staffing ${id}`, posting_date: date, from_account: '5810', to_account: '5855', amount_cents: cents, evidence: ev(`invoice ${id}`), ...extra });
const ITEMS = [item('jan-jul', '2026-08-01', 1890000), item('aug', '2026-08-25', 270000), item('sep', '2026-09-03', 270000), item('oct', '2026-10-01', 270000)];

console.log('reclassification proposals');
{
  const r = R.buildProposals(facts(), ITEMS);
  check('four balanced entries, Dr 5855 / Cr 5810, $27,000 moved', r.items.length === 4 && r.totals.amount_cents === 2700000 && r.items.every((p) => p.entries[0].lines[0].account_number === '5855' && p.entries[0].lines[0].debit_cents === p.entries[0].lines[1].credit_cents && p.entries[0].lines[1].account_number === '5810'));
  check('zero effect on total expense: 5810 -$27,000, 5855 +$27,000, net $0', r.totals.by_account['5810'] === -2700000 && r.totals.by_account['5855'] === 2700000 && r.totals.net_expense_change_cents === 0 && !r.exceptions.length, JSON.stringify(r.exceptions));
  check('each entry has an idempotency key', r.items.every((p) => p.entries[0].source_reference === `RECLASS:cg:${p.id}`));
  const pre = R.buildProposals(facts(), [item('jan-jul', '2026-07-31', 1890000)]);
  check('a date inside the certified converted period is refused (move it on the cutover date)', pre.exceptions.some((e) => /before the GL cutover/.test(e.text)));
  const over = R.buildProposals(facts(), [item('aug', '2026-08-25', 4500000)]);
  check('cannot move more than the account carries in the year through the date', over.exceptions.some((e) => /carries \$41,600\.00/.test(e.text)), JSON.stringify(over.exceptions));
  const cum = R.buildProposals(facts(), [item('a', '2026-08-25', 4000000), item('b', '2026-08-25', 160000), item('c', '2026-08-25', 1)]);
  check('...counting what earlier items already moved', cum.exceptions.some((e) => e.item_id === 'c'), JSON.stringify(cum.exceptions));
  const cash = R.buildProposals(facts(), [item('x', '2026-08-25', 100, { to_account: '1000' })]);
  check('a non-expense account is refused (it would change net income or cash)', cash.exceptions.some((e) => /expense accounts/.test(e.text)));
  const fund = R.buildProposals(facts(), [item('x', '2026-08-25', 100, { to_account: '5711' })]);
  check('another fund is refused', fund.exceptions.some((e) => /different funds/.test(e.text)));
  const noEv = R.buildProposals(facts(), [item('x', '2026-08-25', 100, { evidence: { source: 'x' } })]);
  check('an item without its basis is refused', noEv.exceptions.some((e) => /evidence/.test(e.text)));
  const f = facts(); f.posted_refs.add('RECLASS:cg:aug');
  const again = R.buildProposals(f, ITEMS);
  check('an item already posted is listed, not posted twice', again.items.find((p) => p.id === 'aug').already === true && again.totals.proposals === 3);
  const dup = R.buildProposals(facts(), [item('a', '2026-08-25', 100), item('a', '2026-09-03', 100)]);
  check('duplicate item ids are refused', dup.exceptions.some((e) => /unique id/.test(e.text)));
  check('every exception blocks posting', [pre, over, cash, fund, noEv, dup].every((x) => x.exceptions.every((e) => e.severity === 'blocking')));
}

console.log('contract line rules');
{
  const rules = [{ id: 'r1', pattern: 'onsite staff|clubhouse (office )?staff', gl_account_id: 'a5855' }, { id: 'r2', pattern: 'management fee', gl_account_id: 'a5810' }, { id: 'r3', pattern: 'website|portal', gl_account_id: 'a5030' }];
  check('"Onsite Staff (4 days week)" codes to 5855', LR.ruleForLine(rules, 'Onsite Staff (4 days week)').gl_account_id === 'a5855');
  check('"Monthly Management Fee" codes to 5810', LR.ruleForLine(rules, 'Monthly Management Fee').gl_account_id === 'a5810');
  check('"Website and homeowner/board Portals" codes to 5030', LR.ruleForLine(rules, 'Website and homeowner/board Portals').gl_account_id === 'a5030');
  check('"Monthly Onsite Staff (4 days week)" (Vantaca wording) codes to 5855', LR.ruleForLine(rules, '2605CG - Bedrock Association Management LLC - Monthly Onsite Staff (4').gl_account_id === 'a5855');
  check('a line matching two accounts is ambiguous: no rule, left for review', LR.ruleForLine(rules, 'Clubhouse staffing management fee').ambiguous === true);
  check('an activity line (postage) has no rule and falls to the classifier', LR.ruleForLine(rules, 'Postage — DRV notices') === null);
  check('a malformed pattern is ignored, never thrown', LR.ruleForLine([{ pattern: '(', gl_account_id: 'x' }], 'anything') === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
