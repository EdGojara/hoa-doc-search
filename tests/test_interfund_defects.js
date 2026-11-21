// Regression tests for three interfund defects (Ed 2026-10-11):
//   1. A void's reversal lines must keep each original line's fund.
//   2. interfundBalances counts only entries that count in the GL, reads every
//      line (past the 1,000-row cap), and throws on a failed read.
//   3. A transfer never uses an interfund receivable/payable as its cash account.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
const assert = require('assert');
const { buildReversalLines } = require('../lib/accounting/posting');
const { computeBridge, buildTransferLines, interfundBalances, isInterfundAccount } = require('../lib/accounting/interfund');

let failures = 0;
const tests = [];
function check(name, fn) { tests.push([name, fn]); }

// ---------------------------------------------------------------- fixtures
const CID = 'c1';
const resolved = {
  oprFundId: 'OPR',
  map: { ADO: { fundDueTo: 'ado-2815', fundDueFrom: 'ado-1815', oprDueFrom: 'opr-1810', oprDueTo: 'opr-2810' } },
};
const netByFund = (lines, fundOf) => {
  const n = {};
  for (const l of lines) { const f = fundOf(l); n[f] = (n[f] || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0); }
  return n;
};

// Minimal PostgREST stand-in: eq / in filters (dotted paths reach the embedded
// journal_entries row), order, and range with the server's 1,000-row cap.
function fakeSupabase(tables, { failOn = null } = {}) {
  const get = (row, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
  return {
    from(table) {
      const filters = []; let range = null; let orderBy = null;
      const q = {
        select() { return q; },
        eq(col, v) { filters.push((r) => get(r, col) === v); return q; },
        in(col, vs) { filters.push((r) => vs.includes(get(r, col))); return q; },
        order(col) { orderBy = col; return q; },
        range(a, b) { range = [a, b]; return q; },
        then(resolve, reject) {
          if (failOn === table) return Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(resolve, reject);
          let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          if (orderBy) rows = rows.slice().sort((x, y) => String(x[orderBy]).localeCompare(String(y[orderBy]), undefined, { numeric: true }));
          const [a, b] = range || [0, rows.length - 1];
          rows = rows.slice(a, Math.min(b, a + 999) + 1);   // server cap: at most 1,000 rows per response
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const baseTables = () => ({
  account_funds: [
    { id: 'OPR', community_id: CID, fund_code: 'OPR', fund_name: 'Operating', fund_type: 'operating', is_active: true },
    { id: 'ADO', community_id: CID, fund_code: 'ADO', fund_name: 'Adopt a School', fund_type: 'other', is_active: true },
  ],
  chart_of_accounts: [
    { id: 'opr-1810', community_id: CID, account_number: '1810', account_name: 'Due from Adopt a School to Operating', account_type: 'asset', fund_id: 'OPR', is_active: true, is_summary: false },
    { id: 'opr-2810', community_id: CID, account_number: '2810', account_name: 'Due to Adopt a School from Operating', account_type: 'liability', fund_id: 'OPR', is_active: true, is_summary: false },
    { id: 'ado-1815', community_id: CID, account_number: '1815', account_name: 'Due from Operating to Adopt a School', account_type: 'asset', fund_id: 'ADO', is_active: true, is_summary: false },
    { id: 'ado-2815', community_id: CID, account_number: '2815', account_name: 'Due to Operating from Adopt a School', account_type: 'liability', fund_id: 'ADO', is_active: true, is_summary: false },
  ],
  journal_entry_lines: [],
});
let seq = 0;
const line = (account_id, dr, cr, je) => ({ id: `l${String(++seq).padStart(6, '0')}`, account_id, debit_cents: dr, credit_cents: cr, journal_entries: { community_id: CID, ...je } });
const POSTED = { status: 'posted', void_reversal_je_id: null };

// ---------------------------------------------------------------- 1. reversals keep the fund
check('reversal lines keep each original line\'s fund, swap amounts, keep refs', () => {
  const orig = [
    { account_id: 'cash-1250', fund_id: 'ADO', debit_cents: 0, credit_cents: 697130, memo: 'split cash', property_id: 'p1', vendor_id: 'v1', bank_account_id: 'b1' },
    { account_id: 'cash-1000', fund_id: 'OPR', debit_cents: 697130, credit_cents: 0, memo: null, property_id: null, vendor_id: null, bank_account_id: null },
  ];
  const rev = buildReversalLines({ reference: 'JE-1' }, orig);
  assert.deepStrictEqual(rev.map((l) => l.fund_id), ['ADO', 'OPR']);
  assert.deepStrictEqual(rev.map((l) => [l.debit_cents, l.credit_cents]), [[697130, 0], [0, 697130]]);
  assert.strictEqual(rev[0].memo, 'Reversal of JE-1: split cash');
  assert.deepStrictEqual([rev[0].property_id, rev[0].vendor_id, rev[0].bank_account_id], ['p1', 'v1', 'b1']);
  assert.strictEqual(rev[1].fund_id, 'OPR');
  assert.strictEqual(buildReversalLines({ reference: 'JE-2' }, [{ account_id: 'a', debit_cents: 1, credit_cents: 0 }])[0].fund_id, null, 'an untagged line stays untagged (falls back to the account fund at posting)');
});

check('reversing a bridged cross-fund entry adds no interfund lines (fund preserved)', () => {
  // ADO expense on an Operating-fund account, paid from Operating: bridged at posting.
  const accountFund = { 'exp-5950': 'OPR', 'ap-2000': 'OPR', 'ado-2815': 'ADO', 'opr-1810': 'OPR' };
  const fundOf = (l) => l.fund_id || accountFund[l.account_id];
  const lines = [
    { account_id: 'exp-5950', fund_id: 'ADO', debit_cents: 50000, credit_cents: 0 },
    { account_id: 'ap-2000', fund_id: 'OPR', debit_cents: 0, credit_cents: 50000 },
  ];
  const posted = lines.concat(computeBridge(lines, fundOf, resolved));
  const rev = buildReversalLines({ reference: 'JE-9' }, posted);
  assert.deepStrictEqual(computeBridge(rev, fundOf, resolved), [], 'reversal must not be re-bridged');
  const net = netByFund(posted.concat(rev), fundOf);
  assert.ok(Object.values(net).every((v) => v === 0), 'original + reversal net to zero in every fund: ' + JSON.stringify(net));
  // The defect: dropping fund_id sends the ADO expense line back to its account's
  // fund (OPR), so the reversal is lopsided and gets bridged a second time.
  const old = rev.map(({ fund_id, ...l }) => l);
  assert.notDeepStrictEqual(computeBridge(old, fundOf, resolved), [], 'without fund_id the reversal is mis-funded');
});

// ---------------------------------------------------------------- 2. interfundBalances
check('counts only posted entries and voids with a reversal; excludes drafts and reversal-less voids', async () => {
  const t = baseTables();
  t.journal_entry_lines.push(
    line('ado-2815', 0, 10000, POSTED),                                          // ADO owes Operating 100.00
    line('ado-2815', 0, 70000, { status: 'draft', void_reversal_je_id: null }),  // draft: never counts
    line('ado-2815', 0, 30000, { status: 'voided', void_reversal_je_id: null }), // void without reversal: never counts
    line('ado-2815', 0, 5000, { status: 'voided', void_reversal_je_id: 'rev1' }), // voided original with reversal: counts
    line('ado-2815', 5000, 0, POSTED),                                           // ...and its reversal
    line('ado-2815', 0, 99900, { status: 'posted', void_reversal_je_id: null, community_id: 'other' }), // another community
  );
  const out = await interfundBalances(fakeSupabase(t), CID);
  assert.deepStrictEqual(out.map((b) => [b.fund_code, b.owes_operating_cents]), [['ADO', 10000]]);
});

check('reads every line past the 1,000-row cap', async () => {
  const t = baseTables();
  for (let i = 0; i < 2500; i++) t.journal_entry_lines.push(line('ado-2815', 0, 100, POSTED));
  const out = await interfundBalances(fakeSupabase(t), CID);
  assert.strictEqual(out[0].owes_operating_cents, 250000, 'all 2,500 lines must count, got ' + (out[0] && out[0].owes_operating_cents));
});

check('a failed read throws instead of reporting nothing owed', async () => {
  for (const table of ['journal_entry_lines', 'account_funds']) {
    const t = baseTables(); t.journal_entry_lines.push(line('ado-2815', 0, 10000, POSTED));
    let threw = false;
    try { await interfundBalances(fakeSupabase(t, { failOn: table }), CID); } catch (_) { threw = true; }
    assert.ok(threw, `${table} failure must throw`);
  }
});

// ---------------------------------------------------------------- 3. transfers refuse interfund accounts
check('isInterfundAccount: resolved accounts and any Due To / Due From by name; cash is not', () => {
  assert.ok(isInterfundAccount({ id: 'opr-1810', account_name: 'whatever' }, resolved));
  assert.ok(isInterfundAccount({ id: 'x', account_name: 'Due from Operating to Savings' }, null), 'LOPF 1810 legacy pair, unresolved');
  assert.ok(isInterfundAccount({ id: 'y', account_name: 'Due To Reserve' }, resolved));
  assert.ok(!isInterfundAccount({ id: 'cash', account_name: 'Operating Cash Account' }, resolved));
  assert.ok(!isInterfundAccount({ id: 'res', account_name: 'Reserve Cash Account' }, resolved));
  assert.ok(!isInterfundAccount({ id: 'z', account_name: 'Overdue fees receivable' }, resolved), '"due" alone is not interfund');
});

check('buildTransferLines refuses an interfund account as source or destination', () => {
  const cash = { id: 'cash-1000', fund_id: 'OPR', account_name: 'Operating Cash Account' };
  const savings = { id: 'cash-1100', fund_id: 'OPR', account_name: 'Savings' };
  for (const bad of [{ id: 'opr-1810', fund_id: 'OPR', account_name: 'Due from Adopt a School to Operating' }, { id: 'x', fund_id: 'OPR', account_name: 'Due to Savings from Operating' }]) {
    assert.throws(() => buildTransferLines({ from: bad, to: cash, amountCents: 100, resolved }), /interfund_account_is_not_cash/);
    assert.throws(() => buildTransferLines({ from: cash, to: bad, amountCents: 100, resolved }), /interfund_account_is_not_cash/);
  }
  const ok = buildTransferLines({ from: cash, to: savings, amountCents: 5000000, resolved });
  assert.strictEqual(ok.length, 2, 'cash-to-cash same-fund transfer still works');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ' — ' + e.message); }
  }
  console.log(failures ? `\n${failures} interfund defect test(s) FAILED` : '\nall interfund defect tests passed');
  process.exit(failures ? 1 : 0);
})();
