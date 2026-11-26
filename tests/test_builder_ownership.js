// ============================================================================
// tests/test_builder_ownership.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// The builder pays for its ACTUAL ownership period, split by assessment year at
// each year's rate (lib/accounting/builder_ownership.js), and a scanned closing
// packet gets a next action Amanda tracks (lib/home_sales/closing_packets.js).
// Invented values only.
// ============================================================================
const assert = require('assert');
const BO = require('../lib/accounting/builder_ownership');
const CP = require('../lib/home_sales/closing_packets');
const { KINDS } = require('../lib/manager/subjects');

const tests = []; const check = (n, fn) => tests.push([n, fn]);

check('one period per assessment year, each at that year\'s rate, through the day before settlement', () => {
  const s = BO.ownershipSchedule({ acquisitionDate: '2030-11-15', settlementDate: '2031-03-01', builderPct: 50, rates: { 2030: 60000, 2031: 66000 } });
  assert.deepStrictEqual(s.periods.map((p) => [p.fiscal_year, p.from, p.through, p.days, p.days_in_year, p.cents]), [
    [2030, '2030-11-15', '2030-12-31', 47, 365, 3863],   // 60000 x 50 x 47 / 36500 = 3863.0
    [2031, '2031-01-01', '2031-02-28', 59, 365, 5334],   // 66000 x 50 x 59 / 36500 = 5334.2
  ]);
  assert.strictEqual(s.total_cents, 3863 + 5334);
  assert.deepStrictEqual(s.gaps, []);
  assert.strictEqual(s.periods[1].formula, '660.00 x 50% x 59/365');
});

check('a leap year uses 366 days', () => {
  const s = BO.ownershipSchedule({ acquisitionDate: '2032-01-01', settlementDate: '2032-03-01', builderPct: 50, rates: { 2032: 73200 } });
  assert.deepStrictEqual([s.periods[0].days, s.periods[0].days_in_year, s.periods[0].cents], [60, 366, 6000]);
});

check('a year with no rate on file is a gap, never a guess', () => {
  const s = BO.ownershipSchedule({ acquisitionDate: '2030-12-01', settlementDate: '2031-02-01', builderPct: 50, rates: { 2031: 60000 } });
  assert.deepStrictEqual(s.gaps, ['assessment_rate_unknown_2030']);
  assert.strictEqual(s.periods[0].cents, null);
});

check('no acquisition date: held, nothing computed', () => {
  assert.deepStrictEqual(BO.ownershipSchedule({ acquisitionDate: null, settlementDate: '2031-02-01', builderPct: 50 }).gaps, ['builder_acquisition_date_unknown']);
});

check('settlement on the acquisition day: the builder owes nothing', () => {
  assert.deepStrictEqual(BO.ownershipSchedule({ acquisitionDate: '2031-02-01', settlementDate: '2031-02-01', builderPct: 50, rates: { 2031: 1 } }).periods, []);
});

const PLAN = { applies: true, fiscal_year: 2031, settlement_date: '2031-07-01', builder_rate_pct: 50, annual_assessment_cents: 60000, days_in_year: 365, builder_period_start: '2031-01-01', builder_period_end: '2031-06-30' };

check('review: ownership from the year start, rate on file, no packet: nothing held', () => {
  const r = BO.reviewPlan({ plan: PLAN, acquisitionDate: '2031-01-01', acquisitionBasis: 'transfer', rates: { 2031: 60000 } });
  assert.deepStrictEqual(r.holds, []);
  assert.strictEqual(r.settlement_year_cents, 14877);   // 181 days: 60000 x 50 x 181 / 36500 = 14876.7
});

check('review: earlier-year days and a county-roll date hold with a warning', () => {
  const r = BO.reviewPlan({ plan: PLAN, acquisitionDate: '2030-12-08', acquisitionBasis: 'county_deed', rates: { 2030: 60000, 2031: 60000 } });
  assert.deepStrictEqual(r.holds, ['prior_year_builder_days']);
  assert.strictEqual(r.prior_year_cents, 1973);   // 24 days: 60000 x 50 x 24 / 36500 = 1972.6
  assert.ok(r.warnings[0].includes('confirm it against the recorded deed'));
  assert.ok(r.flags.some((f) => f.kind === 'developer_period' && f.from === '2030-01-01' && f.through === '2030-12-07'));
});

check('packet next action: checks with void dates, lot, Kat reconciliation, escalation a week before the first void', () => {
  const n = { kind: 'closing_packet', property_id: 'p1', closing_date: '2031-09-22', checks: [
    { check_number: '1', amount_cents: 99000, check_date: '2031-09-22', payee: 'Example HOA', classification: 'ASSOCIATION_PAYMENT' },
    { check_number: '2', amount_cents: 35000, check_date: '2031-09-16', payee: 'Bedrock Association Management', classification: 'BEDROCK_FEE' }] };
  const a = CP.packetNextAction(n, { today: '2031-11-26' });
  assert.ok(a.next_action.startsWith('Reese: confirm the original checks'));
  assert.ok(a.next_action.includes('#2 $350.00 to Bedrock Association Management, void 2031-12-15'));
  assert.ok(a.next_action.includes('Kat reconciles'));
  assert.ok(a.next_action.includes('settlement date 2031-09-22'));
  assert.strictEqual(a.first_void, '2031-12-15');
  assert.strictEqual(a.next_action_due, '2031-12-08T14:00:00Z');
  assert.strictEqual(a.priority, 'high');
  assert.ok(CP.packetNextAction({ ...n, property_id: null }, { today: '2031-11-26' }).next_action.includes('match the packet to its lot'));
  assert.strictEqual(CP.packetNextAction(n, { recorded: true }).done, true);
});

check('Amanda tracks an unrecorded packet (REVIEW, Reese acts) and resolves it once a closing points at it', () => {
  assert.ok(KINDS.closing_packet && KINDS.closing_packet.load && KINDS.closing_packet.evaluate);
  const row = { id: 'doc-1', community_id: 'c1', recorded: false, today: '2031-11-26', notes: { kind: 'closing_packet', property_id: 'p1', property_address: '100 Example Lane', closing_date: '2031-09-22', checks: [] } };
  const c = CP.evaluatePacket(row);
  assert.deepStrictEqual([c.action, c.autonomy_class, c.objective_type, c.domain, c.owner_key], ['track', 'REVIEW', 'resale', 'ops', 'home_sales.closing_packet']);
  assert.ok(c.title.includes('100 Example Lane (settled 2031-09-22)'));
  assert.deepStrictEqual([CP.evaluatePacket({ ...row, recorded: true }).action, CP.evaluatePacket({ ...row, recorded: true }).outcome], ['clear', 'resolved']);
});

(async () => {
  let fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  }
  console.log(`\n${tests.length - fail}/${tests.length} builder ownership tests passed`);
  process.exit(fail ? 1 : 0);
})();
