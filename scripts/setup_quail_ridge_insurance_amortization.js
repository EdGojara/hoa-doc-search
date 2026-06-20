// ============================================================================
// scripts/setup_quail_ridge_insurance_amortization.js
// ----------------------------------------------------------------------------
// Create Quail Ridge's insurance prepaid schedule and post the 2026 monthly
// amortization through the engine — so trustEd matches Ed's corrected Vantaca
// books (5605/5610/5615 monthly, prepaid 1400 zeroing out).
//
// The 2025 portion was booked in Vantaca (reflected in the corrected $1,673.01
// opening). trustEd amortizes the remaining $1,673.01 over Jan–May 2026 at
// $334.61/mo, split D&O $129.00 / GL $75.50 / Other $130.11 — the exact split
// from Ed's December income statement.
//
// Requires migration 235. --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { postDueAmortization } = require('../lib/accounting/prepaid_amortization');
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';

(async () => {
  // Link to the archived insurance signed renewal, if present.
  const { data: doc } = await s.from('library_documents').select('id')
    .eq('community_id', CID).ilike('file_name_normalized', '%Signed Renewal%').maybeSingle();

  const SCHEDULE = {
    community_id: CID,
    description: 'Insurance 2025-2026 policy year (06/19/2025-06/19/2026)',
    prepaid_account_number: '1400',
    source_document_id: doc ? doc.id : null,
    amortize_amount_cents: 167301,        // $1,673.01 remaining at 1/1/2026
    amortize_start_month: '2026-01-01',
    term_months: 5,                        // Jan-May 2026
    monthly_amount_cents: 33461,           // $334.61/mo
    coverage_period_start: '2025-06-19',
    coverage_period_end: '2026-06-19',
    status: 'active',
    notes: '2025 portion amortized in Vantaca (in the corrected $1,673.01 opening). trustEd amortizes the remainder.',
  };
  const SEGMENTS = [
    { expense_account_number: '5605', label: 'Directors & Officers', monthly_amount_cents: 12900 },
    { expense_account_number: '5610', label: 'General Liability',     monthly_amount_cents: 7550 },
    { expense_account_number: '5615', label: 'Other Premiums',        monthly_amount_cents: 13011 },
  ];
  const segSum = SEGMENTS.reduce((a, x) => a + x.monthly_amount_cents, 0);
  console.log(`Schedule: ${SCHEDULE.description}`);
  console.log(`  amortize $${(SCHEDULE.amortize_amount_cents / 100).toFixed(2)} over ${SCHEDULE.term_months} months from ${SCHEDULE.amortize_start_month}`);
  console.log(`  segments: ${SEGMENTS.map((x) => x.expense_account_number + ' $' + (x.monthly_amount_cents / 100).toFixed(2)).join(' + ')} = $${(segSum / 100).toFixed(2)}/mo`);
  if (segSum !== SCHEDULE.monthly_amount_cents) console.warn('  WARN: segments != monthly_amount');

  if (!APPLY) { console.log('\nDRY RUN — pass --apply (requires migration 235).'); return; }

  // idempotent: clear any prior schedule for this prepaid+community (cascades segments + postings + their JEs handled below)
  const { data: prior } = await s.from('prepaid_schedules').select('id').eq('community_id', CID).eq('prepaid_account_number', '1400');
  for (const p of prior || []) {
    const { data: posts } = await s.from('prepaid_amortization_postings').select('journal_entry_id').eq('schedule_id', p.id);
    const jeIds = (posts || []).map((x) => x.journal_entry_id).filter(Boolean);
    if (jeIds.length) { await s.from('journal_entry_lines').delete().in('journal_entry_id', jeIds); await s.from('journal_entries').delete().in('id', jeIds); }
    await s.from('prepaid_schedules').delete().eq('id', p.id); // cascades segments + postings
  }

  const { data: sched, error: se } = await s.from('prepaid_schedules').insert(SCHEDULE).select('id').single();
  if (se) { console.error('schedule insert failed:', se.message); process.exit(1); }
  await s.from('prepaid_schedule_segments').insert(SEGMENTS.map((x) => ({ ...x, schedule_id: sched.id })));
  console.log('\nSchedule + segments created. Posting amortization through 2026-06...');

  const results = await postDueAmortization({ supabase: s, communityId: CID, throughMonth: '2026-06-01' });
  results.forEach((r) => console.log('  ' + JSON.stringify(r)));

  // verify prepaid drawn down + expense booked
  const { data: tb } = await s.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', CID);
  const bal = (n) => { const a = tb.find((x) => x.account_number === n); return a ? Number(a.total_debits_cents) - Number(a.total_credits_cents) : 0; };
  const f = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  console.log(`\n1400 Prepaid Insurance now: ${f(bal('1400'))} (target $0.00 after May)`);
  console.log(`Insurance expense: 5605 ${f(bal('5605'))}  5610 ${f(bal('5610'))}  5615 ${f(bal('5615'))}  = ${f(bal('5605') + bal('5610') + bal('5615'))}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
