#!/usr/bin/env node
// ============================================================================
// tests/test_owners_overview.js  (Issue #6, Owners slice)
// ----------------------------------------------------------------------------
// Locks lib/owners/overview.js:
//   - search input: trimmed, 2–80 chars, LIKE wildcards escaped (a literal "%"
//     or "_" can't match everything);
//   - search results carry NO email / phone / mailing fields, dedupe by
//     property, sorted by owner name;
//   - failed reads → problem + null (unknown) counts, never 0;
//   - no-owner = properties minus distinct properties with a current owner;
//   - legal / collections come from property_enforcement_states (open rows);
//   - owner collapse uses the npm-test guard's rule (non-corporate, 8+);
//   - leaving / prospect communities listed apart, not in totals.
// Offline and deterministic.
// ============================================================================
const assert = require('assert');
const { escapeLike, normalizeQuery, mergeResults, evaluateOwners } = require('../lib/owners/overview');
const { THRESHOLD } = require('../lib/owners/concentration');

let pass = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n       ', e.message); process.exitCode = 1; }
}
const ok = (value) => ({ ok: true, value });
const comms = [
  { id: 'a', name: 'Alpha', management_status: 'active' },
  { id: 'b', name: 'Beta', management_status: 'active' },
  { id: 'l', name: 'Leaving', management_status: 'terminating', management_end_date: '2026-09-30' },
];
const facts = (over) => Object.assign({
  propertyCounts: ok({ a: 3, b: 2, l: 4 }),
  owners: ok([
    { property_id: 'a1', community_id: 'a', owner_contact_id: 'c1', owner_name: 'Ann' },
    { property_id: 'a1', community_id: 'a', owner_contact_id: 'c2', owner_name: 'Al' }, // co-owner, same property
    { property_id: 'a2', community_id: 'a', owner_contact_id: 'c3', owner_name: 'Bo' },
    { property_id: 'a3', community_id: 'a', owner_contact_id: null, owner_name: null },
    { property_id: 'b1', community_id: 'b', owner_contact_id: 'c4', owner_name: 'Cy' },
    { property_id: 'b2', community_id: 'b', owner_contact_id: 'c5', owner_name: 'Di' },
  ]),
  legal: ok([{ community_id: 'a', state: 'at_legal' }, { community_id: 'b', state: 'in_collections' }, { community_id: 'l', state: 'at_legal' }]),
  collections: ok([{ community_id: 'a', collection_status: 'foreclosure' }, { community_id: 'a', collection_status: 'bankruptcy' }, { community_id: 'a', collection_status: 'foreclosure' }]),
  proposals: ok([{ community_id: 'b', age_days: 3 }]),
}, over);
const row = (r, name) => r.managed.concat(r.other).find((x) => x.community.name === name);

console.log('test_owners_overview');

t('search input: trim, length bounds, wildcard escaping', () => {
  assert.strictEqual(normalizeQuery(' x '), null);
  assert.strictEqual(normalizeQuery('  tahoe   canyon '), 'tahoe canyon');
  assert.strictEqual(normalizeQuery('a'.repeat(81)), null);
  assert.strictEqual(escapeLike('100%_a\\b'), '100\\%\\_a\\\\b');
});

t('search results: no contact PII, dedupe by property, sorted by name', () => {
  const names = new Map([['a', 'Alpha']]);
  const rows = mergeResults([
    [{ property_id: 'p2', community_id: 'a', owner_name: 'Zed', street_address: '2 Oak', owner_email: 'z@x.com', owner_phone: '555', owner_mailing_address: 'PO 1' }],
    [{ property_id: 'p1', community_id: 'a', owner_name: 'Amy', street_address: '1 Oak' }, { property_id: 'p2', community_id: 'a', owner_name: 'Zed' }],
  ], names, 40);
  assert.deepStrictEqual(rows.map((r) => r.property_id), ['p1', 'p2']);
  for (const r of rows) for (const k of ['owner_email', 'owner_phone', 'owner_mailing_address', 'email', 'phone']) assert.ok(!(k in r), 'leaked ' + k);
  assert.strictEqual(rows[0].community, 'Alpha');
});

t('no-owner counts distinct owned properties (co-owners count once)', () => {
  const r = evaluateOwners(comms, facts());
  assert.strictEqual(row(r, 'Alpha').no_owner, 1);
  assert.strictEqual(row(r, 'Beta').no_owner, 0);
});

t('legal and collections from open enforcement states; statuses grouped worst first', () => {
  const r = evaluateOwners(comms, facts());
  assert.strictEqual(row(r, 'Alpha').at_legal, 1);
  assert.strictEqual(row(r, 'Beta').in_collections, 1);
  assert.deepStrictEqual(row(r, 'Alpha').collections, [{ status: 'bankruptcy', count: 1 }, { status: 'foreclosure', count: 2 }]);
});

t('failed read → problem and null counts, never zero', () => {
  const r = evaluateOwners(comms, facts({ legal: { ok: false, error: 'timeout' } }));
  assert.ok(r.problems.some((p) => p.key === 'legal'));
  assert.strictEqual(row(r, 'Alpha').at_legal, null);
  assert.strictEqual(r.totals.at_legal, null, 'totals unknown when a source failed');
});

t('leaving community listed apart and kept out of totals', () => {
  const r = evaluateOwners(comms, facts());
  assert.ok(r.other.some((x) => x.community.name === 'Leaving'));
  assert.strictEqual(r.totals.at_legal, 1, 'leaving community legal case not counted');
  assert.strictEqual(r.totals.properties, 5);
});

t('owner collapse: non-corporate contact with 8+ properties flagged; corporate names are not', () => {
  const many = (contact, name) => Array.from({ length: THRESHOLD }, (_, i) => ({ property_id: contact + i, community_id: 'a', owner_contact_id: contact, owner_name: name }));
  const r = evaluateOwners(comms, facts({ owners: ok(many('x', 'Jane Smith').concat(many('y', 'Lennar Homes of Texas LLC'))) }));
  assert.deepStrictEqual(r.collapse.map((c) => c.name), ['Jane Smith']);
  assert.strictEqual(r.collapse[0].properties, THRESHOLD);
});

t('owner collapse unknown (null) when owners failed to load', () => {
  const r = evaluateOwners(comms, facts({ owners: { ok: false, error: 'x' } }));
  assert.strictEqual(r.collapse, null);
});

console.log(`\n${pass} passed${process.exitCode ? ', FAILURES above' : ''}`);
