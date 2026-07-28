// Tests for lib/ap/statement_lines.js — Vantaca-cutover statement detection.
// The one that matters: a prior payment must NOT be treated as a vendor credit.
const assert = require('assert');
const { classifyStatement, isPriorPaymentLine } = require('../lib/ap/statement_lines');

let pass = 0;
const ok = (d, c) => { assert.ok(c, d); pass++; };

// The Saifee case (Ed 2026-07-28): a Payment/Check-ACH line + a discount, both
// prior payments already in Vantaca; balance due is the only new amount.
const saifee = [
  { line_number: 1, description: 'Custom Monument Sign Option A-1', amount_cents: 4318200 },
  { line_number: 2, description: 'Exterior ACM Sign', amount_cents: 25300 },
  { line_number: 3, description: 'Customer Disc.', amount_cents: -71000 },
  { line_number: 4, description: 'Sales Tax (8.25%)', amount_cents: 358339 },
  { line_number: 5, description: 'Payment Fri, 04/24/2026 Check ACH', amount_cents: -3201726 },
];
const cl = classifyStatement(saifee);
ok('a Payment/Check-ACH line is detected as a prior payment', isPriorPaymentLine(saifee[4]));
ok('a bill with a prior-payment line is a statement', cl.is_statement === true);
ok('on a statement, EVERY negative is prior activity (the discount too)', cl.isPriorLine(saifee[2]) && cl.isPriorLine(saifee[4]));
ok('positive charge lines are not prior', !cl.isPriorLine(saifee[0]) && !cl.isPriorLine(saifee[3]));
ok('prior total sums both negatives', cl.prior_payment_cents === -3272726);

// A genuine current credit (no payment line) must stay a credit, not a statement.
const genuine = [
  { line_number: 1, description: 'Pool management', amount_cents: 500000 },
  { line_number: 2, description: 'credit for days closed in June', amount_cents: -147000 },
];
ok('a bill with only a genuine credit is NOT a statement', classifyStatement(genuine).is_statement === false);
ok('a genuine credit line is not a prior payment', !isPriorPaymentLine(genuine[1]));

// Payment-word matching.
ok('ACH detected', isPriorPaymentLine({ description: 'ACH payment received', amount_cents: -100 }));
ok('Wire detected', isPriorPaymentLine({ description: 'Wire transfer 3/1', amount_cents: -100 }));
ok('a positive "payment plan" charge is not a prior payment', !isPriorPaymentLine({ description: 'Payment plan setup', amount_cents: 5000 }));
ok('empty lines -> not a statement', classifyStatement([]).is_statement === false);

console.log(`statement_lines: ${pass} assertions passed`);
