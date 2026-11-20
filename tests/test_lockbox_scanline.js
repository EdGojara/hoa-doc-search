// ============================================================================
// tests/test_lockbox_scanline.js  (Ed 2026-11-20)
// The bank coupon scanline (lib/payments/lockbox.js). The format and check
// digit were validated against 21 real Vantaca/NewFirst coupons (kept out of
// this public repo); these vectors are fictional and lock the behavior.
// Run: node tests/test_lockbox_scanline.js
// ============================================================================
const { buildScanline, scanName, luhn, lockboxFor, LOCKBOXES } = require('../lib/payments/lockbox');
const { remitTo } = require('../lib/payments/remit_address');

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`); else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); } };

console.log('\nCheck digit');
check('Luhn: the standard test number 7992739871 has check digit 3', luhn('7992739871') === 3);
check('Luhn ignores nothing but takes digits only (caller strips letters)', luhn('0') === 0);

console.log('\nScanline layout (50 characters, 6 fields)');
const NF = { mgmt_code: '0000', association_code: '101' };
const line = buildScanline(NF, { accountNumber: '10199991', ownerName: 'Pat Testerson', amountCents: 61234 });
check('fields: mgmt, association, 16-digit account, 12-char name, 6-digit cents, check', line === '0000 000101 0000000010199991 TESTERSON000 061234 8', line);
check('50 characters', line.length === 50);
check('7-digit account zero-filled to 16', buildScanline({ mgmt_code: '0000', association_code: '201' }, { accountNumber: '2019991', ownerName: 'Chris Validation', amountCents: 45678 }) === '0000 000201 0000000002019991 VALIDATION00 045678 9');
check('credit balance prints 000000, never a negative', / 000000 \d$/.test(buildScanline(NF, { accountNumber: '10199991', ownerName: 'A B', amountCents: -500 })));
check('amount over $9,999.99 cannot be encoded: no line', buildScanline(NF, { accountNumber: '10199991', ownerName: 'A B', amountCents: 1000000 }) === null);
check('no account: no line', buildScanline(NF, { accountNumber: '', ownerName: 'A B', amountCents: 100 }) === null);
check('no lockbox: no line (never a guessed one)', buildScanline(null, { accountNumber: '10199991', ownerName: 'A B', amountCents: 100 }) === null);

console.log('\nName field (first owner last name, letters only)');
check('"Brenda Example & Anastacio Example Jr." -> EXAMPLE', scanName('Brenda Example & Anastacio Example Jr.') === 'EXAMPLE');
check('"Gary & Linda Sample" -> SAMPLE (shared last name at the end)', scanName('Gary & Linda Sample') === 'SAMPLE');
check('"Richard Testman II" -> TESTMANII', scanName('Richard Testman II') === 'TESTMANII');
check('truncated to 12', scanName('Ann Abcdefghijklmnop') === 'ABCDEFGHIJKL');

console.log('\nWhich associations get a lockbox');
check('Waterview, Lakes of Pine Forest, Still Creek Ranch: verified NewFirst lockbox', ['Waterview Estates', 'Lakes of Pine Forest', 'Still Creek Ranch'].every((n) => lockboxFor(n) && /PO Box 1992/.test(lockboxFor(n).lines.join(' '))));
check('Canyon Gate is PROPOSED only: no production lockbox until NewFirst confirms', !lockboxFor('Canyon Gate at Cinco Ranch') && LOCKBOXES['Canyon Gate at Cinco Ranch'].proposed === true);
check('an association with no entry gets none (no copying another association)', lockboxFor('Quail Ridge') === null);
const r1 = remitTo({ name: 'Waterview Estates', hoa_legal_name: 'Waterview Estates Owners Association, Inc.' }, 'Waterview Estates Owners Association, Inc.');
check('remittance: verified lockbox first', /PO Box 1992/.test(r1.block) && r1.lockbox);
const r2 = remitTo({ name: 'Canyon Gate at Cinco Ranch' }, 'Canyon Gate at Cinco Ranch Owners Association, Inc.');
check('remittance: unconfirmed association falls back to the office, not a guessed lockbox', /1601 Industrial Blvd/.test(r2.block) && !r2.lockbox);

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall lockbox scanline checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
