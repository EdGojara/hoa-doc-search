// =============================================================================
// tests/test_prepaid_amortization.js — set up a prepaid_expense schedule from a bill
// =============================================================================
// Ed 2026-09-03 (Celina, LOPF Harned insurance ACH): a bill coded to 1400 Prepaid
// Insurance must amortize to expense over the policy term. This proves the schedule
// is built with the right shape (prepaid_expense: Dr expense / Cr prepaid), the
// month math handles a 9/1->9/1 policy as 12 months, and non-prepaid bills are
// rejected. Uses a tiny mock supabase (no DB).
//
// Run: node tests/test_prepaid_amortization.js   (wired into npm test)
// =============================================================================
const assert = require('assert');
const { setupPrepaidAmortization, monthsInclusive, isPrepaidAccount } = require('../lib/accounting/prepaid_amortization');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  PASS  ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}`); console.log(`        ${e.message}`); } }

// mock supabase capturing inserts; dedup select returns null (no existing).
function mockSb(captures) {
  const insertResult = (table) => ({
    select: () => ({ single: async () => ({ data: { id: 'sch_1' }, error: null }) }),
    then: (resolve) => resolve({ error: null }),
  });
  const q = (table) => {
    const o = { _t: table };
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) o[m] = () => o;
    o.maybeSingle = async () => {
      if (table === 'chart_of_accounts') return { data: { account_number: captures.expNum }, error: null };
      return { data: null, error: null }; // recognition_schedules dedup: none
    };
    o.insert = (payload) => { (captures.inserts[table] = captures.inserts[table] || []).push(payload); return insertResult(table); };
    return o;
  };
  return { from: q };
}

(async () => {
  await check('monthsInclusive treats a 9/1->9/1 policy as 12 months', () => {
    assert.strictEqual(monthsInclusive('2026-09-01', '2027-09-01'), 12);
    assert.strictEqual(monthsInclusive('2026-09-01', '2027-08-31'), 12);
    assert.strictEqual(monthsInclusive('2026-01-01', '2026-12-31'), 12);
  });

  await check('isPrepaidAccount recognizes prepaid assets, not expenses', () => {
    assert.ok(isPrepaidAccount({ account_name: 'Prepaid Insurance', account_type: 'asset' }));
    assert.ok(isPrepaidAccount({ account_name: 'Insurance', account_type: 'asset' }));
    assert.ok(!isPrepaidAccount({ account_name: 'Insurance Expense', account_type: 'expense' }));
    assert.ok(!isPrepaidAccount({ account_name: 'Operating Cash', account_type: 'asset' }));
  });

  await check('sets up a prepaid_expense schedule with the right shape', async () => {
    const captures = { expNum: '5600', inserts: {} };
    const sb = mockSb(captures);
    const invoice = { community_id: 'c1', total_cents: 1224200, vendor_invoice_number: 'HARNED-1',
      coded_account: { account_number: '1400', account_name: 'Prepaid Insurance', account_type: 'asset' } };
    const r = await setupPrepaidAmortization({ supabase: sb, invoice, expenseAccountNumber: '5600', periodStart: '2026-09-01', periodEnd: '2027-09-01' });
    assert.strictEqual(r.existing, false);
    assert.strictEqual(r.term_months, 12);
    assert.strictEqual(r.monthly_amount_cents, Math.round(1224200 / 12));

    const sch = captures.inserts['recognition_schedules'][0];
    assert.strictEqual(sch.schedule_type, 'prepaid_expense', 'prepaid_expense direction');
    assert.strictEqual(sch.balance_account_number, '1400', 'credits the prepaid asset');
    assert.strictEqual(sch.recognize_amount_cents, 1224200);
    assert.strictEqual(sch.start_month, '2026-09-01');
    assert.strictEqual(sch.term_months, 12);
    assert.strictEqual(sch.status, 'active');

    const seg = captures.inserts['recognition_schedule_segments'][0][0];
    assert.strictEqual(seg.income_account_number, '5600', 'debits the expense account');
  });

  await check('rejects a bill not coded to a prepaid account', async () => {
    const sb = mockSb({ expNum: '5600', inserts: {} });
    const invoice = { community_id: 'c1', total_cents: 1000, coded_account: { account_number: '6000', account_name: 'Repairs', account_type: 'expense' } };
    await assert.rejects(setupPrepaidAmortization({ supabase: sb, invoice, expenseAccountNumber: '5600', periodStart: '2026-09-01', periodEnd: '2027-09-01' }), /not a prepaid/i);
  });

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll prepaid-amortization checks passed.');
})();
