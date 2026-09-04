// Tests for the interfund auto-bridge math (lib/accounting/interfund.js).
// Cross-fund entries must leave EVERY fund self-balancing. (Ed 2026-09-04.)
const assert = require('assert');
const { computeBridge } = require('../lib/accounting/interfund');

let failures = 0;
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ' — ' + e.message); } }

const fundOf = (ln) => ln.fund_id || null;
const resolved = {
  oprFundId: 'OPR',
  map: {
    ADO: { fundDueTo: 'ado-dueto-opr', fundDueFrom: 'ado-duefrom-opr', oprDueFrom: 'opr-duefrom-ado', oprDueTo: 'opr-dueto-ado' },
  },
};

// Per-fund net (Dr − Cr) across the original lines plus the bridge — must be 0
// for every fund once bridged.
function netByFund(lines) {
  const net = {};
  for (const l of lines) {
    const f = fundOf(l);
    net[f] = (net[f] || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0);
  }
  return net;
}

// Adopt-a-School $500 expense, A/P in Operating (the James Bowie donation).
check('ADO expense / OPR payable bridges to balanced funds', () => {
  const lines = [
    { account_id: '5950', fund_id: 'ADO', debit_cents: 50000, credit_cents: 0 },
    { account_id: '2000', fund_id: 'OPR', debit_cents: 0, credit_cents: 50000 },
  ];
  const bridge = computeBridge(lines, fundOf, resolved);
  assert.strictEqual(bridge.length, 2, 'expected 2 bridge lines');
  const net = netByFund(lines.concat(bridge));
  assert.strictEqual(net.ADO, 0, 'ADO must net 0, got ' + net.ADO);
  assert.strictEqual(net.OPR, 0, 'OPR must net 0, got ' + net.OPR);
  // ADO owes Operating: credit ADO's "Due to Operating", debit Operating's "Due from ADO".
  const adoLine = bridge.find((b) => b.fund_id === 'ADO');
  const oprLine = bridge.find((b) => b.fund_id === 'OPR');
  assert.strictEqual(adoLine.account_id, 'ado-dueto-opr');
  assert.strictEqual(adoLine.credit_cents, 50000);
  assert.strictEqual(oprLine.account_id, 'opr-duefrom-ado');
  assert.strictEqual(oprLine.debit_cents, 50000);
});

// Adopt-a-School donation received into Operating's commingled cash (deposit
// picker crediting 4050 ADO income): opposite direction — Operating owes ADO.
check('ADO income / OPR cash bridges the other way', () => {
  const lines = [
    { account_id: '1000', fund_id: 'OPR', debit_cents: 50000, credit_cents: 0 },
    { account_id: '4050', fund_id: 'ADO', debit_cents: 0, credit_cents: 50000 },
  ];
  const bridge = computeBridge(lines, fundOf, resolved);
  const net = netByFund(lines.concat(bridge));
  assert.strictEqual(net.ADO, 0);
  assert.strictEqual(net.OPR, 0);
  const adoLine = bridge.find((b) => b.fund_id === 'ADO');
  assert.strictEqual(adoLine.account_id, 'ado-duefrom-opr', 'ADO gets a receivable from Operating');
  assert.strictEqual(adoLine.debit_cents, 50000);
});

// A single-fund entry (all Operating) needs no bridge.
check('single-fund entry adds no bridge', () => {
  const lines = [
    { account_id: '5200', fund_id: 'OPR', debit_cents: 10000, credit_cents: 0 },
    { account_id: '2000', fund_id: 'OPR', debit_cents: 0, credit_cents: 10000 },
  ];
  assert.strictEqual(computeBridge(lines, fundOf, resolved).length, 0);
});

// A fund with no resolved interfund accounts is left alone (no regression).
check('unresolved fund is not bridged', () => {
  const lines = [
    { account_id: '5xxx', fund_id: 'RES', debit_cents: 10000, credit_cents: 0 },
    { account_id: '2000', fund_id: 'OPR', debit_cents: 0, credit_cents: 10000 },
  ];
  assert.strictEqual(computeBridge(lines, fundOf, resolved).length, 0, 'RES not in map → skip');
});

// No resolution at all (community without interfund accounts) → no bridge.
check('null resolution posts unchanged', () => {
  const lines = [{ account_id: 'a', fund_id: 'ADO', debit_cents: 100, credit_cents: 0 }];
  assert.strictEqual(computeBridge(lines, fundOf, null).length, 0);
});

if (failures) { console.error('\n' + failures + ' interfund test(s) failed.'); process.exit(1); }
console.log('\nAll interfund tests passed.');
