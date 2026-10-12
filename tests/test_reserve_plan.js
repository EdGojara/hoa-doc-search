// Reserve plan (Ed 2026-10-11): reserve expenditures come only from planned capital
// projects, aggregated by GL account; legacy saved amounts are carried once and flagged;
// funding is transfers in plus reserve revenue; the editor and the PDF share this code.
'use strict';
const core = require('../public/js/reserve_plan_core');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };

const accounts = { hvac: { account_number: '5713', account_name: 'RSRV-HVAC' }, mon: { account_number: '5717', account_name: 'RSRV-Monuments & Signage' }, gate: { account_number: '5723', account_name: 'RSRV-Gates & Access' } };
const contribution = { account_id: 'c4010', label: '4010 Reserve Contribution', kind: 'transfer', amount_cents: core.transferIntoReserve({ account_type: 'revenue', amount_cents: -16400000, to_fund_type: 'reserve', from_fund_type: 'operating' }) };

console.log('transfers');
check('a negative one-line transfer budget (-$164,000) is +$164,000 into the reserve fund', contribution.amount_cents === 16400000);
check('a positive transfer line into reserve is the same +$164,000', core.transferIntoReserve({ account_type: 'revenue', amount_cents: 16400000, to_fund_type: 'reserve', from_fund_type: 'operating' }) === 16400000);
check('a transfer out of the reserve fund is negative funding', core.transferIntoReserve({ account_type: 'revenue', amount_cents: -1040900, to_fund_type: 'operating', from_fund_type: 'reserve' }) === -1040900);
check('a transfer between two other funds does not touch reserve', core.transferIntoReserve({ account_type: 'expense', amount_cents: 5000, to_fund_type: 'other', from_fund_type: 'operating' }) === 0);

console.log('no projects: no expenditures (never a trend of prior spending)');
{
  const p = core.computeReservePlan({ projects: [], saved_lines: [], plan_saved: false, funding: [contribution], beginning_cents: 109185859, accounts });
  check('capex $0.00 with no planned project', p.totals.capex_cents === 0);
  check('funding $164,000, net change +$164,000', p.totals.funding_cents === 16400000 && p.totals.net_change_cents === 16400000);
  check('ending = beginning + net change', p.totals.ending_cents === 109185859 + 16400000);
}

console.log('projects aggregate by GL account; several projects may share one account');
{
  const projects = [
    { project_name: 'Entry monument refurbish', account_id: 'mon', planned_month: 4, planned_amount_cents: 2500000 },
    { project_name: 'Section 8 sign replacement', account_id: 'mon', planned_month: 9, planned_amount_cents: 450000 },
    { project_name: 'Gate operator replacement', account_id: 'gate', planned_month: 6, planned_amount_cents: 1800000 },
  ];
  const p = core.computeReservePlan({ projects, funding: [contribution, { account_id: 'i', label: 'Interest', kind: 'revenue', amount_cents: 4000 }], beginning_cents: 100000000, accounts });
  const mon = p.by_account.find((b) => b.account_id === 'mon');
  check('5717 = $25,000 + $4,500 (two projects, one line)', mon && mon.total_cents === 2950000 && mon.project_count === 2);
  check('capex counts every project exactly once ($47,500)', p.totals.capex_cents === 4750000);
  check('funding = transfer + interest', p.totals.funding_cents === 16404000 && p.totals.transfers_cents === 16400000 && p.totals.revenue_cents === 4000);
  check('net change = funding - capex', p.totals.net_change_cents === 16404000 - 4750000);
  check('timing label carried', p.projects[0].month_label === 'April');
  check('by_account sorted by account number', p.by_account.map((b) => b.account_number).join(',') === '5717,5723');
}

console.log('legacy saved amounts: carried once, flagged, never dropped');
{
  const saved = [{ account_id: 'hvac', amount_cents: 1334880 }, { account_id: 'mon', amount_cents: 5000000 }];
  const p = core.computeReservePlan({ projects: [{ project_name: 'Monument', account_id: 'mon', planned_month: 3, planned_amount_cents: 2000000 }], saved_lines: saved, plan_saved: false, funding: [contribution], beginning_cents: 0, accounts });
  check('an account with a saved amount and no project becomes a needs-review item', p.review_items.length === 1 && p.review_items[0].account_id === 'hvac' && p.review_items[0].amount_cents === 1334880);
  check('an account that has a project uses the project, not the saved amount (no double count)', p.by_account.find((b) => b.account_id === 'mon').total_cents === 2000000);
  check('capex = project + carried review amount, each once', p.totals.capex_cents === 2000000 + 1334880 && p.totals.review_cents === 1334880 && p.totals.planned_cents === 2000000);
  const after = core.computeReservePlan({ projects: [{ project_name: 'Monument', account_id: 'mon', planned_month: 3, planned_amount_cents: 2000000 }], saved_lines: saved, plan_saved: true, funding: [], accounts });
  check('once the plan is project-based, saved lines are derived and never resurrected', after.review_items.length === 0 && after.totals.capex_cents === 2000000);
  const flagged = core.computeReservePlan({ projects: [{ project_name: 'Carried', account_id: 'hvac', planned_amount_cents: 1334880, review_status: 'needs_review' }], plan_saved: true, accounts });
  check('a carried amount saved as a needs-review project stays flagged in the totals', flagged.totals.review_cents === 1334880 && flagged.by_account[0].review_cents === 1334880);
}

console.log('incomplete input is surfaced, not hidden');
{
  const p = core.computeReservePlan({ projects: [{ project_name: 'Pool deck', planned_amount_cents: 900000 }, { project_name: '', planned_amount_cents: 0 }], accounts });
  check('a project without a GL account is warned and still counted', p.warnings.some((w) => w.code === 'project_without_account') && p.totals.capex_cents === 900000);
  check('a project without timing is warned', p.warnings.some((w) => w.code === 'project_without_timing'));
  check('blank rows are ignored', p.projects.length === 1);
  check('unknown beginning balance gives no invented ending balance', p.totals.beginning_cents === null && p.totals.ending_cents === null);
  check('empty call is safe', core.computeReservePlan().totals.capex_cents === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
