// tests/test_builder_positions.js  (GitHub #96)
// Builder assessment positions at the Still Creek conversion baseline (6/30/2026)
// and the 2205 release schedule, on Still Creek's real shape: 321 lots billed
// $495 on 1/1, Lennar holding 24 (5302 billed $495, 5450 billed $90.18 on 5/13,
// 22 never billed), 2205 at $79,449.50 on the source TB.
const { buildBuilderPositions } = require('../lib/onboarding/builder_positions');

let pass = 0; let fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } };

const accounts = { 1300: { id: 'a1300', account_number: '1300', fund_id: 'op' }, 4000: { id: 'a4000', account_number: '4000', fund_id: 'op' }, 2205: { id: 'a2205', account_number: '2205', fund_id: 'op' } };
const resolveAcct = (n) => accounts[n] || null;
const LENNAR = 'lennar-co';

function world({ tb2205 = 7944950, extraLennar = [], cutoff = '2026-06-30', ownersOverride } = {}) {
  const properties = []; const tenures = []; const owners = []; const rows = [];
  const lot = (i, addr, name, opts = {}) => {
    const id = `p${i}`; properties.push({ id, vantaca_account_id: `V${i}`, trusted_account_number: `T${i}`, street_address: addr });
    tenures.push({ id: `t${i}`, property_id: id, kind: 'owner', start_date: opts.start || '2026-05-21', end_date: null, origin: opts.origin || 'backfill_current' });
    owners.push({ tenure_id: `t${i}`, full_name: name });
    for (const r of opts.rows || []) rows.push({ id: `h${i}-${r.date}`, property_id: id, tenure_id: null, vantaca_account_id: `V${i}`, transaction_date: r.date, description: r.desc, txn_type: r.type || 'charge', charge_category: r.cat === undefined ? 'assessment' : r.cat, amount_cents: r.cents });
  };
  const annual = { date: '2026-01-01', desc: 'Annual Assessment', cents: 49500 };
  for (let i = 0; i < 320; i++) lot(i, `${1000 + i} Homeowner Ln`, `Owner ${i}`, { rows: [annual] });
  lot(900, '5302 Sleepy Fox', 'Lennar Homes of Texas Land and Construction, Ltd.', { rows: [annual, { date: '2026-02-01', desc: 'Late Interest', cents: 825, cat: 'interest' }] });
  lot(901, '5450 Still Meadow', 'Lennar Homes of Texas Land and Construction, Ltd.', { rows: [{ date: '2026-05-13', desc: 'Assessment', cents: 9018 }] });
  for (let i = 0; i < 22; i++) lot(910 + i, `${8000 + i} Rustic Pine Trail`, 'Lennar Homes of Texas Land and Construction, Ltd.');
  for (const e of extraLennar) lot(e.i, e.addr, e.name || 'Lennar Homes of Texas Land and Construction, Ltd.', e);
  return {
    cutoff, cutover: cutoff === '2026-06-30' ? '2026-07-01' : null, code: 'CONV-SCR-20260630', properties, tenures, resolveAcct,
    tbOf: (a) => (a === '2205' ? -tb2205 : 0),
    builder: { builders: [{ id: LENNAR, company_name: 'Lennar' }], owners: ownersOverride ? ownersOverride(owners) : owners,
      rates: { homeowner: { id: 'rh', annual_amount_cents: 49500, income_account_number: '4000', deferral_account_number: '2205' }, builder: { id: 'rb', pct_of_homeowner_rate: 50, annual_amount_cents: null } },
      legacy_rows: rows, annual_rows: rows },
  };
}

console.log('builder positions at the Still Creek baseline');
const out = buildBuilderPositions(world());
const byAddr = (a) => out.rows.find((r) => r.street_address === a);
check('applies; 23 resolved builder lots (5302 + 22 unbilled), 5450 unresolved', out.applies && out.rows.length === 23 && out.unresolved.length === 1 && out.unresolved[0].street_address === '5450 Still Meadow', JSON.stringify(out.unresolved));
const s = byAddr('5302 Sleepy Fox');
check('5302: normalization, Jan 1 - Jun 30, 181/365 days, base $122.73, ledger -$372.27, recognized $247.50, deferred $247.50',
  s && s.kind === 'normalization' && s.covered_from === '2026-01-01' && s.covered_through === '2026-06-30' && s.days === 181 && s.days_in_year === 365
    && s.base_amount_cents === 12273 && s.ledger_amount_cents === -37227 && s.txn_type === 'adjustment' && s.recognized_cents === 24750 && s.deferred_cents === 24750, JSON.stringify(s));
check('5302: late interest is not assessment activity (one identified annual row)', s && s.legacy_evidence && s.legacy_evidence.amount_cents === 49500);
const u = byAddr('8000 Rustic Pine Trail');
check('unbilled lot: baseline, base $122.73 charge, no fabricated $495', u && u.kind === 'baseline' && u.base_amount_cents === 12273 && u.ledger_amount_cents === 12273 && u.txn_type === 'charge' && u.annual_billed_cents === null);
check('never the 5/21 load date as Lennar’s start', out.rows.every((r) => r.covered_from === '2026-01-01'));
const lines = out.je.lines; const sum = (acct, side) => lines.filter((l) => l.account_number === acct).reduce((t, l) => t + l[side], 0);
check('entry: cutover-dated, CONV-SCR-20260630-BUILDER, balanced', out.je.reference === 'CONV-SCR-20260630-BUILDER' && out.je.posting_date === '2026-07-01' && out.je.total_debits_cents === out.je.total_credits_cents);
const s5302 = lines.filter((l) => /5302/.test(l.memo));
check('5302 lines: Dr 4000 $124.77, Dr 2205 $247.50, Cr 1300 $372.27',
  JSON.stringify(s5302.map((l) => [l.account_number, l.debit_cents, l.credit_cents])) === JSON.stringify([['4000', 12477, 0], ['2205', 24750, 0], ['1300', 0, 37227]]), JSON.stringify(s5302));
check('22 unbilled lots: Dr 1300 / Cr 4000 $122.73 each = $2,700.06', sum('1300', 'debit_cents') === 22 * 12273 && sum('4000', 'credit_cents') === 22 * 12273);
check('schedule: 2205 -> 4000, $79,200.00 over 6 months from 2026-07-01 ($13,200.00/mo)',
  out.schedule && out.schedule.recognize_amount_cents === 7920000 && out.schedule.term_months === 6 && out.schedule.start_month === '2026-07-01' && out.schedule.monthly_amount_cents === 1320000
    && out.schedule.basis.billed_lots === 321 && out.schedule.basis.remaining_cents === 7944750, JSON.stringify(out.schedule && out.schedule.basis));
const ri = out.reconciling_items;
check('reconciling items: $2.00 2205 residue + 5450 unresolved ($90.18), nothing folded into the schedule',
  ri.length === 2 && ri.some((r) => r.kind === 'deferral_residue' && r.item_key === '2205' && r.amount_cents === 200) && ri.some((r) => r.kind === 'builder_position_unresolved' && r.item_key === 'p901' && r.amount_cents === 9018), JSON.stringify(ri));
const ctl = (c) => out.controls.find((x) => x.code === c);
check('controls: entry balances (PASS); positions unresolved (FAIL, waivable); deferral residue (FAIL, waivable)',
  !ctl('preflight.builder_entry_balances').failures.length && ctl('preflight.builder_entry_balances').blocked
    && ctl('preflight.builder_positions_resolved').failures.length === 1 && !ctl('preflight.builder_positions_resolved').blocked
    && ctl('preflight.deferral_schedule_reconciles').failures.length === 1 && !ctl('preflight.deferral_schedule_reconciles').blocked);

console.log('edges');
const clean = buildBuilderPositions(world({ tb2205: 7944750 - 0 }));
check('2205 exactly the schedule + the lot deferral: no residue item, control PASS',
  !clean.reconciling_items.some((r) => r.kind === 'deferral_residue') && !clean.controls.find((x) => x.code === 'preflight.deferral_schedule_reconciles').failures.length);
const late = buildBuilderPositions(world({ extraLennar: [{ i: 950, addr: '1 Late Ln', origin: 'transfer', start: '2026-03-15' }, { i: 951, addr: '2 After Ln', origin: 'transfer', start: '2026-08-01' }] }));
const l1 = late.rows.find((r) => r.street_address === '1 Late Ln');
check('a recorded transfer to the builder mid-year starts its coverage that day (3/15 - 6/30, 108 days, $73.23)', l1 && l1.covered_from === '2026-03-15' && l1.days === 108 && l1.base_amount_cents === 7323, JSON.stringify(l1));
check('a builder whose year starts after the baseline gets no conversion coverage (the accrual starts it)', !late.rows.some((r) => r.street_address === '2 After Ln') && !late.unresolved.some((r) => r.street_address === '2 After Ln'));
const mixed = buildBuilderPositions(world({ ownersOverride: (o) => [...o, { tenure_id: 't910', full_name: 'Jane Buyer' }] }));
check('a lot whose owner record mixes the builder with another owner is unresolved, never guessed', mixed.unresolved.some((u) => u.street_address === '8000 Rustic Pine Trail' && /mixes/.test(u.reason)));
const none = buildBuilderPositions({ ...world(), builder: null });
check('a community with no builder rule: nothing applies', !none.applies && !none.rows.length && !none.controls.length);
const word = buildBuilderPositions(world({ ownersOverride: (o) => o.map((x) => (x.tenure_id === 't0' ? { ...x, full_name: 'Glennaro Smith' } : x)) }));
check('whole-word match: "Glennaro" is not Lennar', !word.rows.some((r) => r.property_id === 'p0'));
const leap = world({ cutoff: '2028-06-30' }); leap.cutover = '2028-07-01';
for (const r of leap.builder.legacy_rows) r.transaction_date = r.transaction_date.replace('2026', '2028');
const lp = buildBuilderPositions(leap).rows.find((r) => r.street_address === '8000 Rustic Pine Trail');
check('leap year: Jan 1 - Jun 30, 2028 = 182/366 = $123.07', lp && lp.days === 182 && lp.days_in_year === 366 && lp.base_amount_cents === 12307, JSON.stringify(lp));
const half = buildBuilderPositions({ ...world(), builder: { ...world().builder, rates: { homeowner: { annual_amount_cents: 73000, income_account_number: '4000', deferral_account_number: null }, builder: { pct_of_homeowner_rate: 50 } } } });
check('a different annual rate prorates on the configured rate ($730 x 50% x 181/365 = $181.00)', half.rows.find((r) => r.street_address === '8000 Rustic Pine Trail').base_amount_cents === 18100);
check('no deferral account: no schedule; a legacy charge that is neither the annual nor the builder amount ($495 vs $730) is unresolved, not normalized',
  !half.schedule && !half.rows.some((r) => r.street_address === '5302 Sleepy Fox') && half.unresolved.some((u) => u.street_address === '5302 Sleepy Fox'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
