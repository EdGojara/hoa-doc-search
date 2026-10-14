// Printable board budget report (lib/budget/board_report): a presentation of the proposed-budget
// models. Tests the parts that decide what a board reads: PROPOSED until approved, the seven columns,
// material-change selection, board-ready notes, and the pending-reclassification footnote.
const B = require('../lib/budget/board_report');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

console.log('notes and materiality');
check('system prefix and sign-off removed from a draft note', B.cleanNote('FY2027 draft from working forecast fd76e606: Porter services continue in 2027 (confirmed by Ed 2026-10-10): $1,000/week x 52. Validated 2027 recommendation (Canyon Gate budget worksheet; Ed Gojara authorized 2026-10-10).') === 'Porter services continue in 2027: $1,000/week x 52.', B.cleanNote('FY2027 draft from working forecast fd76e606: Porter services continue in 2027 (confirmed by Ed 2026-10-10): $1,000/week x 52. Validated 2027 recommendation (Canyon Gate budget worksheet; Ed Gojara authorized 2026-10-10).'));
check('record ids are not printed', !/library document|contract record/.test(B.cleanNote('UPS agreement (start 10/1/2026; library document 4987661a, contract record 96321a51): Exhibit A annual.')));
check('material: $14,116 on $92,000 (15%)', B.isMaterial({ appr: 9200000, chg: 1411600 }));
check('not material: $3,116 on $124,000 (2.5%)', !B.isMaterial({ appr: 12400000, chg: 311600 }));
check('not material: under $2,500 even at 100%', !B.isMaterial({ appr: 150000, chg: -150000 }));
check('material: a new line of $9,000', B.isMaterial({ appr: 0, chg: 900000 }));

console.log('rendered report');
const fund = (code, title) => ({ fund: code, title, transfers: false, change: null, warnings: [],
  net: { label: 'Excess (deficit) of revenue over expenses', values: { appr: 100000, proj: 50000, prop: 0, chg: -100000 } },
  fund_balance: { beginning: { label: 'Beginning fund balance', values: { appr: 500000, proj: 500000, prop: 550000 } }, ending: { label: 'Ending fund balance', values: { appr: 600000, proj: 550000, prop: 550000 } } },
  sections: [{ key: 'revenue', label: 'Revenue', total: { label: 'Total revenue', values: { appr: 6450000, proj: 6450000, prop: 6450000, chg: 0 } }, groups: [{ label: 'Assessments', kind: 'category', values: { appr: 6450000, proj: 6450000, prop: 6450000, chg: 0 }, lines: [{ account_number: '4000', account_name: 'Assessments', appr: 6450000, proj: 6450000, prop: 6450000, chg: 0, pct: 0 }] }] },
    { key: 'expense', label: 'Expenses', total: { label: 'Total expenses', values: { appr: 6350000, proj: 6400000, prop: 6450000, chg: 100000 } }, groups: [{ label: 'Administrative', kind: 'category', values: { appr: 6350000, proj: 6400000, prop: 6450000, chg: 100000 },
      lines: [{ account_number: '5810', account_name: 'Management Fees', appr: 3050000, proj: 5442497, prop: 3000000, chg: -50000, pct: -0.016, pending_cents: -2700000 }, { account_number: '5855', account_name: 'Clubhouse Office Staffing', appr: 3300000, proj: 825000, prop: 3240000, chg: -60000, pct: -0.018, pending_cents: 2700000 }] }] }] });
const base = { community: { name: 'Test HOA', legal_name: 'Test HOA, Inc.' }, target_year: 2027, base_year: 2026, as_of: '2026-09-30', generated_at: '2026-10-14T12:00:00Z',
  budget: { approved: false }, status_label: 'PROPOSED – NOT APPROVED', funds: [fund('OPR', 'Operating')], material: [{ account_number: '5200', account_name: 'Landscape', appr: 9200000, prop: 10611600, chg: 1411600, pct: 0.153, explanation: 'Earthcare $8,842.67 a month.', contracts: ['EarthCare Management, Inc. (signed, not yet verified)'] }],
  assumptions: ['2026 projected = actual plus remaining budget.'], decisions: [{ topic: 'Planned reserve funding', text: '4010 Reserve Contribution: provisional.' }], exceptions: [{ text: '5115 Electricity: no agreement on file yet.' }],
  pending: [{ label: 'Onsite staffing', amount_cents: 2700000, effects: { 5810: -2700000, 5855: 2700000 }, posting_date: '2026-10-01' }] };
const html = B.renderBoardReportHtml(base);
check('marked PROPOSED – NOT APPROVED while the budget is a draft', /PROPOSED – NOT APPROVED/.test(html));
check('adopted budgets are labeled adopted, not proposed', /ADOPTED 2027 BUDGET/.test(B.renderBoardReportHtml({ ...base, budget: { approved: true }, status_label: 'ADOPTED 2027 BUDGET' })) && !/NOT APPROVED/.test(B.renderBoardReportHtml({ ...base, budget: { approved: true }, status_label: 'ADOPTED 2027 BUDGET' })));
check('the seven columns: GL, description, approved, projected actual, proposed, $ change, % change', ['GL', 'Description', 'Approved budget', 'Projected actual', 'Proposed budget', '$ change', '% change'].every((h) => html.includes(`>${h}</th>`)));
check('column headings repeat on every page (thead as a header group)', /thead\{display:table-header-group\}/.test(html));
check('5855 Clubhouse Office Staffing prints on its own row, apart from 5810', /5855<\/td><td class="l">Clubhouse Office Staffing/.test(html) && /5810<\/td><td class="l">Management Fees/.test(html));
check('rows a pending reclassification would change carry the † mark', (html.match(/class="dag">†/g) || []).length === 2);
check('material changes show their explanation and contract support', /Earthcare \$8,842\.67 a month\./.test(html) && /Contract: EarthCare Management/.test(html));
check('assumptions, board decisions and open items each have a section', /<b>Assumptions<\/b>/.test(html) && /<b>Board decisions<\/b>/.test(html) && /Open items and unresolved contract questions/.test(html));
check('no percent on net and fund-balance rows', !/Excess \(deficit\) of revenue over expenses<\/td>(<td>[^<]*<\/td>){4}<td>[^<]+%/.test(html));
check('negative amounts in parentheses, whole dollars', /\(500\)/.test(html) && !/\.\d{2}<\/td>/.test(html.split('Material changes')[0]));
check('landscape letter page with margins', /@page\{size:Letter landscape/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
