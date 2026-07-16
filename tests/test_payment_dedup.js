// ============================================================================
// tests/test_payment_dedup.js  (Ed 2026-07-16)
// ----------------------------------------------------------------------------
// The same payment must not hit the GL twice from two different emails.
//
// A North Mission Glen MUD auto-pay arrives as two notifications 3 days apart
// ("Auto-Pay Status", then "Auto-Pay Successfully Submitted"), same amount. The
// per-email idempotency (source_ref) doesn't catch them — different emails —
// so both would post and double-count the water bill. findSamePayment is the
// guard: same community + account + amount within a window is the same payment.
//
// This is money. The test uses whatever posted entry is already on the books as
// its fixture (not a hardcoded JE), so it isn't brittle, and asserts the three
// behaviours that matter: flags a near-date repeat, lets a next-cycle repeat
// through, ignores a different account.
//
// Run: npm run test:payment-dedup
// ============================================================================
require('dotenv').config({ override: true });

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
};

(async () => {
  console.log('\n\x1b[1mPayment dedup — the same payment can\'t post twice\x1b[0m\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('  (skipped — no DB creds)\n'); return; }

  const { createClient } = require('@supabase/supabase-js');
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { findSamePayment } = require('../lib/accounting/record_vendor_payment');

  // Grab any real posted debit line as the fixture.
  const { data: rows, error } = await s.from('journal_entry_lines')
    .select('account_id, debit_cents, journal_entries!inner(community_id, posting_date, status)')
    .gt('debit_cents', 0).eq('journal_entries.status', 'posted').limit(1);
  if (error) { failures++; console.log('  \x1b[31m✗ could not load a fixture entry: ' + error.message + '\x1b[0m'); }
  else if (!rows || !rows.length) { console.log('  (skipped — no posted entries to use as a fixture)'); }
  else {
    const f = rows[0];
    const je = f.journal_entries;
    const near = new Date(new Date(je.posting_date).getTime() + 2 * 86400000).toISOString().slice(0, 10);
    const far = new Date(new Date(je.posting_date).getTime() + 40 * 86400000).toISOString().slice(0, 10);
    const args = { communityId: je.community_id, acctId: f.account_id, amountCents: f.debit_cents };

    const hit = await findSamePayment({ ...args, postingDate: near, windowDays: 14 });
    check('a same account+amount payment 2 days later is flagged as the same', !!hit, `looked for ${f.debit_cents} on acct ${f.account_id} near ${near}`);

    const miss = await findSamePayment({ ...args, postingDate: far, windowDays: 14 });
    check('the same amount 40 days later is NOT flagged (real next-cycle payment)', !miss);

    const wrongAcct = await findSamePayment({ ...args, acctId: '00000000-0000-0000-0000-000000000000', postingDate: near, windowDays: 14 });
    check('the same amount on a different account is NOT flagged (different expense)', !wrongAcct);

    const badDate = await findSamePayment({ ...args, postingDate: 'not-a-date', windowDays: 14 });
    check('a malformed posting date returns null rather than throwing', badDate === null);
  }

  console.log('');
  if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
  else console.log('\x1b[32m\x1b[1m✓ Payment dedup: all checks passed.\x1b[0m\n');
})();
