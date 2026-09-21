// ============================================================================
// tests/test_dependency_count.js
// ----------------------------------------------------------------------------
// Locks the invariant QUERY ERROR ≠ ZERO RESULTS for countRefs (the dependency
// verification primitive). A failed schema query (missing column / table) must
// THROW, never return 0. See lib/db/dependency_count.js for the scar.
// Run: node tests/test_dependency_count.js
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { countRefs } = require('../lib/db/dependency_count');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fails++; };

(async () => {
  try {
    // 1. A valid table+column returns a number (>= 0), never throws.
    const n = await countRefs(sb, 'properties', 'community_id', ['00000000-0000-0000-0000-000000000000']);
    ok(typeof n === 'number' && n >= 0, `valid query returns a number (got ${n})`);

    // 2. A non-existent column THROWS — it must NOT come back as 0.
    // (portal_user_properties has a composite PK and no `id` column — the exact
    //  scar shape.)
    let threw = false;
    try {
      await countRefs(sb, 'portal_user_properties', 'id', ['00000000-0000-0000-0000-000000000000']);
    } catch (e) { threw = true; }
    ok(threw, 'missing column (portal_user_properties.id) THROWS, not treated as 0 rows');

    // 3. A non-existent table THROWS too.
    let threw2 = false;
    try {
      await countRefs(sb, 'no_such_table_zzz', 'property_id', ['00000000-0000-0000-0000-000000000000']);
    } catch (e) { threw2 = true; }
    ok(threw2, 'missing table THROWS, not treated as 0 rows');

    // 4. Empty input short-circuits to 0 without a query.
    ok((await countRefs(sb, 'properties', 'id', [])) === 0, 'empty value list returns 0 without querying');
  } catch (e) {
    console.error('ERROR', e.message); fails++;
  }
  console.log(fails ? `\n✗ dependency-count: ${fails} failure(s)` : '\n✓ dependency-count: QUERY ERROR ≠ ZERO RESULTS invariant holds');
  process.exit(fails ? 1 : 0);
})();
