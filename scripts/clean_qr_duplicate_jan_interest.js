// ============================================================================
// scripts/clean_qr_duplicate_jan_interest.js
// ----------------------------------------------------------------------------
// January 2026 interest ($1.81) was posted to Operating Cash TWICE in the
// Vantaca-migrated GL — once on 1/1 (JE-2026-D-20260101) and again at month-end
// on 1/30 (JE-2026-D-20260130, the legitimate posting) — then reversed on 2/11
// (JE-2026-D-20260211). Net effect self-corrected by February but left January
// cash overstated by $1.81 and a dangling reversal in February.
//
// Fix: remove the 1/1 duplicate cash + offsetting 4100 lines, and delete the
// 2/11 reversal entry (which contained only those two lines). The 1/30 posting
// (the real month-end interest, incl. the $0.38 savings line) is kept. Net
// change to the current cash balance is zero; January becomes correct.
//
// Audited the class ("GL Entry" cash postings): only January interest was
// double-posted — Feb–May each post once. Idempotent (finds nothing on re-run).
// Already applied 2026-06-21. --apply to run.
// ============================================================================
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const QR = 'a0000000-0000-4000-8000-000000000005';
const f = (c) => '$' + (Number(c || 0) / 100).toFixed(2);

(async () => {
  const { data: coa } = await s.from('chart_of_accounts').select('id').eq('community_id', QR).eq('account_number', '1000').single();

  // 1/1 duplicate: the "January Interest" cash + offsetting 4100 lines.
  const { data: je1 } = await s.from('journal_entries').select('id, total_debits_cents, total_credits_cents')
    .eq('community_id', QR).eq('reference', 'JE-2026-D-20260101').single();
  const { data: dup } = await s.from('journal_entry_lines').select('id, debit_cents, credit_cents, memo')
    .eq('journal_entry_id', je1.id).ilike('memo', '%January Interest%');

  // 2/11 reversal entry (only the two reversal lines).
  const { data: je2 } = await s.from('journal_entries').select('id').eq('community_id', QR).eq('reference', 'JE-2026-D-20260211').maybeSingle();

  console.log(`1/1 duplicate lines: ${dup ? dup.length : 0}; 2/11 reversal entry: ${je2 ? 'present' : 'absent'}`);
  if (!dup || !dup.length) { console.log('Nothing to clean (already applied).'); return; }
  if (!APPLY) { console.log('DRY RUN — pass --apply to remove the duplicate + reversal.'); return; }

  const deb = dup.reduce((a, l) => a + Number(l.debit_cents), 0);
  const cr = dup.reduce((a, l) => a + Number(l.credit_cents), 0);
  await s.from('journal_entry_lines').delete().in('id', dup.map((l) => l.id));
  await s.from('journal_entries').update({
    total_debits_cents: Number(je1.total_debits_cents) - deb,
    total_credits_cents: Number(je1.total_credits_cents) - cr,
  }).eq('id', je1.id);
  console.log(`Removed 1/1 duplicate (${dup.length} lines, ${f(deb)}).`);

  if (je2) {
    await s.from('journal_entry_lines').delete().eq('journal_entry_id', je2.id);
    await s.from('journal_entries').delete().eq('id', je2.id);
    console.log('Deleted 2/11 reversal entry.');
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
