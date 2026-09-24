#!/usr/bin/env node
// Tests for the ar_credits row rule in lib/conversion/formats.js.
// ar_credits.amount is signed as supplied: any non-zero value is accepted,
// zero is rejected. Other AR files keep their own rules unchanged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseInputFile, FILES } = require('../lib/conversion/formats');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-formats-'));
function parse(kind, amounts) {
  const cols = FILES[kind].columns.map((c) => c.name);
  const lines = [cols.join(','), ...amounts.map((a) => cols.map((c) => ({ vantaca_account_id: '2012720', owner_name: 'Synthetic Owner', tenure_status: 'current', charge_category: 'other', effective_date: '2026-07-31', amount: a, source_report: 'SYNTHETIC', source_row: '1' }[c] ?? '')).join(','))];
  const p = path.join(dir, `${kind}.csv`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return parseInputFile(kind, p);
}

t('ar_credits: positive amount is valid', () => {
  const r = parse('ar_credits', ['150.00']);
  assert.strictEqual(r.exceptions.length, 0, JSON.stringify(r.exceptions));
  assert.strictEqual(r.rows[0].amount, 15000);
});

t('ar_credits: negative amount is valid and keeps its sign (e.g. -150.00)', () => {
  const r = parse('ar_credits', ['-150.00']);
  assert.strictEqual(r.exceptions.length, 0, JSON.stringify(r.exceptions));
  assert.strictEqual(r.rows[0].amount, -15000);
});

t('ar_credits: zero amount is a ROW_RULE exception', () => {
  const r = parse('ar_credits', ['0.00']);
  assert.strictEqual(r.exceptions.length, 1);
  assert.strictEqual(r.exceptions[0].code, 'ROW_RULE');
  assert.strictEqual(r.exceptions[0].detail, 'amount must be non-zero');
});

t('ar_credits: parenthesized / $ amounts are still FIELD_INVALID_MONEY (no coercion)', () => {
  const r = parse('ar_credits', ['(150.00)', '$150.00']);
  assert.deepStrictEqual(r.exceptions.map((e) => e.code), ['FIELD_INVALID_MONEY', 'FIELD_INVALID_MONEY']);
});

t('ar_debits rule unchanged: negative amount still rejected', () => {
  const r = parse('ar_debits', ['-150.00']);
  assert.strictEqual(r.exceptions.length, 1);
  assert.strictEqual(r.exceptions[0].detail, 'amount must be > 0');
});

t('contract text for ar_credits says amount != 0', () => assert.strictEqual(FILES.ar_credits.rule, 'amount != 0 (signed as supplied)'));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exit(failed ? 1 : 0);
