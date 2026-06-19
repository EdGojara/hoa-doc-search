// ============================================================================
// scripts/seed_quail_ridge_activity.js
// ----------------------------------------------------------------------------
// Minimal real activity on Quail Ridge's books to prove the GL <-> AR loop:
//   1. A June-2026 assessment run — one balanced journal entry (per-owner
//      receivable debits + a single assessment-income credit) plus an ar_charge
//      per property.
//   2. A handful of full payments — each a balanced JE (cash debit / receivable
//      credit), an ar_payment, an ar_payment_application (§209.0063 step 1), and
//      the charge marked paid.
// After it runs, the trial balance ties: Cash + Receivable = Assessment Income.
//
// Idempotent-by-guard: refuses to run if Quail Ridge already has journal
// entries, so it can never double-post. --assessment=<dollars> (default 125),
// --payers=<n> (default 8). Requires migration 231 grants.
// ============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const SLUG = 'quail-ridge';
const ASSESS_CENTS = Math.round(parseFloat(arg('assessment', '125')) * 100);
const N_PAYERS = parseInt(arg('payers', '8'), 10);
const POST_DATE = '2026-06-01';

(async () => {
  const { data: comm } = await s.from('communities').select('id, name').eq('slug', SLUG).single();
  const CID = comm.id;

  // Guard: never double-post.
  const { count: jeCount } = await s.from('journal_entries').select('id', { count: 'exact', head: true }).eq('community_id', CID);
  if (jeCount > 0) { console.log(`${comm.name} already has ${jeCount} journal entries — refusing to double-post. Done.`); return; }

  // Resolve accounts, charge type, period, properties.
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID);
  const acct = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const { data: ct } = await s.from('ar_charge_types').select('id, tx_priority_step').eq('community_id', CID).eq('type_code', 'assessment_regular').single();
  const { data: period } = await s.from('accounting_periods').select('id').eq('community_id', CID).eq('fiscal_year', 2026).eq('period_number', 6).single();
  let props = [], from = 0;
  while (true) { const { data } = await s.from('properties').select('id, street_address').eq('community_id', CID).range(from, from + 999); props.push(...data); if (data.length < 1000) break; from += 1000; }
  console.log(`${comm.name}: ${props.length} properties · assessment $${(ASSESS_CENTS/100).toFixed(2)} · ${N_PAYERS} payers`);

  // ---- 1) Assessment run: one balanced JE + a charge per property ----
  const total = props.length * ASSESS_CENTS;
  const { data: je1, error: je1Err } = await s.from('journal_entries').insert({
    community_id: CID, period_id: period.id, posting_date: POST_DATE,
    reference: 'JE-2026-0001', description: 'June 2026 monthly assessment billing',
    source_module: 'assessment_billing', total_debits_cents: total, total_credits_cents: total, status: 'posted',
  }).select('id').single();
  if (je1Err) { console.error('assessment JE failed:', je1Err.message); process.exit(1); }
  // lines: per-owner receivable debits + one income credit
  const lines = props.map((p, i) => ({
    journal_entry_id: je1.id, line_number: i + 1, account_id: acct['1200'],
    debit_cents: ASSESS_CENTS, credit_cents: 0, property_id: p.id, memo: 'June 2026 assessment',
  }));
  lines.push({ journal_entry_id: je1.id, line_number: props.length + 1, account_id: acct['4010'], debit_cents: 0, credit_cents: total, memo: 'June 2026 assessment income' });
  for (let i = 0; i < lines.length; i += 200) { const { error } = await s.from('journal_entry_lines').insert(lines.slice(i, i + 200)); if (error) { console.error('JE lines failed:', error.message); process.exit(1); } }

  // ar_charges (one per property), linked to the JE
  const charges = props.map((p) => ({
    community_id: CID, property_id: p.id, charge_type_id: ct.id, charge_date: POST_DATE, due_date: POST_DATE,
    description: 'June 2026 Regular Assessment', original_amount_cents: ASSESS_CENTS, balance_remaining_cents: ASSESS_CENTS,
    status: 'open', source_module: 'assessment_billing', posting_journal_entry_id: je1.id,
  }));
  const chargeIdByProp = {};
  for (let i = 0; i < charges.length; i += 200) {
    const { data, error } = await s.from('ar_charges').insert(charges.slice(i, i + 200)).select('id, property_id');
    if (error) { console.error('charges failed:', error.message); process.exit(1); }
    data.forEach((c) => { chargeIdByProp[c.property_id] = c.id; });
  }
  console.log(`  billed ${props.length} owners — JE-2026-0001 ($${(total/100).toLocaleString()}) DR Receivable / CR Income`);

  // ---- 2) Payments from the first N_PAYERS owners ----
  const payers = props.slice(0, N_PAYERS);
  let jeNum = 2;
  for (const p of payers) {
    const ref = `JE-2026-${String(jeNum).padStart(4, '0')}`; jeNum++;
    const { data: je } = await s.from('journal_entries').insert({
      community_id: CID, period_id: period.id, posting_date: POST_DATE, reference: ref,
      description: `Assessment payment — ${p.street_address || p.id.slice(0,8)}`,
      source_module: 'payment_intake', total_debits_cents: ASSESS_CENTS, total_credits_cents: ASSESS_CENTS, status: 'posted',
    }).select('id').single();
    await s.from('journal_entry_lines').insert([
      { journal_entry_id: je.id, line_number: 1, account_id: acct['1010'], debit_cents: ASSESS_CENTS, credit_cents: 0, memo: 'Assessment payment received' },
      { journal_entry_id: je.id, line_number: 2, account_id: acct['1200'], debit_cents: 0, credit_cents: ASSESS_CENTS, property_id: p.id, memo: 'Applied to June 2026 assessment' },
    ]);
    const { data: pay } = await s.from('ar_payments').insert({
      community_id: CID, property_id: p.id, payment_date: POST_DATE, amount_cents: ASSESS_CENTS, unapplied_balance_cents: 0,
      source: 'mailed_check', status: 'applied', posting_journal_entry_id: je.id,
    }).select('id').single();
    await s.from('ar_payment_applications').insert({
      payment_id: pay.id, charge_id: chargeIdByProp[p.id], applied_cents: ASSESS_CENTS, priority_step: ct.tx_priority_step,
    });
    await s.from('ar_charges').update({ balance_remaining_cents: 0, status: 'paid' }).eq('id', chargeIdByProp[p.id]);
  }
  console.log(`  ${N_PAYERS} owners paid in full — DR Cash / CR Receivable each`);

  // ---- 3) Verify the trial balance ties ----
  const { data: tb } = await s.from('v_trial_balance').select('*').eq('community_id', CID);
  console.log('\nTRIAL BALANCE (Quail Ridge):');
  console.log(JSON.stringify(tb, null, 2).slice(0, 1500));
})();
