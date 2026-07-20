// ============================================================================
// tests/test_property_resolution.js  (Ed 2026-07-20)
// ----------------------------------------------------------------------------
// findProperty matches a typed/scanned address to a stored property, tolerating
// a missing or differing street suffix. The suffix map lists street-NAME words
// that double as suffixes ("meadow", "view", "ridge", "bend"), and the
// suffix-agnostic fallback wrongly stripped them off the TYPED side — so
// "19338 Stable Meadow" never matched "19338 Stable Meadow Drive" and staff
// couldn't add a pool fob (Ashley, 2026-07-20). This locks the fix and guards
// the "don't guess between two suffixes" rule.
// ============================================================================
const { findProperty } = require('../lib/entity_resolution');

// Minimal supabase mock: .from('properties').select(...).eq(...) -> {data,error}.
const mock = (candidates) => ({
  from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: candidates, error: null }) }) }),
});

const WV = [
  { id: 'p1', street_address: '19338 Stable Meadow Drive', unit: null, community_id: 'c1' },
  { id: 'p2', street_address: '19311 Stable Meadow Drive', unit: null, community_id: 'c1' },
  { id: 'p3', street_address: '4935 Ivory Meadows Lane', unit: null, community_id: 'c1' },
];

let failures = 0;
async function check(name, addr, candidates, wantId) {
  const m = await findProperty(mock(candidates), 'c1', addr);
  const got = m ? m.id : null;
  const ok = got === wantId;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name} — got ${got}, want ${wantId}`);
}

(async () => {
  console.log('\n\x1b[1mSuffix-agnostic address match (street-name word that doubles as a suffix)\x1b[0m');
  await check('"19338 Stable Meadow" -> Drive', '19338 stable meadow', WV, 'p1');       // the failing case
  await check('mixed case, no suffix', '19338 Stable Meadow', WV, 'p1');
  await check('exact with suffix', '19338 Stable Meadow Drive', WV, 'p1');
  await check('abbreviated suffix "dr"', '19338 stable meadow dr', WV, 'p1');
  await check('different house, no suffix', '19311 Stable Meadow', WV, 'p2');
  await check('"Ivory Meadows" (plural name) -> Lane', '4935 ivory meadows', WV, 'p3');

  console.log('\n\x1b[1mNever guess / no false match\x1b[0m');
  await check('unknown address -> null', '99999 nowhere', WV, null);
  // Two suffixes for the same house+street: refuse to guess.
  const ambiguous = [
    { id: 'a1', street_address: '100 Oak Meadow Drive', unit: null, community_id: 'c1' },
    { id: 'a2', street_address: '100 Oak Meadow Court', unit: null, community_id: 'c1' },
  ];
  await check('ambiguous suffix -> null (never guess)', '100 oak meadow', ambiguous, null);

  if (failures) { console.error(`\n\x1b[31m${failures} check(s) failed.\x1b[0m`); process.exit(1); }
  console.log('\n\x1b[32mAll property-resolution checks passed.\x1b[0m');
})();
