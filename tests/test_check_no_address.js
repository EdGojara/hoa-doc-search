// ============================================================================
// tests/test_check_no_address.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// A printed check must have somewhere to go. RABKA Pest Control (Canyon Gate)
// had no address on file and a check was cut anyway. createCheckRun now refuses
// the run when a vendor has no mailable address — and that guard depends on
// formatVendorAddress returning an EMPTY ARRAY (not null) for no-address, which
// is truthy, so the guard must test .length. This locks that contract so the
// guard can't be silently defeated by a refactor.
// ============================================================================
require('dotenv').config();
const assert = require('assert');
const { formatVendorAddress } = require('../lib/accounting/check_run');

let passed = 0, failed = 0;
function check(name, fn) { try { fn(); console.log('  PASS ', name); passed++; } catch (e) { console.log('  FAIL ', name, '\n        ' + e.message); failed++; } }

check('no address on file -> empty (guard fires: length 0)', () => {
  const lines = formatVendorAddress({ name: 'RABKA Pest Control', address: null, remit_address_line1: null, remit_address_line2: null, remit_city: null, remit_state: null, remit_zip: null });
  assert.ok(Array.isArray(lines), 'returns an array');
  assert.strictEqual(lines.length, 0, 'no-address vendor must yield zero address lines so the check-run guard fires');
});

check('a real address -> non-empty (guard does NOT fire)', () => {
  const lines = formatVendorAddress({ name: 'Good Vendor', remit_address_line1: '123 Main St', remit_city: 'Katy', remit_state: 'TX', remit_zip: '77450' });
  assert.ok(lines.length >= 1, 'a vendor with an address yields address lines');
});

check('unstructured single-line address still counts as mailable', () => {
  const lines = formatVendorAddress({ name: 'Legacy Vendor', remit_address_line1: 'Legacy Vendor 500 Commerce St, Houston, TX 77002', remit_city: null, remit_state: null, remit_zip: null });
  assert.ok(lines.length >= 1, 'a parsed single-line remit address is still an address');
});

process.on('exit', () => { console.log(`\ncheck_no_address: ${passed} passed, ${failed} failed`); if (failed) process.exit(1); });
