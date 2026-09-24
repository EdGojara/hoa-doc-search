#!/usr/bin/env node
// ============================================================================
// Home Sales closing checks: classification is by PAYEE (never memo), unknown
// payees need staff, and a seller payoff is only accepted when fully specified.
// Fixture: the LOPF 4707 Lakes of Pine Forest Ct packet (2 checks).
// ============================================================================
require('dotenv').config({ quiet: true });
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyCheckPayee, validateClosingChecks } = require('../api/home_sales.js')._test;

const LOPF = { name: 'Lakes of Pine Forest', legal_name: 'Lakes of Pine Forest Homeowners Association, Inc.', hoa_legal_name: 'Lakes of Pine Forest Homeowners Association, Inc.' };
let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

t('4707 packet: check 105700 payable to Bedrock -> BEDROCK_FEE', () => {
  assert.strictEqual(classifyCheckPayee('Bedrock Association Mgmt', LOPF), 'BEDROCK_FEE');
  assert.strictEqual(classifyCheckPayee('Bedrock Association Management, LLC', LOPF), 'BEDROCK_FEE');
});
t('4707 packet: check 105699 payable to the Association -> ASSOCIATION_PAYMENT', () => {
  assert.strictEqual(classifyCheckPayee('Lakes of Pine Forest Homeowners Association Inc', LOPF), 'ASSOCIATION_PAYMENT');
  assert.strictEqual(classifyCheckPayee('LAKES OF PINE FOREST HOA', LOPF), 'ASSOCIATION_PAYMENT');
});
t('unknown, bare-name, mixed or blank payees need staff (never guessed)', () => {
  assert.strictEqual(classifyCheckPayee('Select Title, LLC', LOPF), 'NEEDS_CLASSIFICATION');
  assert.strictEqual(classifyCheckPayee('Lakes of Pine Forest Swim Team', LOPF), 'NEEDS_CLASSIFICATION');
  assert.strictEqual(classifyCheckPayee('Lakes of Pine Forest HOA c/o Bedrock Association Management', LOPF), 'NEEDS_CLASSIFICATION');
  assert.strictEqual(classifyCheckPayee('', LOPF), 'NEEDS_CLASSIFICATION');
  assert.strictEqual(classifyCheckPayee(null, LOPF), 'NEEDS_CLASSIFICATION');
});
t('the memo never decides: an "HOA Transfer Fee" memo on a Bedrock check is still Bedrock', () => {
  // classifyCheckPayee takes only the payee; the memo is not an input.
  assert.strictEqual(classifyCheckPayee.length, 2);
  assert.strictEqual(classifyCheckPayee('Bedrock Association Mgmt', LOPF), 'BEDROCK_FEE');
});

const checks4707 = [
  { check_number: '105700', amount_cents: 35000, check_date: '2026-08-27', payee: 'Bedrock Association Mgmt', memo: 'HOA Transfer Fee', classification: 'BEDROCK_FEE' },
  { check_number: '105699', amount_cents: 11923, check_date: '2026-08-27', payee: 'Lakes of Pine Forest Homeowners Association Inc', memo: 'HOA Balance Due', classification: 'ASSOCIATION_PAYMENT', purpose: 'seller_payoff' },
];
t('4707: Bedrock $350 becomes the management fee (never HOA), $119.23 is the seller payoff', () => {
  const r = validateClosingChecks({ checks: checks4707 });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.bedrockFeeCents, 35000);
  assert.strictEqual(r.associationFeeCents, 0);
  assert.deepStrictEqual([r.payoff.check_number, r.payoff.amount_cents, r.payoff.check_date], ['105699', 11923, '2026-08-27']);
});
t('refuses: unclassified check, Association check with no purpose, two payoffs, payoff without date', () => {
  assert.match(validateClosingChecks({ checks: [{ ...checks4707[0], classification: 'NEEDS_CLASSIFICATION' }] }).error, /check_needs_classification/);
  assert.match(validateClosingChecks({ checks: [{ ...checks4707[1], purpose: null }] }).error, /association_check_purpose_required/);
  assert.match(validateClosingChecks({ checks: [checks4707[1], { ...checks4707[1], check_number: '1' }] }).error, /one_seller_payoff/);
  assert.match(validateClosingChecks({ checks: [{ ...checks4707[1], check_date: null }] }).error, /payoff_check_number_and_date_required/);
  assert.match(validateClosingChecks({ checks: [{ ...checks4707[0], amount_cents: 0 }] }).error, /check_amount_required/);
});
t('no checks = the older single-fee form (no payoff)', () => {
  const r = validateClosingChecks({});
  assert.deepStrictEqual([r.checks, r.payoff], [null, null]);
});
t('record-closing: transfer first, payoff to the transfer\'s SELLER tenure, never the buyer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/home_sales.js'), 'utf8').replace(/\r\n/g, '\n');
  const rc = src.slice(src.indexOf("router.post('/record-closing'"), src.indexOf('function validateClosingChecks'));
  const iTransfer = rc.indexOf("rpc('approve_ownership_proposal'");
  const iPost = rc.indexOf('postTenurePayment(');
  assert.ok(iTransfer > 0 && iPost > iTransfer, 'payoff must post after the transfer');
  assert.ok(/postTenurePayment\(supabase, payoffArgs\(b, checkPlan\.payoff, t\.seller_tenure_id/.test(rc), 'payoff must use the transfer result seller tenure');
  assert.ok(!/buyer_tenure_id/.test(rc.slice(iPost - 400, iPost + 200)), 'no buyer tenure near the payoff');
  assert.ok(/payoff_not_confirmed/.test(rc), 'payoff requires explicit confirmation');
});

console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exitCode = failed ? 1 : 0;
