// Locks the NewFirst Positive Pay file format (Ed 2026-09-08). Bank sample:
//   3/3/2022,31852,Joh Doe Rentals,478.30   (IssueDate M/D/YYYY, Check#, Payee, Amount)
require('dotenv').config();
const assert = require('assert');
const { generatePositivePayCsv } = require('../lib/accounting/positive_pay');
let p = 0, f = 0; const ck = (n, fn) => { try { fn(); console.log('  PASS ', n); p++; } catch (e) { console.log('  FAIL ', n, '\n    ' + e.message); f++; } };

ck('matches the bank sample row exactly', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2022-03-03', check_number: 31852, payee_name: 'Joh Doe Rentals', amount_cents: 47830 }]);
  assert.strictEqual(csv, '3/3/2022,31852,Joh Doe Rentals,478.30\r\n');
});
ck('strips ALL punctuation from payee (bank throws exceptions otherwise); no $ or thousands separator', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2026-09-08', check_number: 1042, payee_name: 'S&L Solutions, LLC', amount_cents: 1751181 }]);
  assert.strictEqual(csv.trim(), '9/8/2026,1042,S L Solutions LLC,17511.81');
});
ck('strips commas, periods, apostrophes, ampersands, hyphens from payee', () => {
  const { sanitizePayee } = require('../lib/accounting/positive_pay');
  assert.strictEqual(sanitizePayee('RABKA PEST CONTROL, LLC'), 'RABKA PEST CONTROL LLC');
  assert.strictEqual(sanitizePayee("O'Brien & Sons, Inc."), 'O Brien Sons Inc');
  assert.strictEqual(sanitizePayee('Reece-Albert, L.L.C. #204'), 'Reece Albert L L C 204');
  assert.strictEqual(sanitizePayee(''), '');
});
ck('the written CSV row never contains a comma inside the payee field', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2026-09-08', check_number: 7, payee_name: 'A, B, C Landscaping, LLC', amount_cents: 10000 }]);
  // exactly 4 fields -> 3 commas, none from the payee
  assert.strictEqual(csv.trim().split(',').length, 4);
  assert.ok(!/"/.test(csv), 'no CSV quoting should be needed once punctuation is stripped');
});
ck('skips voids / zero-amount rows', () => {
  const { count } = generatePositivePayCsv([{ issue_date: '2026-09-08', check_number: 5, payee_name: 'X', amount_cents: 0 }]);
  assert.strictEqual(count, 0);
});
process.on('exit', () => { console.log(`\npositive_pay: ${p} passed, ${f} failed`); if (f) process.exit(1); });
