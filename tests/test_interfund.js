// Tests for the interfund auto-bridge math (lib/accounting/interfund.js).
// Cross-fund entries must leave EVERY fund self-balancing. (Ed 2026-09-04.)
const assert = require('assert');
const { computeBridge, buildTransferLines } = require('../lib/accounting/interfund');

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

// ---- Transfer lines -------------------------------------------------------
function fundNet(lines) {
  const n = {};
  for (const l of lines) { const f = l.fund_id; n[f] = (n[f] || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0); }
  return n;
}
const OPR_CASH = { id: 'opr-cash', fund_id: 'OPR' };
const OPR_SAV = { id: 'opr-sav', fund_id: 'OPR' };
const ADO_CASH = { id: 'ado-cash', fund_id: 'ADO' };
const RES_CASH = { id: 'res-cash', fund_id: 'RES' };

check('same-fund transfer is a plain reallocation', () => {
  const l = buildTransferLines({ from: OPR_CASH, to: OPR_SAV, amountCents: 10000, resolved });
  assert.strictEqual(l.length, 2);
  assert.strictEqual(fundNet(l).OPR, 0);
  const dr = l.find((x) => x.debit_cents); const cr = l.find((x) => x.credit_cents);
  assert.strictEqual(dr.account_id, 'opr-sav'); assert.strictEqual(cr.account_id, 'opr-cash');
});

check('sub -> Operating clears the interfund and balances each fund', () => {
  const l = buildTransferLines({ from: ADO_CASH, to: OPR_CASH, amountCents: 50000, resolved });
  const net = fundNet(l);
  assert.strictEqual(net.OPR, 0); assert.strictEqual(net.ADO, 0);
  // ADO pays down its "Due to Operating" (debit reduces the credit-balance),
  // Operating collects its "Due from ADO" (credit reduces the debit-balance).
  assert.ok(l.some((x) => x.account_id === 'ado-dueto-opr' && x.debit_cents === 50000), 'debit ADO Due-to-Operating');
  assert.ok(l.some((x) => x.account_id === 'opr-duefrom-ado' && x.credit_cents === 50000), 'credit OPR Due-from-ADO');
  assert.ok(l.some((x) => x.account_id === 'opr-cash' && x.debit_cents === 50000), 'cash into Operating');
});

check('Operating -> sub clears the other direction', () => {
  const l = buildTransferLines({ from: OPR_CASH, to: ADO_CASH, amountCents: 50000, resolved });
  const net = fundNet(l);
  assert.strictEqual(net.OPR, 0); assert.strictEqual(net.ADO, 0);
  assert.ok(l.some((x) => x.account_id === 'opr-dueto-ado' && x.debit_cents === 50000), 'debit OPR Due-to-ADO');
  assert.ok(l.some((x) => x.account_id === 'ado-duefrom-opr' && x.credit_cents === 50000), 'credit ADO Due-from-Operating');
});

check('cross-fund transfer with no Operating side is rejected', () => {
  assert.throws(() => buildTransferLines({ from: RES_CASH, to: ADO_CASH, amountCents: 100, resolved }), /operating/i);
});

if (failures) { console.error('\n' + failures + ' interfund test(s) failed.'); process.exit(1); }
console.log('\nAll interfund tests passed.');
