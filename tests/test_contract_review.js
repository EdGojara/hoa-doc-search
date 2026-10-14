// Contract-driven budgeting (Canyon Gate 2027 is the validation case): the contract engine's term
// semantics (lib/contracts/contract_terms) and the review around it (lib/budget/contract_review).
// Shapes are Canyon Gate's: United Protective Services (security, 10/1/2026, Exhibit A forecast,
// "not to exceed 3%"), Gate Sentry ($495/mo, "5% each year beginning with year 4"), Star Protection
// (weekly invoices, replaced 10/1/2026), Community Controls (every ~7 weeks), Earthcare / Bedrock.
const T = require('../lib/contracts/contract_terms');
const R = require('../lib/budget/contract_review');
let pass = 0, fail = 0;
const check = (name, ok, info) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info ? ' :: ' + info : '')); } };

const UPS = { id: 'ups', vendor_name_raw: 'United Protective Services of South Texas, L.P.', effective_date: '2026-10-01', end_date: null, auto_renews: true, periodic_amount: null, periodic_frequency: 'monthly',
  rate_schedule: [{ effective_date: '2026-01-01', periodic_amount: 18526.64, periodic_frequency: 'monthly', quote: 'TOTAL 18,526.64 (Jan-26)' }, { effective_date: '2026-02-01', periodic_amount: 16506.18, periodic_frequency: 'monthly' }, { effective_date: '2026-10-01', periodic_amount: 18263.10, periodic_frequency: 'monthly' }],
  escalator_kind: 'cap_pct', escalator_pct: 3, forecast_account_id: 'a5770', vendor_id: null };
const GS = { id: 'gs', vendor_name_raw: 'Gate Sentry, LLC', effective_date: '2023-01-30', end_date: null, auto_renews: true, periodic_amount: 495, periodic_frequency: 'monthly', rate_schedule: [], escalator_kind: 'fixed_pct', escalator_pct: 5, escalator_start_year: 4, forecast_account_id: 'a5770', vendor_id: null };

console.log('contract terms');
{
  const u = T.contractCostForYear(UPS, 2027);
  check('a dated amount before the contract starts is not a rate change (Exhibit A Jan/Feb 2026 ignored, named)', u.issues.some((i) => i.code === 'schedule_before_start' && /2026-01-01/.test(i.text)) && u.rate_at_start_of_year.cents === 1826310);
  check('a 3% CEILING assumes no increase: 2027 = 12 x $18,263.10 = $219,157.20', u.annual_cents === 21915720, String(u.annual_cents));
  check('...and reports the most it could cost if the full 3% is taken from the October anniversary: $220,800.87', u.range_high_cents === 22080087 && u.issues.some((i) => i.code === 'escalator_cap'), String(u.range_high_cents));
  const asFloor = T.contractCostForYear({ ...UPS, escalator_kind: 'max_cpi_or_pct' }, 2027);
  check('the old reading ("greater of CPI or 3%") would have assumed the increase: $220,800.87 as the expected cost', asFloor.annual_cents === 22080087 && asFloor.range_high_cents == null);
  const g = T.contractCostForYear(GS, 2027);
  check('escalation from contract year 4: Jan 2027 $519.75 (one increase, 1/30/2026), Feb-Dec $545.74 (second, 1/30/2027) = $6,522.89', g.annual_cents === 652289 && g.months[0] === 51975 && g.months[1] === 54574, JSON.stringify([g.annual_cents, g.months[0], g.months[1]]));
  const g2 = T.contractCostForYear({ ...GS, escalator_start_year: null }, 2027);
  check('without the start year it compounds from year 2 (the earlier overstatement)', g2.annual_cents > 700000, String(g2.annual_cents));
  const anniv = T.contractCostForYear({ effective_date: '2025-06-15', periodic_amount: 1000, periodic_frequency: 'monthly', escalator_kind: 'fixed_pct', escalator_pct: 10 }, 2026);
  check('anniversaries are day-accurate: an increase dated 6/15 applies from July (month starts after it), not June', anniv.months[5] === 100000 && anniv.months[6] === 110000, JSON.stringify(anniv.months));
}

console.log('review: contracts, vendors, invoices, budget lines');
const accounts = [{ id: 'a5770', account_number: '5770', account_name: 'Security Services', account_type: 'expense' }, { id: 'a5200', account_number: '5200', account_name: 'Landscape Operating & Management', account_type: 'expense' },
  { id: 'a5810', account_number: '5810', account_name: 'Management Fees', account_type: 'expense' }, { id: 'a5450', account_number: '5450', account_name: 'Fences/Walls/Gates', account_type: 'expense' }, { id: 'a5120', account_number: '5120', account_name: 'Water', account_type: 'expense' },
  { id: 'a5300', account_number: '5300', account_name: 'Pool Management Service', account_type: 'expense' }];
const vendors = [{ id: 'v-ups', name: 'United Protective Services' }, { id: 'v-star', name: 'Star Protection Agency LLC' }, { id: 'v-cc', name: 'Community Controls' }, { id: 'v-earth', name: 'Earthcare Management, Inc.' }, { id: 'v-bed', name: 'Bedrock Association Management, LLC' },
  { id: 'v-taw', name: 'Texas Access Works LLC' }, { id: 'v-mud', name: 'CINCO M.U.D. No. 8', is_mud: true }];
let n = 0; const inv = (vendor, date, cents, acct, svcEnd) => ({ id: `i${++n}`, vendor_id: vendor, invoice_date: date, service_period_end: svcEnd || null, total_cents: cents, status: 'paid', lines: [{ gl_account_id: acct, amount_cents: cents - 2075 }, { gl_account_id: acct, amount_cents: 2075 }] });
const invoices = [];
for (let d = new Date('2026-07-11'); d <= new Date('2026-10-03'); d.setDate(d.getDate() + 7)) invoices.push(inv('v-star', new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10), 427743, 'a5770', d.toISOString().slice(0, 10)));
invoices.push(inv('v-cc', '2026-08-13', 74860, 'a5770'), inv('v-cc', '2026-10-01', 74860, 'a5770'));
for (const [d, c] of [['2026-07-01', 776431], ['2026-08-01', 884268], ['2026-09-01', 884268], ['2026-09-30', 959375], ['2026-10-01', 884268]]) invoices.push(inv('v-earth', d, c, 'a5200'));
for (const d of ['2026-08-25', '2026-09-03', '2026-10-01']) invoices.push(inv('v-bed', d, 520000, 'a5810'));
for (const [d, c] of [['2026-07-15', 1500000], ['2026-08-20', 3000000], ['2026-09-10', 411595]]) invoices.push(inv('v-taw', d, c, 'a5450'));
for (const d of ['2026-07-20', '2026-08-20', '2026-09-20']) invoices.push(inv('v-mud', d, 290000, 'a5120'));
const lines = [{ account_id: 'a5770', annual_amount_cents: 22914450 }, { account_id: 'a5200', annual_amount_cents: 10611600 }, { account_id: 'a5810', annual_amount_cents: 6240000 }, { account_id: 'a5300', annual_amount_cents: 5500000 }, { account_id: 'a5120', annual_amount_cents: 3500000 }];
const base = { year: 2027, as_of: '2026-10-14', accounts, vendors, invoices, lines, prior_lines: [], contracts: [UPS, GS] };
{
  const r = R.reviewContracts(base);
  const c = (code, acct) => r.exceptions.filter((e) => e.code === code && (!acct || e.account_id === acct));
  check('weekly vendor whose service ended 3 days into the new contract, quiet since: SUPERSEDED, not carried into 2027', c('vendor_superseded', 'a5770').length === 1 && /Star Protection/.test(c('vendor_superseded')[0].text));
  check('a vendor that simply has not billed yet this cycle (~7 weeks) is NOT concluded replaced', !r.exceptions.some((e) => e.code === 'vendor_superseded' && /Community Controls/.test(e.text)));
  const sec = r.by_account.find((a) => a.account_id === 'a5770');
  check('security expected = contracts $225,680.09 + Community Controls annualized from its cycle (sum of each invoice\'s lines)', sec.contract_cents === 22568009 && sec.continuing_uncontracted[0].annualized_cents === Math.round(74860 * 365 / 49) && sec.expected_cents === 22568009 + Math.round(74860 * 365 / 49), JSON.stringify(sec.continuing_uncontracted));
  check('the draft ($229,144.50) is within 1% of that: no revision proposed', !c('line_vs_contract', 'a5770').length);
  check('contract matched to the vendor record by name, and flagged to link it; Gate Sentry has no vendor record', c('contract_vendor_unlinked').length === 2 && /matches "United Protective Services"/.test(c('contract_vendor_unlinked')[0].text) && /no vendor record matches/.test(c('contract_vendor_unlinked')[1].text));
  check('a contract 13 days in with no invoice yet is NOT flagged (no invoice is overdue)', !c('contract_no_invoices').length);
  const later = R.reviewContracts({ ...base, as_of: '2026-12-01' });
  check('...but 61 days in with no invoice in its account, it is', later.exceptions.some((e) => e.code === 'contract_no_invoices' && /United Protective/.test(e.text)));
  check('a steady monthly charge with no contract (Bedrock $5,200) is a MISSING CONTRACT, never "no obligation"', c('missing_contract', 'a5810').length === 1 && /not evidence there is no obligation/.test(c('missing_contract', 'a5810')[0].text));
  check('irregular project billing (Texas Access Works) is uncontracted spend, not annualized as a recurring obligation', c('uncontracted_spend', 'a5450').length === 1 && !c('missing_contract', 'a5450').length);
  check('a material draft line with no contract (pool $55,000) is flagged for Amanda even with little billing history', c('material_line_no_contract', 'a5300').length === 1 && c('material_line_no_contract', 'a5300')[0].owner === 'amanda');
  check('one finding per account (landscape: the line finding, not a duplicate spend finding)', r.exceptions.filter((e) => e.account_id === 'a5200' && ['missing_contract', 'material_line_no_contract', 'uncontracted_spend'].includes(e.code)).length === 1);
  check('a MUD (tariff, no contract expected) is not reported as missing a contract', !r.exceptions.some((e) => e.account_id === 'a5120' && e.code === 'missing_contract'));
  check('unverified contract terms go to Kat', c('contract_unverified').length === 2 && c('contract_unverified').every((e) => e.owner === 'kat'));
  check('every exception has an owner and an action', r.exceptions.every((e) => ['kat', 'emma', 'amanda'].includes(e.owner) && e.action));
}
{
  const over = R.reviewContracts({ ...base, lines: [{ account_id: 'a5770', annual_amount_cents: 24000000 }] });
  const e = over.exceptions.find((x) => x.code === 'line_vs_contract');
  check('a draft line off the contracts by more than tolerance: a proposed revision (a decision), with the arithmetic', e && e.decision && e.proposed_cents === over.by_account.find((a) => a.account_id === 'a5770').expected_cents && /plus \$[\d,.]+ of continuing uncontracted billing \(Community Controls\)/.test(e.text), e && e.text);
  const exp = R.reviewContracts({ ...base, contracts: [...base.contracts, { id: 'old', vendor_name_raw: 'Old Patrol Co', effective_date: '2024-01-01', end_date: '2026-06-30', auto_renews: false, periodic_amount: 1000, periodic_frequency: 'monthly', forecast_account_id: 'a5770' }] });
  check('an expired agreement that does not auto-renew is a decision', exp.exceptions.some((x) => x.code === 'contract_expired' && x.decision));
  const dup = R.reviewContracts({ ...base, contracts: [...base.contracts, { ...GS, id: 'gs2' }] });
  check('two contracts for the same vendor on the same account are flagged (counted twice)', dup.exceptions.some((x) => x.code === 'contract_duplicate'));
  // Found on Canyon Gate's real folder (2026-10-14): a contract the engine cannot price month by month
  // (Aegis: a seasonal payment schedule; mosquito control: per visit) had been read as $0 and proposed
  // cutting the $55,000 pool line to $0.
  const AEGIS = { id: 'aeg', vendor_name_raw: 'Aegis Aquatics, LLC', effective_date: '2026-02-01', end_date: '2027-02-28', auto_renews: true, periodic_amount: null, periodic_frequency: null, rate_schedule: [], total_amount: 50350, annualized_amount: 50350, unit_pricing: [{ unit: 'lifeguard hour', rate: 25 }], forecast_account_id: 'a5300', escalator_kind: 'fixed_pct', escalator_pct: 5 };
  const pool = R.reviewContracts({ ...base, contracts: [...base.contracts, AEGIS] });
  const pa = pool.by_account.find((a) => a.account_id === 'a5300');
  check('an uncostable contract is NEVER read as $0: no line revision proposed, expected left blank', !pool.exceptions.some((e) => e.code === 'line_vs_contract' && e.account_id === 'a5300') && pa.expected_cents === null);
  check('...it is named for Kat with the document\'s own annual figure', pool.exceptions.some((e) => e.code === 'pricing_uncostable' && /\$50,350\.00/.test(e.text) && e.owner === 'kat'));
  const COX = { id: 'cox', vendor_name_raw: 'Cox CPA Services, Inc.', effective_date: '2025-01-01', end_date: '2026-12-31', auto_renews: false, one_time_fees: [{ date: '2025-12-31', amount: 5095 }, { date: '2027-01-01', amount: 5095, description: 'FY2026 audit' }, { date: '2027-01-01', amount: 375, description: 'FY2026 tax' }], forecast_account_id: 'a5810' };
  const cx = R.reviewContracts({ ...base, contracts: [COX] });
  check('a fee-only engagement whose fees fall in the year: priced from its fees, not "expired", no uncovered-month noise', cx.contracts[0].annual_cents === 547000 && !cx.exceptions.some((e) => ['contract_expired', 'pricing_uncovered_months', 'pricing_no_periodic_amount'].includes(e.code)), JSON.stringify(cx.exceptions.map((e) => e.code)));
  const TXU = { id: 'txu', vendor_name_raw: 'TXU Energy Retail Company LLC', status: 'expired', effective_date: '2024-12-01', end_date: '2025-11-30', auto_renews: false };
  const tx = R.reviewContracts({ ...base, contracts: [...base.contracts, TXU] });
  check('a contract recorded expired before the year is history: listed, not priced, no exceptions', tx.history.some((h) => h.id === 'txu') && !tx.contracts.some((c) => c.id === 'txu') && !tx.exceptions.some((e) => /TXU/.test(e.text)));
  check('a MUD-billed material line is not "missing a contract" (tariff, not agreement)', !R.reviewContracts(base).exceptions.some((e) => e.code === 'material_line_no_contract' && e.account_id === 'a5120'));
  const NEWS = { id: 'news', vendor_name_raw: 'My Neighborhood News, LLC', effective_date: '2026-05-20', end_date: '2027-05-21', auto_renews: true, total_amount: 0, annualized_amount: 0, unit_pricing: [{ unit: 'ad', rate: 100 }] };
  const nw = R.reviewContracts({ ...base, contracts: [...base.contracts, NEWS] });
  check('an agreement at no cost to the association (revenue-share newsletter) raises no pricing, binding or vendor findings', !nw.exceptions.some((e) => /Neighborhood News/.test(e.text) && e.code !== 'contract_unverified'));
  check('a seasonal schedule contract is described as a payment schedule, not per-unit pricing', /payment schedule rather than a rate/.test(pool.exceptions.find((e) => e.code === 'pricing_uncostable').text));
  check('vendor names normalize (L.P., LLC, Inc., "of South Texas")', R.normName('United Protective Services of South Texas, L.P.') === R.normName('United Protective Services'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
