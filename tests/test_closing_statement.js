// ============================================================================
// tests/test_closing_statement.js  (Ed 2026-11-26)
// ----------------------------------------------------------------------------
// The closing statement (lib/accounting/closing_statement.js): due from seller,
// due from buyer, capitalization fee, other fees and the total, shown
// separately at a builder-to-homeowner closing. Invented values only.
// ============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CS = require('../lib/accounting/closing_statement');

const tests = []; const check = (n, fn) => tests.push([n, fn]);

// An invented plan in transfer_proration_plan's shape: annual $600.00, builder
// 50%, settlement 2031-10-01 (non-leap year, 365 days). Builder billed by the
// conversion through 2031-06-30; unbilled 2031-07-01..2031-09-30 = 92 days.
const plan = {
  applies: true, blocked: false, builder: 'Example Homes', builder_rate_pct: 50, homeowner_rate_pct: 100,
  annual_assessment_cents: 60000, days_in_year: 365, settlement_date: '2031-10-01',
  builder_period_start: '2031-01-01', builder_period_end: '2031-09-30', builder_days: 273,
  builder_unbilled_period: { start: '2031-07-01', end: '2031-09-30', days: 92 },
  builder_prior_billed_cents: 14877, builder_due_cents: 22439,
  builder_adjustment_cents: 7562,                     // round(60000 * 50 * 92 / 36500) = 7561.6 -> 7562
  homeowner_period_start: '2031-10-01', homeowner_period_end: '2031-12-31', homeowner_days: 92,
  homeowner_due_cents: 15123,                         // round(60000 * 92 / 365) = 15123.3 -> 15123
};
const cap100 = CS.capitalizationFee({ annual_amount_cents: 60000, capitalization_fee_pct: 100, capitalization_fee_evidence: 'Declaration, Capitalization Fee' });

check('capitalization fee is the full annual assessment at 100%, never prorated, paid by the buyer', () => {
  assert.strictEqual(cap100.configured, true);
  assert.strictEqual(cap100.amount_cents, 60000);
  assert.strictEqual(cap100.prorated, false);
  assert.strictEqual(cap100.payable_by, 'buyer');
  assert.strictEqual(CS.capitalizationFee({ annual_amount_cents: 60000, capitalization_fee_pct: 50 }).amount_cents, 30000);
});

check('capitalization fee not configured is a gap, never $0', () => {
  const c = CS.capitalizationFee({ annual_amount_cents: 60000, capitalization_fee_pct: null });
  assert.strictEqual(c.configured, false);
  assert.strictEqual(c.reason, 'capitalization_fee_not_configured');
  const st = CS.buildClosingStatement({ plan, seller: { balance_status: 'KNOWN', balance_cents: 14877 }, capitalization: c });
  assert.strictEqual(st.complete, false);
  assert.ok(st.gaps.includes('capitalization_fee_not_configured'));
  assert.strictEqual(st.capitalization_fee.cents, null);
  assert.strictEqual(st.total_due_at_closing_cents, null);
  assert.strictEqual(CS.capitalizationFee(null).configured, false);
});

check('seller owes its unpaid balance plus the builder charge for its unbilled days; nothing counted twice', () => {
  // The conversion's builder charge (14877) is still unpaid on the seller account.
  const st = CS.buildClosingStatement({ plan, seller: { balance_status: 'KNOWN', balance_cents: 14877 }, capitalization: cap100 });
  assert.strictEqual(st.due_from_seller.cents, 14877 + 7562);
  assert.strictEqual(st.due_from_seller.cents, plan.builder_due_cents, 'unpaid prior billing + new charge = the builder share for the year');
  assert.deepStrictEqual(st.due_from_seller.lines.map((l) => l.key), ['seller_open_balance', 'builder_proration']);
  assert.strictEqual(st.due_from_seller.lines[1].days, 92);
});

check('a seller that already paid its billed share owes only the new days', () => {
  const st = CS.buildClosingStatement({ plan, seller: { balance_status: 'KNOWN', balance_cents: 0 }, capitalization: cap100 });
  assert.strictEqual(st.due_from_seller.cents, 7562);
});

check('buyer owes the prorated assessment; capitalization fee is separate; total ties', () => {
  const st = CS.buildClosingStatement({ plan, seller: { balance_status: 'KNOWN', balance_cents: 14877 }, capitalization: cap100,
    otherFees: [{ label: 'Management company transfer fee', amount_cents: 20000, payable_by: 'buyer', payable_to: 'management_company' }] });
  assert.strictEqual(st.complete, true);
  assert.strictEqual(st.due_from_buyer.cents, 15123);
  assert.strictEqual(st.capitalization_fee.cents, 60000);
  assert.strictEqual(st.other_fees.length, 1);
  assert.strictEqual(st.payable_to_association_cents, 22439 + 15123 + 60000);
  assert.strictEqual(st.payable_to_management_company_cents, 20000);
  assert.strictEqual(st.total_due_at_closing_cents, 22439 + 15123 + 60000 + 20000);
});

check('an unknown seller balance makes the statement incomplete (never read as $0)', () => {
  const st = CS.buildClosingStatement({ plan, seller: { balance_status: 'UNKNOWN', balance_cents: null }, capitalization: cap100 });
  assert.strictEqual(st.complete, false);
  assert.ok(st.gaps.includes('seller_balance_unknown'));
  assert.strictEqual(st.due_from_seller.cents, null);
  assert.strictEqual(st.payable_to_association_cents, null);
});

check('a blocked proration makes the statement incomplete', () => {
  const st = CS.buildClosingStatement({ plan: { ...plan, blocked: true }, seller: { balance_status: 'KNOWN', balance_cents: 0 }, capitalization: cap100 });
  assert.strictEqual(st.complete, false);
  assert.ok(st.gaps.includes('assessment_proration_blocked'));
});

check('a sale with no builder proration still shows the seller balance and the capitalization fee', () => {
  const st = CS.buildClosingStatement({ plan: { applies: false, reason: 'seller_not_builder' }, seller: { balance_status: 'KNOWN', balance_cents: 0 }, capitalization: cap100 });
  assert.strictEqual(st.complete, true);
  assert.strictEqual(st.due_from_seller.cents, 0);
  assert.strictEqual(st.due_from_buyer.cents, 0);
  assert.strictEqual(st.total_due_at_closing_cents, 60000);
});

check('fees with no amount are dropped; payee defaults to the Association', () => {
  const st = CS.buildClosingStatement({ plan, seller: { balance_status: 'KNOWN', balance_cents: 0 }, capitalization: cap100,
    otherFees: [{ label: 'Blank', amount_cents: null }, { label: 'Zero', amount_cents: 0 }, { label: 'Admin transfer fee', amount_cents: 5000 }] });
  assert.deepStrictEqual(st.other_fees.map((f) => [f.label, f.payable_to]), [['Admin transfer fee', 'association']]);
  assert.strictEqual(st.payable_to_association_cents, 7562 + 15123 + 60000 + 5000);
});

check('loadCapitalization degrades before migration 581 (columns missing) to not configured', async () => {
  let n = 0;
  const db = { from: () => { n++; const q = { select: () => q, eq: () => q, maybeSingle: async () => (n === 1
    ? { data: null, error: { message: 'column community_assessment_rates.capitalization_fee_pct does not exist' } }
    : { data: { annual_amount_cents: 60000 }, error: null }) }; return q; } };
  const c = await CS.loadCapitalization(db, 'c1');
  assert.strictEqual(c.configured, false);
  assert.strictEqual(c.reason, 'capitalization_fee_not_configured');
});

check('loadCapitalization throws on any other read error (a broken query is not "no fee")', async () => {
  const db = { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: 'permission denied' } }) }; return q; } };
  await assert.rejects(() => CS.loadCapitalization(db, 'c1'), /permission denied/);
});

check('wiring: the closing confirmation and the preview carry the statement; the screen renders it', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'home_sales.js'), 'utf8');
  assert.ok(/prorationGate\.body\.closing_statement = await closingStatementFor\(/.test(api), 'record-closing 409 carries the closing statement');
  assert.ok(/res\.json\(\{ proration, closing_statement \}\)/.test(api), 'proration-preview returns the closing statement');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'transfer-proration.js'), 'utf8');
  assert.ok(/breakdown\(p\) \+ statementHtml\(body\.closing_statement\)/.test(ui), 'confirm panel renders the statement');
  for (const label of ['Due from seller', 'Due from buyer', 'Capitalization fee', 'Other fees', 'Total due at closing']) assert.ok(ui.includes(label), label);
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', '581_capitalization_fee.sql'), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS capitalization_fee_pct/.test(mig));
});

check('render: the statement HTML shows each section and flags an incomplete statement', () => {
  global.window = {};
  require('../public/transfer-proration.js');
  const TPui = global.window.TransferProration;
  const st = { ...CS.buildClosingStatement({ plan, seller: { balance_status: 'KNOWN', balance_cents: 14877 }, capitalization: cap100 }), seller_name: 'Example Homes LLC' };
  const html = TPui.statementHtml(st);
  assert.ok(html.includes('$600.00') && html.includes('$224.39') && html.includes('$151.23'));
  assert.ok(!html.includes('Incomplete'));
  const bad = TPui.statementHtml({ ...st, complete: false, gaps: ['seller_balance_unknown'], gap_text: ['the seller balance is not known'] });
  assert.ok(bad.includes('Incomplete, do not release a settlement figure'));
});

(async () => {
  let fail = 0;
  for (const [n, fn] of tests) {
    try { await fn(); console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); }
  }
  console.log(`\n${tests.length - fail}/${tests.length} closing statement tests passed`);
  process.exit(fail ? 1 : 0);
})();
