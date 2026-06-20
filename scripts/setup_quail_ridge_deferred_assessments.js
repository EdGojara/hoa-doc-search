// ============================================================================
// scripts/setup_quail_ridge_deferred_assessments.js
// ----------------------------------------------------------------------------
// Defer Quail Ridge's 2026 annual assessment revenue and recognize it 1/12 per
// month — the GAAP treatment that was never done. The full annual assessment
// ($26,260) was recognized to income on 1/1; this:
//   1) Year-start DEFERRAL: Dr 4000 Assessment Income / Cr 2205 Unearned Income
//      $26,260 (move it off the P&L into the unearned liability).
//   2) Creates a deferred_revenue recognition schedule.
//   3) Recognizes monthly via the engine (Dr 2205 / Cr 4000, 1/12 each month).
//
// NOTE: uses account 2205 "Unearned Income" as the deferred-revenue liability —
// confirm this is the account you want (mirrors how 5605/5610/5615 were chosen
// for insurance). Requires migration 235. --apply to write.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { postDueRecognition } = require('../lib/accounting/recognition_engine');
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const REVENUE_ACCT = '4000';   // Current Year Assessment Income
const UNEARNED_ACCT = '2205';  // Unearned Income (deferred-revenue liability)
const f = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

(async () => {
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  if (!acctId[UNEARNED_ACCT] || !acctId[REVENUE_ACCT]) { console.error('Missing 4000 or 2205'); process.exit(1); }

  // Annual assessment = current recognized balance in 4000 (101 x $260 = $26,260).
  const { data: tb } = await s.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', CID);
  const bal = (n) => { const a = tb.find((x) => x.account_number === n); return a ? Number(a.total_debits_cents) - Number(a.total_credits_cents) : 0; };
  const annual = -bal(REVENUE_ACCT); // revenue is a credit balance -> positive annual
  const monthly = Math.round(annual / 12);
  console.log(`Annual assessment income (4000): ${f(annual)} -> defer to ${UNEARNED_ACCT}, recognize ${f(monthly)}/mo over 12.`);
  if (annual <= 0) { console.error('4000 has no assessment income to defer.'); process.exit(1); }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply (requires migration 235).'); return; }

  const { data: period1 } = await s.from('accounting_periods').select('id').eq('community_id', CID).eq('fiscal_year', 2026).eq('period_number', 1).maybeSingle();

  // idempotent: clear prior deferral JE + schedule (+ its recognition JEs)
  const { data: oldDef } = await s.from('journal_entries').select('id').eq('community_id', CID).eq('reference', 'JE-2026-ASMT-DEFER');
  for (const j of oldDef || []) { await s.from('journal_entry_lines').delete().eq('journal_entry_id', j.id); await s.from('journal_entries').delete().eq('id', j.id); }
  const { data: prior } = await s.from('recognition_schedules').select('id').eq('community_id', CID).eq('schedule_type', 'deferred_revenue');
  for (const p of prior || []) {
    const { data: posts } = await s.from('recognition_postings').select('journal_entry_id').eq('schedule_id', p.id);
    const jeIds = (posts || []).map((x) => x.journal_entry_id).filter(Boolean);
    if (jeIds.length) { await s.from('journal_entry_lines').delete().in('journal_entry_id', jeIds); await s.from('journal_entries').delete().in('id', jeIds); }
    await s.from('recognition_schedules').delete().eq('id', p.id);
  }

  // 1) year-start deferral entry
  const { data: defJe } = await s.from('journal_entries').insert({
    community_id: CID, period_id: period1 ? period1.id : null, posting_date: '2026-01-01',
    reference: 'JE-2026-ASMT-DEFER', description: '2026 annual assessment deferred to unearned (recognized 1/12 monthly)',
    source_module: 'system', total_debits_cents: annual, total_credits_cents: annual, status: 'posted',
  }).select('id').single();
  await s.from('journal_entry_lines').insert([
    { journal_entry_id: defJe.id, line_number: 1, account_id: acctId[REVENUE_ACCT], debit_cents: annual, credit_cents: 0, memo: 'Defer annual assessment to unearned' },
    { journal_entry_id: defJe.id, line_number: 2, account_id: acctId[UNEARNED_ACCT], debit_cents: 0, credit_cents: annual, memo: 'Unearned assessment revenue' },
  ]);
  console.log('Posted deferral JE-2026-ASMT-DEFER: Dr 4000 / Cr 2205 ' + f(annual));

  // 2) schedule + 3) recognize monthly
  const { data: sched } = await s.from('recognition_schedules').insert({
    community_id: CID, schedule_type: 'deferred_revenue', description: '2026 Annual Assessment revenue',
    balance_account_number: UNEARNED_ACCT, recognize_amount_cents: annual, start_month: '2026-01-01',
    term_months: 12, monthly_amount_cents: monthly, period_start: '2026-01-01', period_end: '2026-12-31',
    notes: 'Annual assessment recognized 1/12 per month.',
  }).select('id').single();
  await s.from('recognition_schedule_segments').insert([{ schedule_id: sched.id, income_account_number: REVENUE_ACCT, label: 'Assessment Income', monthly_amount_cents: monthly }]);
  const results = await postDueRecognition({ supabase: s, communityId: CID, throughMonth: '2026-06-01' });
  results.forEach((r) => console.log('  ' + JSON.stringify(r)));

  const { data: tb2 } = await s.from('v_trial_balance').select('account_number, total_debits_cents, total_credits_cents').eq('community_id', CID);
  const bal2 = (n) => { const a = tb2.find((x) => x.account_number === n); return a ? Number(a.total_debits_cents) - Number(a.total_credits_cents) : 0; };
  console.log(`\n4000 Assessment Income (recognized): ${f(-bal2('4000'))}  |  2205 Unearned (remaining): ${f(-bal2('2205'))}  (6 mo each ~${f(annual / 2)})`);
})().catch((e) => { console.error(e.message); process.exit(1); });
