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

// ---------------------------------------------------------------------------
// Issue #14 (2026-10-01): the SAME scar through a different door. NRG Waterview
// September (inv 302 008 342 079, service 8/16-9/15) was blocked as a "certain"
// duplicate of August (inv 302 008 234 841, service 7/16-8/18): a real 3-day
// overlap, same account, so rule 2b fired although the invoice numbers differ.
// Fort Bend MUD 143 had the same shape (8/5-9/2 vs 7/3-8/14). Two different,
// present invoice numbers are two different bills.
// ---------------------------------------------------------------------------
const { accountPeriodDuplicate } = require('../lib/ap/dedup');
console.log('\nAccount + period duplicate respects distinct invoice numbers');
const AUG_NRG = { account_number: '24 035 567 - 7', vendor_invoice_number: '302 008 234 841', service_period_start: '2026-07-16', service_period_end: '2026-08-18' };
ok('NRG Sept vs Aug: different invoice #s, overlapping periods -> NOT a duplicate',
  accountPeriodDuplicate({ invoiceNumber: '302 008 342 079', accountNumber: '240355677', servicePeriodStart: '2026-08-16', servicePeriodEnd: '2026-09-15' }, AUG_NRG) === false);
ok('Fort Bend MUD 143 Sept vs Aug: different invoice #s -> NOT a duplicate',
  accountPeriodDuplicate({ invoiceNumber: '30358920', accountNumber: '123285', servicePeriodStart: '2026-08-05', servicePeriodEnd: '2026-09-02' },
    { account_number: '123285', vendor_invoice_number: '29748558', service_period_start: '2026-07-03', service_period_end: '2026-08-14' }) === false);
ok('same account + overlapping period with NO invoice # on the new bill -> still a duplicate',
  accountPeriodDuplicate({ invoiceNumber: null, accountNumber: '240355677', servicePeriodStart: '2026-07-16', servicePeriodEnd: '2026-08-18' }, AUG_NRG) === true);
ok('same account + overlapping period, prior bill had no invoice # -> still a duplicate',
  accountPeriodDuplicate({ invoiceNumber: '302 008 342 079', accountNumber: '240355677', servicePeriodStart: '2026-08-01', servicePeriodEnd: '2026-08-30' }, { ...AUG_NRG, vendor_invoice_number: null }) === true);
ok('different account -> never', accountPeriodDuplicate({ invoiceNumber: null, accountNumber: '999', servicePeriodStart: '2026-07-16', servicePeriodEnd: '2026-08-18' }, AUG_NRG) === false);
ok('wiring: findDuplicates uses the helper for rule 2b',
  /if \(accountPeriodDuplicate\(\{ invoiceNumber, accountNumber, servicePeriodStart, servicePeriodEnd \}, inv\)\)/.test(require('fs').readFileSync(require.resolve('../lib/ap/dedup'), 'utf8')));
console.log('\n' + pass + ' passed (incl. Issue #14 distinct-invoice cases)');
