// tests/test_mailing_address_resolver.js — the ONE mailing-address resolver
// (lib/mail/mailing_address.js, migration 549) and a static guard that every
// mail-producing module asks it instead of reading the address columns itself.
//
// The scar: modules read different columns. Violation letters printed the
// one-line contacts.mailing_address; statements and collections notices built
// the block field by field from the structured columns, falling back to the
// property's city/ZIP one field at a time; two force-mow / self-help paths and
// the mail-vendor recipient printed the property address. One homeowner could
// get mail at three different addresses.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mailingAddressOf, addresseeOf, composeText, parseUSLine } = require('../lib/mail/mailing_address');
const { formatMailingLines } = require('../lib/mail/address_block');

let passed = 0; let failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '\n     ', e.message); } };
const LOT = { street_address: '100 Oak St', unit: null, city: 'Houston', state: 'TX', zip: '77001' };

console.log('mailing_address_resolver:');
check('structured address (staff-entered, with unit) -> unit on the street line, "City, ST ZIP" on one line', () => {
  const m = mailingAddressOf({ mailing_street: '9 Elm Rd', mailing_unit: 'Apt 4', mailing_city: 'Dallas', mailing_state: 'TX', mailing_zip: '75201', mailing_address: '9 Elm Rd Apt 4, Dallas, TX 75201', mailing_address_source: 'staff' }, LOT);
  assert.deepStrictEqual(m.lines, ['9 Elm Rd Apt 4', 'Dallas, TX 75201']);
  assert.strictEqual(m.source, 'contact'); assert.strictEqual(m.staff_entered, true); assert.strictEqual(m.complete, true);
});
check('a view row (owner_mailing_*) resolves the same as a contacts row', () => {
  const v = mailingAddressOf({ owner_mailing_street: '9 Elm Rd', owner_mailing_city: 'Dallas', owner_mailing_state: 'TX', owner_mailing_zip: '75201', owner_mailing_address: '9 Elm Rd, Dallas, TX 75201', street_address: '100 Oak St' }, LOT);
  assert.deepStrictEqual(v.lines, ['9 Elm Rd', 'Dallas, TX 75201']);
});
check('pre-549 deploy: unit column not selected, one-line text carries it -> the text wins, unit kept', () => {
  const m = mailingAddressOf({ owner_mailing_street: '9 Elm Rd', owner_mailing_city: 'Dallas', owner_mailing_state: 'TX', owner_mailing_zip: '75201', owner_mailing_address: '9 Elm Rd Apt 4, Dallas, TX 75201' }, LOT);
  assert.deepStrictEqual(m.lines, ['9 Elm Rd Apt 4', 'Dallas, TX 75201']);
  assert.strictEqual(m.zip, '75201');
});
check('legacy row where one-line and structured disagree -> the one-line address (what letters always printed)', () => {
  const m = mailingAddressOf({ mailing_street: '1 Old Rd', mailing_city: 'Houston', mailing_state: 'TX', mailing_zip: '77001', mailing_address: '5 New Ln, Katy, TX 77450' }, LOT);
  assert.strictEqual(m.source, 'contact_text');
  assert.deepStrictEqual(m.lines, ['5 New Ln', 'Katy, TX 77450']);
  assert.strictEqual(m.city, 'Katy');
});
check('one-line only -> parsed into street / city / state / ZIP', () => {
  const m = mailingAddressOf({ mailing_address: '5 Pine Ln, Suite 2, Austin, TX 78701' }, LOT);
  assert.strictEqual(m.street, '5 Pine Ln, Suite 2'); assert.strictEqual(m.city, 'Austin'); assert.strictEqual(m.zip, '78701');
  assert.deepStrictEqual(m.lines, ['5 Pine Ln', 'Suite 2', 'Austin, TX 78701']);
  assert.deepStrictEqual(parseUSLine('8 Cedar Ct, Sugar Land TX 77479'), { street: '8 Cedar Ct', city: 'Sugar Land', state: 'TX', zip: '77479' });
});
check('an unparseable one-line address stays as written and is marked incomplete (never swapped for the lot)', () => {
  const m = mailingAddressOf({ mailing_address: 'PO Box 9' }, LOT);
  assert.strictEqual(m.source, 'contact_text'); assert.deepStrictEqual(m.lines, ['PO Box 9']); assert.strictEqual(m.complete, false);
});
check('no mailing address -> the WHOLE property block, labelled property_fallback', () => {
  const m = mailingAddressOf({ owner_mailing_address: null, owner_mailing_street: null, owner_mailing_state: 'TX' }, { ...LOT, unit: '3' });
  assert.strictEqual(m.source, 'property_fallback');
  assert.deepStrictEqual(m.lines, ['100 Oak St #3', 'Houston, TX 77001']);
});
check('never mixes a mailing street with the property city / ZIP', () => {
  const m = mailingAddressOf({ owner_mailing_street: '9 Elm Rd', owner_mailing_city: null, owner_mailing_state: 'TX', owner_mailing_zip: null }, LOT);
  assert.ok(!m.text.includes('Houston') && !m.text.includes('77001'), m.text);
  assert.strictEqual(m.complete, false);
});
check('fallback can be turned off (display of "mailing" only)', () => {
  assert.strictEqual(mailingAddressOf({}, LOT, { allowPropertyFallback: false }).source, 'none');
});
check('foreign address -> one line per row ending in the country (same text the database composes)', () => {
  const m = mailingAddressOf({ mailing_street: '22 King St W', mailing_unit: 'Suite 500', mailing_city: 'Toronto', mailing_state: 'ON', mailing_zip: 'M5H 1A1', mailing_country: 'CA', mailing_address: '22 King St W Suite 500\nToronto ON M5H 1A1\nCA' });
  assert.strictEqual(m.source, 'contact');
  assert.deepStrictEqual(m.lines, ['22 King St W Suite 500', 'Toronto ON M5H 1A1', 'CA']);
});
check('composeText matches SQL mailing_address_compose for US and foreign', () => {
  assert.strictEqual(composeText({ street: '9 Elm Rd', unit: 'Apt 4', city: 'Dallas', state: 'TX', zip: '75201' }), '9 Elm Rd Apt 4, Dallas, TX 75201');
  assert.strictEqual(composeText({ street: '9 Elm Rd', city: 'Dallas', state: 'TX', zip: '75201', country: 'US' }), '9 Elm Rd, Dallas, TX 75201');
  assert.strictEqual(composeText({ street: '22 King St W', unit: 'Suite 500', city: 'Toronto', state: 'ON', zip: 'M5H 1A1', country: 'ca' }), '22 King St W Suite 500\nToronto ON M5H 1A1\nCA');
});
check('formatMailingLines (every letter renderer) delegates to the resolver, legacy owner shape included', () => {
  assert.deepStrictEqual(formatMailingLines({ mailing_address: '5 New Ln, Katy, TX 77450' }, LOT), ['5 New Ln', 'Katy, TX 77450']);
  assert.deepStrictEqual(formatMailingLines({ full_name: 'X' }, LOT), ['100 Oak St', 'Houston, TX 77001']);
  assert.deepStrictEqual(formatMailingLines({ mailing_address: { street: '9 Elm Rd', city: 'Dallas', state: 'TX', zip: '75201' } }, LOT), ['9 Elm Rd', 'Dallas, TX 75201']);
});
check('addresseeOf (statements, collections notices) -> street + cityline from one source', () => {
  const a = addresseeOf({ owner_mailing_street: '9 Elm Rd', owner_mailing_city: 'Dallas', owner_mailing_state: 'TX', owner_mailing_zip: '75201', owner_mailing_address: '9 Elm Rd, Dallas, TX 75201' }, LOT, 'Mary Owner');
  assert.deepStrictEqual(a, { name: 'Mary Owner', street: '9 Elm Rd', cityline: 'Dallas, TX 75201', source: 'contact' });
});

// ---- STATIC: mail modules go through the resolver ------------------------------
const ROOT = path.join(__dirname, '..');
const MAIL_MODULES = ['api/enforcement.js', 'api/inspections.js', 'lib/statements/assessment_statement.js', 'lib/collections/notices.js', 'lib/accounting/homeowner_statement.js',
  'lib/enforcement/violation_letter.js', 'lib/enforcement/postcard_reminder.js', 'lib/mail/address_block.js'];
check('STATIC: no mail module reads owner_mailing_* / mailing_address itself or builds a fallback from it', () => {
  const bad = [];
  for (const rel of MAIL_MODULES) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (/^\s*\/\//.test(l) || /\.select\(/.test(l)) return;
      if (/\.owner_mailing_(address|street|city|state|zip|unit|country)\b/.test(l) || /\bowner\.mailing_address\b/.test(l)) bad.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  assert.deepStrictEqual(bad, [], 'read the address through lib/mail/mailing_address.js instead:\n      ' + bad.join('\n      '));
});
check('STATIC: every homeowner names block in enforcement uses the resolver (not the lot address)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/enforcement.js'), 'utf8');
  const all = src.split(/\r?\n/);
  const blocks = all.map((l, i) => ({ l, near: all.slice(i, i + 4).join(' ') }))
    .filter(({ l }) => /homeowner_?[Nn]ames_?[Bb]lock\s*[:=]|homeownerBlock\s*=|_homeownerBlock\s*=/.test(l) && !/homeowner_names_block:\s+(homeownerBlock|_homeownerBlock|homeownerNamesBlock),?$/.test(l.trim()))
    .map(({ near }) => near);
  const offenders = blocks.filter((l) => !/mailingAddressOf\(/.test(l));
  assert.ok(blocks.length >= 4, `expected the homeowner blocks, found ${blocks.length}`);
  assert.deepStrictEqual(offenders, []);
});
check('STATIC: every view select that feeds the resolver asks only for pre-549 columns (safe to deploy before the migration)', () => {
  for (const rel of MAIL_MODULES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/select\([^)]*owner_mailing_(unit|country|source|updated_at)/.test(src), rel);
  }
});

console.log(`\nmailing_address_resolver: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
