// ============================================================================
// tests/test_ledger_line.js  (Ed 2026-10-20)
// ----------------------------------------------------------------------------
// Homeowner 360 shows each ledger row by its description (lib/ar/ledger_line.js).
// Scar: the page rendered txn_type, so the five legal chargebacks corrected by
// migration 538 still read "charge $1,008.00" with no description or invoice
// number. These tests render the page's actual row template from
// public/homeowner.html, so a revert to a type-only label fails here.
// ============================================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ar/ledger_line');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message); } }

const LEGAL = 'Legal Fees - Collections: Court filings and documents (Attorney Inv. 283101)';
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'homeowner.html'), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (c) => { c = Number(c) || 0; return (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const d10 = (s) => (s ? String(s).slice(0, 10) : '');
const rowLine = html.split('\n').find((l) => l.includes('(d.ar.transactions||[]).slice(0,8)'));
const renderRows = (txns, ledgerLine) => new Function('d', 'esc', 'money', 'd10', 'LedgerLine', `return ${rowLine.trim().replace(/^\$\{/, '').replace(/\}$/, '')};`)({ ar: { transactions: txns } }, esc, money, d10, ledgerLine);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

t('label: a row with a description reads as its description, invoice number included', () => {
  assert.strictEqual(L.label({ description: LEGAL, txn_type: 'charge', charge_category: 'attorney_fee' }), LEGAL);
  assert.strictEqual(L.label({ description: '  Legal Fees - DRV Enforcement:\n Attorney services (Attorney Inv. PS-INV350881) ', txn_type: 'charge' }), 'Legal Fees - DRV Enforcement: Attorney services (Attorney Inv. PS-INV350881)');
});
t('label: no description falls back to the category, then the type, never blank', () => {
  assert.strictEqual(L.label({ description: '', txn_type: 'charge', charge_category: 'attorney_fee' }), 'Legal Fees - Collections');
  assert.strictEqual(L.label({ description: null, txn_type: 'charge', charge_category: 'special_assessment' }), 'Special assessment');
  assert.strictEqual(L.label({ txn_type: 'payment' }), 'Payment');
  assert.strictEqual(L.label({}), 'Transaction');
  assert.strictEqual(L.label(null), 'Transaction');
});
t('Homeowner 360 page: the legal charge row shows description, attorney invoice and amount (not a bare "charge")', () => {
  assert.ok(rowLine, 'row template found in public/homeowner.html');
  const out = text(renderRows([{ transaction_date: '2026-09-30', description: LEGAL, txn_type: 'charge', charge_category: 'attorney_fee', amount_cents: 100800 }], L));
  assert.ok(out.includes(LEGAL), out);
  assert.ok(out.includes('Attorney Inv. 283101') && out.includes('$1,008.00') && out.includes('2026-09-30'), out);
  assert.ok(!/· charge\b/.test(out), 'no type-only label: ' + out);
});
t('Homeowner 360 page: still shows the description if /app/ledger-line.js failed to load', () => {
  const out = text(renderRows([{ transaction_date: '2026-10-11', description: 'Legal Fees - DRV Enforcement: Attorney services and court costs (Attorney Inv. PS-INV350881)', txn_type: 'charge', amount_cents: 55735 }], undefined));
  assert.ok(out.includes('Attorney Inv. PS-INV350881') && out.includes('$557.35'), out);
});
t('Homeowner 360 page: descriptions are HTML-escaped', () => {
  const out = renderRows([{ transaction_date: '2026-09-30', description: '<img src=x onerror=alert(1)>', txn_type: 'charge', amount_cents: 100 }], L);
  assert.ok(!out.includes('<img') && out.includes('&lt;img'), out);
});
t('wiring: the page loads the shared helper, the server serves it, and the AI recap uses the same label', () => {
  assert.ok(html.includes('<script src="/app/ledger-line.js"></script>'));
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/app\.get\('\/app\/ledger-line\.js'[^\n]*lib', 'ar', 'ledger_line\.js'/.test(server), 'route serves lib/ar/ledger_line.js');
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'homeowner_360.js'), 'utf8');
  assert.ok(/Recent payments\/charges:[^\n]*LedgerLine\.label\(t\)/.test(api), 'recap prompt labels rows with LedgerLine.label');
  assert.ok(/\.from\('v_current_owner_ledger'\)\s*\n?\s*\.select\('[^']*\bdescription\b/.test(api), 'profile query selects description');
});

console.log(`\n${pass} passed${fail ? ', FAILURES above' : ''}`);
if (fail) process.exitCode = 1;
