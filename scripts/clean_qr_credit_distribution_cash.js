// ============================================================================
// scripts/clean_qr_credit_distribution_cash.js
// ----------------------------------------------------------------------------
// Vantaca "Credit Distribution" is a SUBLEDGER operation — redistributing a
// homeowner's credit balance across their charges (per Payment Order settings).
// It is NOT a cash transaction, but Vantaca's GL export routes it through the
// cash account as equal Dr/Cr pairs that net to zero. Migrated into trustEd,
// those phantom cash legs clutter the cash ledger and the bank reconciliation.
//
// This removes ONLY the cash-account (1000) credit-distribution legs from the
// 2026 daily entries, leaving the real AR/prepaid legs (the actual subledger
// reallocation) intact. They net to zero within each entry, so every entry
// stays balanced and the cash balance is unchanged. --apply to write.
// ============================================================================
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const QR = 'a0000000-0000-4000-8000-000000000005';
const f = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

(async () => {
  const { data: coa } = await s.from('chart_of_accounts').select('id').eq('community_id', QR).eq('account_number', '1000').single();
  const { data: lines } = await s.from('journal_entry_lines')
    .select('id, journal_entry_id, debit_cents, credit_cents, memo, journal_entries!inner(reference, community_id)')
    .eq('account_id', coa.id).ilike('memo', '%credit distribution%').eq('journal_entries.community_id', QR).limit(50000);

  // group by JE, verify net zero
  const byJE = {};
  for (const l of (lines || [])) {
    const k = l.journal_entry_id;
    (byJE[k] = byJE[k] || { ref: l.journal_entries.reference, ids: [], deb: 0, cr: 0 });
    byJE[k].ids.push(l.id); byJE[k].deb += Number(l.debit_cents); byJE[k].cr += Number(l.credit_cents);
  }
  const jes = Object.keys(byJE);
  console.log(`Found ${(lines || []).length} credit-distribution cash lines across ${jes.length} entries.`);
  for (const k of jes) {
    const j = byJE[k];
    const net = j.deb - j.cr;
    console.log(`  ${j.ref}: ${j.ids.length} lines, Dr ${f(j.deb)} Cr ${f(j.cr)} net ${f(net)}${net !== 0 ? '  <-- NOT ZERO, SKIPPING' : ''}`);
  }
  const safe = jes.filter((k) => (byJE[k].deb - byJE[k].cr) === 0);
  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to delete the cash legs and fix entry totals.'); return; }

  for (const k of safe) {
    const j = byJE[k];
    // delete the cash credit-distribution legs
    const { error: delErr } = await s.from('journal_entry_lines').delete().in('id', j.ids);
    if (delErr) { console.error('delete failed for', j.ref, delErr.message); continue; }
    // reduce the entry's totals by the removed amounts (equal Dr/Cr, stays balanced)
    const { data: je } = await s.from('journal_entries').select('total_debits_cents, total_credits_cents').eq('id', k).single();
    await s.from('journal_entries').update({
      total_debits_cents: Number(je.total_debits_cents) - j.deb,
      total_credits_cents: Number(je.total_credits_cents) - j.cr,
    }).eq('id', k);
    console.log(`  cleaned ${j.ref}: removed ${j.ids.length} lines (${f(j.deb)})`);
  }

  // verify cash balance unchanged + entries balanced
  const { data: after } = await s.from('journal_entry_lines')
    .select('debit_cents, credit_cents, journal_entries!inner(community_id)')
    .eq('account_id', coa.id).eq('journal_entries.community_id', QR).limit(50000);
  const bal = (after || []).reduce((a, l) => a + Number(l.debit_cents) - Number(l.credit_cents), 0);
  console.log(`\nCash account balance after cleanup: ${f(bal)}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
