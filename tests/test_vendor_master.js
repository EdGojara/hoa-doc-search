// ============================================================================
// tests/test_vendor_master.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// The vendor master must stay dedup'd, or Emma can't name her own vendors.
//
// "Superior LawnCare" and "Superior LawnCare, LLC" were two records that
// normalise to the same name, so every Superior invoice hit two exact matches,
// came back name_ambiguous, dead-ended at needs_review, and piled up in Emma's
// queue while she told the vendor their bill wasn't on file. Ed: "merge
// duplicates and add missing vendors — remember emma is an AP professional she
// should do this."
//
// This is a data-integrity invariant, not a one-time cleanup: NO TWO ACTIVE
// vendors may collide under the resolver's own normaliser. If they do, some
// vendor's invoices silently stop filing. A test is the only thing that catches
// that the day an import re-introduces a duplicate.
//
// Read-only — asserts the live state, creates nothing. Run: npm run test:vendors
// ============================================================================
require('dotenv').config({ override: true });

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? '\n      ' + detail : ''}`); }
};

(async () => {
  console.log('\n\x1b[1mVendor master — no active duplicates\x1b[0m\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) { console.log('  (skipped — no DB creds)\n'); return; }

  const { createClient } = require('@supabase/supabase-js');
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { normName, resolveVendor } = require('../lib/ap/intake');
  const { dedupeVendorMaster } = require('../lib/ap/vendor_master');

  // 1) No two ACTIVE vendors collide under the resolver's normaliser. This is
  //    THE invariant — a collision means someone's invoices don't file.
  const { data: vendors, error } = await s.from('vendors')
    .select('name, is_active').eq('management_company_id', '00000000-0000-0000-0000-000000000001').neq('is_active', false);
  if (error) { failures++; console.log('  \x1b[31m✗ could not load vendors: ' + error.message + '\x1b[0m'); }
  else {
    const seen = {};
    const collisions = [];
    for (const v of vendors) { const k = normName(v.name); if (seen[k]) collisions.push(`${seen[k]} == ${v.name}`); else seen[k] = v.name; }
    check(`no two of the ${vendors.length} active vendors normalise to the same name`, collisions.length === 0, collisions.join('; '));
  }

  // 2) dedupe is idempotent — a dry run against the clean state finds nothing.
  const dry = await dedupeVendorMaster({ dryRun: true });
  check('dedupe finds nothing left to merge (idempotent)', !dry.error && dry.merged.length === 0,
    dry.error || dry.merged.map((m) => `${m.keep} <- ${m.drop}`).join('; '));

  // 3) The exact bug: a Superior LawnCare invoice resolves to ONE vendor now,
  //    whichever legal-name form the invoice happens to use.
  for (const form of ['Superior LawnCare', 'Superior LawnCare, LLC']) {
    const r = await resolveVendor({ name: form });
    check(`"${form}" resolves to exactly one vendor`, !!r.vendor, `method=${r.method}, candidates=${(r.candidates || []).length}`);
  }

  // 4) A deactivated duplicate must not resolve — that's what keeps the merge
  //    from unravelling.
  const { data: inactive } = await s.from('vendors').select('name').eq('is_active', false).limit(1);
  if (inactive && inactive.length) {
    const r = await resolveVendor({ name: inactive[0].name });
    // It should resolve to the ACTIVE survivor, never report the inactive dup as a match.
    check('a merged (inactive) duplicate does not surface as its own match',
      !r.candidates || !r.candidates.some((c) => c.name === inactive[0].name && c.is_active === false));
  }

  console.log('');
  if (failures) { console.log(`\x1b[31m\x1b[1m✗ ${failures} check(s) failed.\x1b[0m\n`); process.exitCode = 1; }
  else console.log('\x1b[32m\x1b[1m✓ Vendor master: all checks passed.\x1b[0m\n');
})();
