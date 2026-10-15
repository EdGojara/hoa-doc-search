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
//   ... --all-open        re-decide EVERY open bill, not just unrouted ones (after
//                         a rule change, e.g. the 2026-10-15 same-kind-of-bill test)
//   ... --allow-downgrade also write manager_review -> release. Without it a
//                         downgrade is only printed (separately), never written:
//                         loosening a control is Ed's call, bill by bill.
// A bill held because its lines don't add up keeps its hold until its lines are
// corrected (they reconcile to the total with the STATED tax); then it is
// re-decided like any other bill.
// ============================================================================
require('dotenv').config({ override: true });
const { createClient } = require('@supabase/supabase-js');
const { decideApprovalPath } = require('../lib/ap/decide_path');

const WRITE = process.argv.includes('--write');
const ALL_OPEN = process.argv.includes('--all-open');
const ALLOW_DOWNGRADE = process.argv.includes('--allow-downgrade');
const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
const { reconcileLines, LINES_HOLD_MARK } = require('../lib/ap/line_reconcile');

// Pure: what to do with one bill, given its freshly decided route.
//   'skip_held'   still held: its lines still don't add up (strict, stated tax only)
//   'downgrade'   manager_review -> release; written only with --allow-downgrade
//   'write'       anything else (unrouted, tightened, or unchanged)
function planRow(inv, decided, { allowDowngrade = false } = {}) {
  if (String(inv.approval_path_reason || '').startsWith(LINES_HOLD_MARK)) {
    const r = reconcileLines({ lineCents: (inv.ap_invoice_lines || []).map((l) => l.amount_cents), totalCents: inv.total_cents, statedTaxCents: inv.tax_cents || 0 });
    if (!r.ok) return { action: 'skip_held', reason: r.message };
  }
  if (inv.approval_path === 'manager_review' && decided && decided.approval_path === 'release') return { action: 'downgrade', write: !!allowDowngrade };
  return { action: 'write', write: true };
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const probe = await supabase.from('ap_invoices').select('id, approval_path').limit(1);
  if (probe.error) {
    console.error('\n✗ Cannot read approval_path — migration 301 is not applied yet.');
    console.error('  Apply it in the Supabase SQL editor, record it (scripts/record_applied_migration.js), then re-run this.\n  (' + probe.error.message + ')\n');
    process.exitCode = 1;
    return;
  }

  let q = supabase.from('ap_invoices')
    .select('id, community_id, vendor_id, total_cents, tax_cents, account_number, status, posting_journal_entry_id, approval_path, approval_path_reason, vendors(name), communities(name), ap_invoice_lines(description, amount_cents)')
    .in('status', ['awaiting_approval', 'on_hold'])
    .order('id')
    .limit(1000);
  if (!ALL_OPEN) q = q.is('approval_path', null);
  const { data, error } = await q;
  if (error) throw error;
  if (!data || !data.length) { console.log('Nothing to backfill — every open bill already has a route.'); return; }

  console.log(`${data.length} open bill(s)${ALL_OPEN ? '' : ' with no approval route'}${WRITE ? '' : '  [DRY RUN — pass --write to apply]'}
`);
  let mgr = 0, rel = 0, failed = 0, held = 0;
  const downgrades = [];
  const line = (inv, row) => `${money(inv.total_cents).padStart(11)}  ${String((inv.vendors && inv.vendors.name) || '').slice(0, 26).padEnd(26)} ${String((inv.communities && inv.communities.name) || '').slice(0, 18).padEnd(18)} — ${row.approval_path_why}`;
  for (const inv of data) {
    const vendorName = (inv.vendors && inv.vendors.name) || null;
    let row;
    try {
      row = await decideApprovalPath({ vendorId: inv.vendor_id, vendorName, communityId: inv.community_id, totalCents: inv.total_cents,
        lines: inv.ap_invoice_lines || [], accountNumber: inv.account_number || null, excludeInvoiceId: inv.id, excludeJournalEntryId: inv.posting_journal_entry_id || null });
    } catch (e) { console.log(`  ✗ ${vendorName}: ${e.message}`); failed++; continue; }
    const plan = planRow(inv, row, { allowDowngrade: ALLOW_DOWNGRADE });
    if (plan.action === 'skip_held') { held++; continue; }
    if (plan.action === 'downgrade') { downgrades.push({ inv, row, write: plan.write }); if (!plan.write) continue; }
    else { row.approval_path === 'release' ? rel++ : mgr++; console.log(`  ${row.approval_path === 'release' ? '✅ release      ' : '👤 manager_review'}  ${line(inv, row)}`); }
    if (WRITE && plan.write) {
      const { error: uerr } = await supabase.from('ap_invoices').update(row).eq('id', inv.id);
      if (uerr) { console.log(`      ✗ write failed: ${uerr.message}`); failed++; }
    }
  }
  if (downgrades.length) {
    console.log(`
${downgrades.length} bill(s) would move manager_review -> release${ALLOW_DOWNGRADE ? '' : ' (NOT written; pass --allow-downgrade after review)'}:`);
    for (const d of downgrades) console.log(`  ⬇ ${line(d.inv, d.row)}`);
  }
  console.log(`
${WRITE ? 'Wrote' : 'Would write'}: ${mgr} manager_review, ${rel} release${ALLOW_DOWNGRADE ? `, ${downgrades.length} downgraded` : ''}${held ? `; ${held} still held (lines don't add up)` : ''}${failed ? `, ${failed} FAILED` : ''}.`);
  if (!WRITE) console.log('Re-run with --write to apply.');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { planRow };
