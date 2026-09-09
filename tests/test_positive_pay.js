// Locks the NewFirst Positive Pay COMBINED file format (Ed 2026-09-09). All
// operating accounts in one file, with an ACCOUNT # column, per the bank sample
// "Sample PP File - ACCT # INCLUDED.csv":
//   DATE ,CHECK #,CHECK PAYEE,CHECK AMOUNT ,ACCOUNT #
//   3/3/2022,31852,Joh Doe Rentals,478.30,123456
require('dotenv').config();
const assert = require('assert');
const { generatePositivePayCsv, sanitizePayee, PP_HEADER } = require('../lib/accounting/positive_pay');
let p = 0, f = 0; const ck = (n, fn) => { try { fn(); console.log('  PASS ', n); p++; } catch (e) { console.log('  FAIL ', n, '\n    ' + e.message); f++; } };

ck('header + row match the bank sample exactly (with ACCOUNT # column)', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2022-03-03', check_number: 31852, payee_name: 'Joh Doe Rentals', amount_cents: 47830, account_number: '123456' }]);
  assert.strictEqual(csv, PP_HEADER + '\r\n3/3/2022,31852,Joh Doe Rentals,478.30,123456\r\n');
});
ck('header is always present, even with zero mailable rows', () => {
  const { csv, count } = generatePositivePayCsv([{ check_number: 5, payee_name: 'X', amount_cents: 0, account_number: '1' }]);
  assert.strictEqual(count, 0);
  assert.strictEqual(csv, PP_HEADER + '\r\n');
});
ck('all accounts go in ONE file (multi-account rows)', () => {
  const { csv, count } = generatePositivePayCsv([
    { issue_date: '2026-09-09', check_number: 1001, payee_name: 'ABC Landscaping', amount_cents: 10000, account_number: '1777' },
    { issue_date: '2026-09-09', check_number: 2002, payee_name: 'XYZ Pool', amount_cents: 20000, account_number: '5313' },
  ]);
  assert.strictEqual(count, 2);
  assert.ok(csv.includes(',1777\r\n') && csv.includes(',5313\r\n'), 'both account numbers present in one file');
});
ck('account number is stripped to digits only', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2026-09-09', check_number: 7, payee_name: 'V', amount_cents: 100, account_number: 'Acct #1777-00' }]);
  assert.ok(csv.trim().endsWith(',177700'), 'non-digits stripped: ' + csv);
});
ck('flags checks missing an account number (would misroute at the bank)', () => {
  const { missing_account } = generatePositivePayCsv([
    { issue_date: '2026-09-09', check_number: 1, payee_name: 'A', amount_cents: 100, account_number: '1777' },
    { issue_date: '2026-09-09', check_number: 2, payee_name: 'B', amount_cents: 100 }, // no account
  ]);
  assert.strictEqual(missing_account, 1);
});
ck('strips ALL punctuation from payee (bank throws exceptions otherwise)', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2026-09-08', check_number: 1042, payee_name: 'S&L Solutions, LLC', amount_cents: 1751181, account_number: '1777' }]);
  assert.ok(csv.includes('9/8/2026,1042,S L Solutions LLC,17511.81,1777'));
});
ck('sanitizePayee strips commas, periods, apostrophes, ampersands, hyphens', () => {
  assert.strictEqual(sanitizePayee('RABKA PEST CONTROL, LLC'), 'RABKA PEST CONTROL LLC');
  assert.strictEqual(sanitizePayee("O'Brien & Sons, Inc."), 'O Brien Sons Inc');
});
ck('a data row has exactly 5 fields, no comma inside the payee', () => {
  const { csv } = generatePositivePayCsv([{ issue_date: '2026-09-08', check_number: 7, payee_name: 'A, B, C Landscaping, LLC', amount_cents: 10000, account_number: '1777' }]);
  const dataRow = csv.trim().split('\r\n')[1];
  assert.strictEqual(dataRow.split(',').length, 5);
  assert.ok(!/"/.test(csv), 'no CSV quoting needed once punctuation is stripped');
});

process.on('exit', () => { console.log(`\npositive_pay: ${p} passed, ${f} failed`); if (f) process.exit(1); });
