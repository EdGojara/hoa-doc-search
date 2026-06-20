// ============================================================================
// scripts/setup_quail_ridge_insurance_amortization.js
// ----------------------------------------------------------------------------
// Quail Ridge insurance prepaid schedule (prepaid_expense) through the unified
// recognition engine. The 2025 portion was booked in Vantaca (reflected in the
// corrected $1,673.01 opening); trustEd amortizes the remaining $1,673.01 over
// Jan-May 2026 at $334.61/mo, split D&O $129.00 / GL $75.50 / Other $130.11.
// Requires migration 235. --apply to write; dry-run otherwise.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { postDueRecognition } = require('../lib/accounting/recognition_engine');
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';

(async () => {
  const { data: doc } = await s.from('library_documents').select('id').eq('community_id', CID).ilike('file_name_normalized', '%Signed Renewal%').maybeSingle();
  const SCHEDULE = {
    community_id: CID, schedule_type: 'prepaid_expense',
    description: 'Insurance 2025-2026 policy year (06/19/2025-06/19/2026)',
    balance_account_number: '1400', source_document_id: doc ? doc.id : null,
    recognize_amount_cents: 167301, start_month: '2026-01-01', term_months: 5, monthly_amount_cents: 33461,
    period_start: '2025-06-19', period_end: '2026-06-19',
    notes: '2025 portion amortized in Vantaca (corrected $1,673.01 opening). trustEd amortizes the remainder.',
  };
  const SEGMENTS = [
    { income_account_number: '5605', label: 'Directors & Officers', monthly_amount_cents: 12900 },
    { income_account_number: '5610', label: 'General Liability', monthly_amount_cents: 7550 },
    { income_account_number: '5615', label: 'Other Premiums', monthly_amount_cents: 13011 },
  ];
  console.log(`${SCHEDULE.description}: amortize $${(SCHEDULE.recognize_amount_cents / 100).toFixed(2)} over ${SCHEDULE.term_months} mo from ${SCHEDULE.start_month}`);
  console.log('  ' + SEGMENTS.map((x) => x.income_account_number + ' $' + (x.monthly_amount_cents / 100).toFixed(2)).join(' + '));
  if (!APPLY) { console.log('\nDRY RUN — pass --apply (requires migration 235).'); return; }

  const { data: prior } = await s.from('recognition_schedules').select('id').eq('community_id', CID).eq('schedule_type', 'prepaid_expense').eq('balance_account_number', '1400');
  for (const p of prior || []) {
    const { data: posts } = await s.from('recognition_postings').select('journal_entry_id').eq('schedule_id', p.id);
    const jeIds = (posts || []).map((x) => x.journal_entry_id).filter(Boolean);
    if (jeIds.length) { await s.from('journal_entry_lines').delete().in('journal_entry_id', jeIds); await s.from('journal_entries').delete().in('id', jeIds); }
    await s.from('recognition_schedules').delete().eq('id', p.id);
  }
  const { data: sched, error: se } = await s.from('recognition_schedules').insert(SCHEDULE).select('id').single();
  if (se) { console.error('schedule insert failed:', se.message); process.exit(1); }
  await s.from('recognition_schedule_segments').insert(SEGMENTS.map((x) => ({ ...x, schedule_id: sched.id })));
  const results = await postDueRecognition({ supabase: s, communityId: CID, throughMonth: '2026-06-01' });
  results.forEach((r) => console.log('  ' + JSON.stringify(r)));
  const { data: tb } = await s.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', CID);
  const bal = (n) => { const a = tb.find((x) => x.account_number === n); return a ? Number(a.total_debits_cents) - Number(a.total_credits_cents) : 0; };
  const f = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  console.log(`\n1400 now ${f(bal('1400'))} (target $0 after May) | expense 5605 ${f(bal('5605'))} 5610 ${f(bal('5610'))} 5615 ${f(bal('5615'))}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
