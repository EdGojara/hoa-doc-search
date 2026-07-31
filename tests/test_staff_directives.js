// tests/test_staff_directives.js — Emma must EXECUTE a staffer's forwarding
// instructions (community / vendor / GL account), not re-guess. Locks the
// Water Logic #21245 fix: Celina wrote "code to 5125" and Emma guessed 5120.
// Pure functions, no DB. Run: node tests/test_staff_directives.js
const assert = require('assert');
const { parseStaffDirectives, matchGlDirective, matchCommunityDirective, matchVendorDirective } = require('../lib/ap/staff_directives');

const ACCOUNTS = [
  { id: 'a-5120', account_number: '5120', account_name: 'Water' },
  { id: 'a-5125', account_number: '5125', account_name: 'Irrigation Repair & Maintenance' },
  { id: 'a-5370', account_number: '5370', account_name: 'Splash Pad Repair & Maintenance' },
];
const COMMUNITIES = [
  { id: 'c-wv', name: 'Waterview Estates' },
  { id: 'c-cg', name: 'Canyon Gate at Cinco Ranch' },
  { id: 'c-eg', name: 'Eaglewood' },
];
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  -', name); } catch (e) { console.error('  FAIL -', name, '\n      ', e.message); process.exitCode = 1; } };

console.log('staff_directives:');

t('GL by number: "code to 5125" -> 5125 (not the 5120 guess)', () => {
  const g = matchGlDirective('please code to 5125 - Irrigation Repair & Maintenance', ACCOUNTS);
  assert.strictEqual(g && g.account_number, '5125');
  assert.strictEqual(g.matched_by, 'number');
});

t('GL by name: "code to Irrigation Repair & Maintenance" -> 5125', () => {
  const g = matchGlDirective('code this to Irrigation Repair & Maintenance please', ACCOUNTS);
  assert.strictEqual(g && g.account_number, '5125');
  assert.strictEqual(g.matched_by, 'name');
});

t('GL: a bare "water" must NOT snap to 5120 Water (single generic word)', () => {
  const g = matchGlDirective('this is the monthly water management fee', ACCOUNTS);
  assert.strictEqual(g, null);
});

t('GL: no account named -> null', () => {
  assert.strictEqual(matchGlDirective('please pay this invoice', ACCOUNTS), null);
});

t('Community: "for Waterview Estates" -> Waterview', () => {
  const c = matchCommunityDirective('Upload invoice for Waterview Estates, code to 5125', COMMUNITIES);
  assert.strictEqual(c && c.id, 'c-wv');
});

t('Vendor: "vendor is Waterlogic, inc" -> Waterlogic, inc', () => {
  assert.strictEqual(matchVendorDirective('vendor is Waterlogic, inc, please code to 5125'), 'Waterlogic, inc');
});

t('External sender: directives never apply (a vendor cannot direct its own coding)', () => {
  const d = parseStaffDirectives({ text: 'code to 5125 for Waterview Estates', accounts: ACCOUNTS, communities: COMMUNITIES, isStaffSender: false });
  assert.strictEqual(d.applies, false);
});

t('Full staff note parses all three directives', () => {
  const d = parseStaffDirectives({
    text: 'Upload invoice for Waterview Estates, vendor is Waterlogic, inc, please code to 5125 - Irrigation Repair & Maintenance',
    accounts: ACCOUNTS, communities: COMMUNITIES, isStaffSender: true,
  });
  assert.strictEqual(d.applies, true);
  assert.strictEqual(d.gl.account_number, '5125');
  assert.strictEqual(d.community.id, 'c-wv');
  assert.ok(/waterlogic/i.test(d.vendor_name));
});

t('Empty / no-directive staff note is safe (all null, no throw)', () => {
  const d = parseStaffDirectives({ text: 'Please see attached. Thanks!', accounts: ACCOUNTS, communities: COMMUNITIES, isStaffSender: true });
  assert.strictEqual(d.applies, true);
  assert.strictEqual(d.gl, null);
  assert.strictEqual(d.community, null);
});

console.log(`\n${pass} passed`);
