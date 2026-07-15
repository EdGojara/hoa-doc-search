// ============================================================================
// scripts/backfill_ap_approval_path.js  (Ed 2026-07-15)
// ----------------------------------------------------------------------------
// Decide the approval route for bills that landed before migration 301, so the
// manager queue doesn't show every pre-existing bill as "never routed".
//
// The queue fails SAFE without this (no stored path => manager_review), so
// running it is about removing noise from the light-path bills, not about
// correctness. Idempotent: only touches rows with approval_path IS NULL.
//
//   node scripts/backfill_ap_approval_path.js          # dry run, prints the plan
//   node scripts/backfill_ap_approval_path.js --write   # actually writes
// ============================================================================
require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const { decideApprovalPath } = require('../lib/ap/decide_path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const WRITE = process.argv.includes('--write');
const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

(async () => {
  const probe = await supabase.from('ap_invoices').select('id, approval_path').limit(1);
  if (probe.error) {
    console.error('\n✗ Cannot read approval_path — migration 301 is not applied yet.');
    console.error('  Apply it via POST /api/admin/apply-migrations, then re-run this.\n  (' + probe.error.message + ')\n');
    process.exitCode = 1;
    return;
  }

  const { data, error } = await supabase.from('ap_invoices')
    .select('id, community_id, vendor_id, total_cents, status, vendors(name), communities(name)')
    .is('approval_path', null)
    .in('status', ['awaiting_approval', 'on_hold'])
    .limit(1000);
  if (error) throw error;
  if (!data || !data.length) { console.log('Nothing to backfill — every open bill already has a route.'); return; }

  console.log(`${data.length} open bill(s) with no approval route${WRITE ? '' : '  [DRY RUN — pass --write to apply]'}\n`);
  let mgr = 0, rel = 0, failed = 0;
  for (const inv of data) {
    const vendorName = (inv.vendors && inv.vendors.name) || null;
    let row;
    try {
      row = await decideApprovalPath({ vendorId: inv.vendor_id, vendorName, communityId: inv.community_id, totalCents: inv.total_cents });
    } catch (e) { console.log(`  ✗ ${vendorName}: ${e.message}`); failed++; continue; }
    row.approval_path === 'release' ? rel++ : mgr++;
    console.log(`  ${row.approval_path === 'release' ? '✅ release      ' : '👤 manager_review'}  ${money(inv.total_cents).padStart(11)}  ${String(vendorName || '').slice(0, 26).padEnd(26)} ${String((inv.communities && inv.communities.name) || '').slice(0, 18).padEnd(18)} — ${row.approval_path_why}`);
    if (WRITE) {
      const { error: uerr } = await supabase.from('ap_invoices').update(row).eq('id', inv.id);
      if (uerr) { console.log(`      ✗ write failed: ${uerr.message}`); failed++; }
    }
  }
  console.log(`\n${WRITE ? 'Wrote' : 'Would write'}: ${mgr} manager_review, ${rel} release${failed ? `, ${failed} FAILED` : ''}.`);
  if (!WRITE) console.log('Re-run with --write to apply.');
})().catch((e) => { console.error(e); process.exit(1); });
