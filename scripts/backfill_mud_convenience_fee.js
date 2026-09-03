// ============================================================================
// scripts/backfill_mud_convenience_fee.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// Sweep the payables queue and add the $1 convenience fee to MUD invoices that
// are missing it — the ACH auto-draft bills where the bank pulls total + $1.
// Uses the SAME shared adjustment as the AP button (lib/ap/add_convenience_fee),
// so books stay in agreement (a supplemental $1 accrual when the bill is posted).
//
// Scope: vendors flagged is_mud, invoices NOT yet paid or voided, that don't
// already carry a convenience fee. Idempotent — safe to re-run.
//
//   node scripts/backfill_mud_convenience_fee.js --dry-run
//   node scripts/backfill_mud_convenience_fee.js
// ============================================================================
const fs = require('fs'), path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { createClient } = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const { addConvenienceFeeToInvoice } = require(path.join(__dirname, '..', 'lib', 'ap', 'add_convenience_fee'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const DRY = process.argv.includes('--dry-run');

(async () => {
  const { data: muds } = await supabase.from('vendors').select('id, name').eq('is_mud', true);
  const mudIds = (muds || []).map((v) => v.id);
  if (!mudIds.length) { console.log('No MUD vendors flagged.'); return; }

  const { data: invs, error } = await supabase.from('ap_invoices')
    .select('id, vendor_id, community_id, vendor_invoice_number, total_cents, amount_paid_cents, status, notes, is_ach_autopay, posting_journal_entry_id, communities:community_id(name)')
    .in('vendor_id', mudIds).not('status', 'in', '(paid,voided)').limit(1000);
  if (error) { console.error('read failed:', error.message); process.exit(1); }

  const needFee = (invs || []).filter((r) => !(r.notes && /convenience fee/i.test(r.notes)) && Number(r.amount_paid_cents || 0) === 0);
  console.log(`${(invs || []).length} open MUD invoice(s); ${needFee.length} missing the fee${DRY ? '  [DRY RUN]' : ''}\n`);

  let added = 0, skipped = 0, failed = 0;
  for (const r of needFee) {
    const label = `${(r.communities && r.communities.name) || '?'} | ${r.vendor_invoice_number || r.id.slice(0, 8)} | $${((r.total_cents || 0) / 100).toFixed(2)}${r.is_ach_autopay ? ' | ACH' : ''}${r.posting_journal_entry_id ? ' | posted' : ''}`;
    if (DRY) { console.log('  would add $1  ' + label); added++; continue; }
    const out = await addConvenienceFeeToInvoice(supabase, { invoiceId: r.id, by: 'backfill' });
    if (!out.ok) { console.log('  ! FAIL       ' + label + '  (' + out.error + ')'); failed++; }
    else if (out.already) { console.log('  already      ' + label); skipped++; }
    else { console.log('  added $' + ((out.fee || 100) / 100).toFixed(2) + (out.je_posted ? ' +JE' : out.je_warning ? ' (JE: ' + out.je_warning + ')' : '') + '  ' + label); added++; }
  }
  console.log(`\n${DRY ? 'would add' : 'added'} ${added}, skipped ${skipped}, failed ${failed}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
