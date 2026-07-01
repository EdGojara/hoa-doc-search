#!/usr/bin/env node
// ===========================================================================
// setup_august_meadows_native_ar.js  (Ed 2026-06-30)
// ---------------------------------------------------------------------------
// Phase 1 of the trustEd-account-number rollout (migration 252). August Meadows
// is the first NATIVE community (no Vantaca). This:
//   1. Assigns AM the visible 4-digit community code 1007 (from its community
//      sequence a0000000-...-0007).
//   2. Generates a discreet 10-digit trustEd account number for each of AM's
//      42 lots: 1007 + a random 6-digit suffix (unique; can't be tied back to
//      a property).
//   3. Posts the 42 builder assessments + the Providence Title payment, keyed
//      on trusted_account_number (vantaca_account_id null — allowed after 252).
//
// IDEMPOTENT: re-running won't re-number already-numbered lots or double-post
// the assessment (checks for the existing batch).
//
// Run AFTER migration 252 is applied. Requires SUPABASE_URL + SUPABASE_KEY.
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AM = 'a0000000-0000-4000-8000-000000000007';
const CODE = '1007';
const BATCH_LABEL = '2026 Builder Assessment - DRB 42-lot take-down';

function rand6() { return String(Math.floor(Math.random() * 1000000)).padStart(6, '0'); }

(async () => {
  // --- guard: migration 252 applied? ---
  const probe = await sb.from('properties').select('trusted_account_number').eq('community_id', AM).limit(1);
  if (probe.error && /trusted_account_number/.test(probe.error.message)) {
    console.error('Migration 252 not applied yet (trusted_account_number column missing). Apply it first.');
    process.exit(1);
  }

  // 1) community code
  await sb.from('communities').update({ account_code: CODE }).eq('id', AM);

  // 2) generate + assign trustEd numbers for lots that don't have one
  const { data: props } = await sb.from('properties').select('id, street_address, trusted_account_number').eq('community_id', AM).order('street_address');
  if ((props || []).length !== 42) { console.error(`expected 42 AM properties, got ${(props || []).length}`); process.exit(1); }

  // collect existing trustEd numbers globally to avoid collisions
  const used = new Set();
  for (let f = 0; ; f += 1000) {
    const { data } = await sb.from('properties').select('trusted_account_number').not('trusted_account_number', 'is', null).range(f, f + 999);
    if (!data || !data.length) break;
    data.forEach((r) => used.add(r.trusted_account_number));
    if (data.length < 1000) break;
  }

  let assigned = 0;
  for (const p of props) {
    if (p.trusted_account_number) continue;
    let num;
    do { num = CODE + rand6(); } while (used.has(num));
    used.add(num);
    const { error } = await sb.from('properties').update({ trusted_account_number: num }).eq('id', p.id);
    if (error) { console.error(`assign failed ${p.street_address}: ${error.message}`); process.exit(1); }
    p.trusted_account_number = num;
    assigned++;
  }
  console.log(`community code ${CODE}; assigned ${assigned} new trustEd numbers (42 total on AM lots)`);

  // 3) post the assessment (skip if already posted)
  const { data: existingBatch } = await sb.from('transaction_upload_batches').select('id').eq('community_id', AM).eq('period_label', BATCH_LABEL).maybeSingle();
  if (existingBatch) { console.log('assessment already posted (batch exists) — skipping post.'); printLots(props); return; }

  const now = new Date().toISOString();
  const { data: batch, error: bErr } = await sb.from('transaction_upload_batches').insert({
    management_company_id: '00000000-0000-0000-0000-000000000001', community_id: AM,
    period_label: BATCH_LABEL, as_of_date: '2026-05-26',
    source_filename: '0353_001.pdf (Providence Title chk #084284)', source_format: 'manual',
    row_count: 84, account_count: 42, total_charges_cents: 1031014, total_payments_cents: 1031014,
    status: 'committed', uploaded_by: 'manual_entry_claude', uploaded_at: now, committed_at: now,
    min_transaction_date: '2026-05-21', max_transaction_date: '2026-05-26',
    notes: 'Builder assessments for 42 DRB lots, $400/yr prorated from 2026-05-21 (224/365 = $245.48/lot), paid by Providence Title chk #084284.',
  }).select('id').single();
  if (bErr) { console.error('batch insert failed:', bErr.message); process.exit(1); }

  const rows = []; let idx = 0;
  props.forEach((p, i) => {
    const cents = (i >= 40) ? 24547 : 24548; // last 2 absorb the rounding so total = $10,310.14
    rows.push({ source_batch_id: batch.id, source_row_index: idx++, community_id: AM, vantaca_account_id: null, trusted_account_number: p.trusted_account_number, property_id: p.id, transaction_date: '2026-05-21', txn_type: 'charge', charge_category: 'assessment', description: '2026 Builder Assessment (prorated $400/yr from 2026-05-21)', amount_cents: cents, running_balance_cents: cents });
    rows.push({ source_batch_id: batch.id, source_row_index: idx++, community_id: AM, vantaca_account_id: null, trusted_account_number: p.trusted_account_number, property_id: p.id, transaction_date: '2026-05-26', txn_type: 'payment', charge_category: 'payment', description: 'Providence Title chk #084284 - builder assessment (42-lot AM take-down)', amount_cents: -cents, running_balance_cents: 0 });
  });
  const { data: ins, error } = await sb.from('homeowner_transactions').insert(rows).select('id');
  if (error) { console.error('transaction insert failed:', error.message); process.exit(1); }

  const chg = rows.filter((r) => r.txn_type === 'charge').reduce((s, r) => s + r.amount_cents, 0);
  const pay = rows.filter((r) => r.txn_type === 'payment').reduce((s, r) => s + r.amount_cents, 0);
  console.log(`posted ${ins.length} rows | charges $${(chg / 100).toFixed(2)} | payments $${(pay / 100).toFixed(2)} | net $${((chg + pay) / 100).toFixed(2)}`);
  printLots(props);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

function printLots(props) {
  console.log('\ntrustEd account numbers:');
  props.forEach((p) => console.log(`  ${p.trusted_account_number}  ${p.street_address}`));
}
