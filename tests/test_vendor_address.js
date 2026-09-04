// Tests for check payee-address formatting (formatVendorAddress in check_run.js).
// Scar: Superior LawnCare's address was one crammed field
// "PO Box 15217, Houston, TX, 77220, USA" — state/ZIP as separate comma tokens
// plus a trailing country — so a Quail Ridge check printed the city on the
// street line. (Ed 2026-09-04.)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || '0'.repeat(64);

const assert = require('assert');
const { formatVendorAddress } = require('../lib/accounting/check_run');

let failures = 0;
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { failures++; console.error('  FAIL ' + name + ' — ' + e.message); } }

// The exact bug: crammed comma string with separate ST/ZIP tokens + trailing USA.
check('Superior LawnCare crammed address -> clean street + CSZ', () => {
  const out = formatVendorAddress({ name: 'Superior LawnCare', remit_address_line1: 'PO Box 15217, Houston, TX, 77220, USA' });
  assert.deepStrictEqual(out, ['PO Box 15217', 'Houston, TX 77220'], 'got ' + JSON.stringify(out));
});

// Structured remit fields (the clean path) still work.
check('structured remit fields build street + CSZ', () => {
  const out = formatVendorAddress({ remit_address_line1: 'PO Box 15217', remit_city: 'Houston', remit_state: 'TX', remit_zip: '77220' });
  assert.deepStrictEqual(out, ['PO Box 15217', 'Houston, TX 77220']);
});

// Standard "street, City, ST ZIP" (state+zip together) still parses.
check('standard City, ST ZIP still parses', () => {
  const out = formatVendorAddress({ name: 'Acme', remit_address_line1: '123 Main St, Sugar Land, TX 77478' });
  assert.deepStrictEqual(out, ['123 Main St', 'Sugar Land, TX 77478']);
});

// Trailing ", USA" on the standard form is stripped, not left dangling.
check('trailing USA is dropped', () => {
  const out = formatVendorAddress({ name: 'Acme', remit_address_line1: '123 Main St, Sugar Land, TX 77478, USA' });
  assert.deepStrictEqual(out, ['123 Main St', 'Sugar Land, TX 77478']);
});

// Missing comma before city (a known prior case) still works.
check('missing comma before city still parses', () => {
  const out = formatVendorAddress({ name: 'Acme', remit_address_line1: '8810 Madie Drive Houston, Texas 77022' });
  assert.deepStrictEqual(out, ['8810 Madie Drive', 'Houston, TX 77022']);
});

if (failures) { console.error('\n' + failures + ' vendor-address test(s) failed.'); process.exit(1); }
console.log('\nAll vendor-address tests passed.');
