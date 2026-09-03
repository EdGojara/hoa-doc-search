// ============================================================================
// test_mud_period_dedup.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// SCAR LOCK. Utility/MUD service periods are contiguous: each bill's period
// starts the day the previous one ended (Jun 2–Jul 2, then Jul 2–Aug 4). The
// dedup's period check used an INCLUSIVE compare, so the shared boundary day
// read as an overlap and EVERY month's new MUD bill was blocked as a "certain"
// duplicate of the prior month. Result: MUD bills systematically didn't file,
// staff kept chasing "Emma isn't processing the MUD invoices," and the $1 fee
// never landed because the invoice never landed.
//
// periodsOverlap is now half-open [start, end): a boundary touch is NOT an
// overlap; a real multi-day overlap (including two identical periods) still is.
// ============================================================================
const assert = require('assert');
const { periodsOverlap } = require('../lib/ap/dedup');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };

console.log('MUD contiguous-period dedup');
// The exact real case: June->July 2 vs July 2->Aug 4. Same account, DIFFERENT
// months. Must NOT be treated as overlapping (that blocked the September bill).
ok('contiguous months touching at the boundary do NOT overlap',
  periodsOverlap('2026-07-02', '2026-08-04', '2026-06-02', '2026-07-02') === false);
ok('the reverse order is also not an overlap',
  periodsOverlap('2026-06-02', '2026-07-02', '2026-07-02', '2026-08-04') === false);

console.log('\nGenuine duplicates still caught');
ok('two identical periods overlap',
  periodsOverlap('2026-07-02', '2026-08-04', '2026-07-02', '2026-08-04') === true);
ok('a multi-day overlap is an overlap',
  periodsOverlap('2026-07-02', '2026-08-04', '2026-07-15', '2026-08-20') === true);
ok('one period fully inside another overlaps',
  periodsOverlap('2026-07-01', '2026-08-31', '2026-07-10', '2026-07-20') === true);

console.log('\nMissing bounds make no overlap claim');
ok('a missing bound is never an overlap', periodsOverlap('2026-07-02', null, '2026-06-02', '2026-07-02') === false);

console.log('\n' + pass + ' passed');
