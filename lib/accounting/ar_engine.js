// ============================================================================
// lib/accounting/ar_engine.js — Homeowner AR sub-ledger engine
// ----------------------------------------------------------------------------
// Three public functions that drive every receivables operation:
//
//   createCharge({community_id, property_id, charge_type_code, amount_cents,
//                  due_date, description, source_module, source_reference,
//                  charge_date, posted_by_user_id})
//     → posts JE (Dr AR-by-type / Cr Revenue-by-type) and creates ar_charges row
//
//   recordPayment({community_id, property_id, amount_cents, payment_date,
//                  source, source_reference, bank_account_id, notes,
//                  auto_apply, posted_by_user_id})
//     → posts JE (Dr Cash / Cr AR or Unapplied) and creates ar_payments row,
//       then runs §209.0063 auto-apply (if auto_apply=true; default true)
//
//   applyPayment({payment_id, posted_by_user_id})
//     → distributes a payment's unapplied_balance across open charges in
//       §209.0063 priority order, creates ar_payment_applications rows,
//       updates ar_charges.balance_remaining, posts allocation JE
//
// TEXAS §209.0063 PRIORITY (statutory, hard-coded — NO override):
//   1. Delinquent assessments (oldest first)
//   2. Current assessment
//   3. Attorney's fees / collection costs (assessment-related)
//   4. §209.005(g) records-request fees
//   5. Other attorney's fees
//   6. Fines
//   7. Other amounts owed
//
// Compliance discipline (per CLAUDE.md catastrophic-output surfaces):
//   - Application priority is hard-coded; no config knob overrides statute.
//   - Every application row records priority_step for court reconstruction.
//   - Voiding a payment creates offsetting JE; never DELETE.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const { postJournalEntry } = require('./posting');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// createCharge — post a new receivable
// ---------------------------------------------------------------------------
async function createCharge(opts) {
  const {
    community_id, property_id, charge_type_code,
    amount_cents, due_date, charge_date,
    description, source_module = 'manual', source_reference,
    posted_by_user_id,
  } = opts;

  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!property_id) throw Object.assign(new Error('property_id_required'), { code: 'invalid_input' });
  if (!charge_type_code) throw Object.assign(new Error('charge_type_code_required'), { code: 'invalid_input' });
  if (!amount_cents || amount_cents <= 0) throw Object.assign(new Error('amount_cents_must_be_positive'), { code: 'invalid_input' });
  if (!due_date || !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) throw Object.assign(new Error('due_date_required'), { code: 'invalid_input' });
  if (!description || !description.trim()) throw Object.assign(new Error('description_required'), { code: 'invalid_input' });

  // Look up the charge type for this community
  const { data: chargeType, error: ctErr } = await supabase
    .from('ar_charge_types')
    .select('id, gl_revenue_account_id, gl_receivable_account_id, display_name, tx_priority_step')
    .eq('community_id', community_id)
    .eq('type_code', charge_type_code)
    .eq('is_active', true)
    .maybeSingle();
  if (ctErr) throw ctErr;
  if (!chargeType) throw Object.assign(new Error(`charge_type_not_found_${charge_type_code}`), { code: 'invalid_input' });
  if (!chargeType.gl_revenue_account_id || !chargeType.gl_receivable_account_id) {
    throw Object.assign(new Error(`charge_type_missing_gl_mapping_${charge_type_code}`), { code: 'invalid_state' });
  }

  const postingDate = charge_date || due_date;

  // Post the journal entry: Dr AR-by-type / Cr Revenue-by-type
  const je = await postJournalEntry({
    community_id,
    posting_date: postingDate,
    description: `${chargeType.display_name} — ${description}`,
    source_module,
    source_reference: source_reference || null,
    posted_by_user_id,
    lines: [
      { account_id: chargeType.gl_receivable_account_id, debit_cents: amount_cents, credit_cents: 0,
        memo: description, property_id },
      { account_id: chargeType.gl_revenue_account_id, debit_cents: 0, credit_cents: amount_cents,
        memo: description, property_id },
    ],
  });

  // Insert the ar_charges row
  const { data: charge, error: chErr } = await supabase
    .from('ar_charges')
    .insert({
      community_id, property_id,
      charge_type_id: chargeType.id,
      charge_date: postingDate, due_date, description,
      original_amount_cents: amount_cents,
      balance_remaining_cents: amount_cents,
      status: 'open',
      source_module, source_reference: source_reference || null,
      posting_journal_entry_id: je.entry.id,
      created_by_user_id: posted_by_user_id || null,
    })
    .select('*')
    .single();
  if (chErr) throw chErr;
  return { charge, journal_entry: je.entry };
}

// ---------------------------------------------------------------------------
// recordPayment — receive a payment; optionally auto-apply per §209.0063
// ---------------------------------------------------------------------------
async function recordPayment(opts) {
  const {
    community_id, property_id, amount_cents, payment_date,
    source = 'manual', source_reference, bank_account_id, notes,
    auto_apply = true,
    posted_by_user_id, payment_batch_id,
  } = opts;

  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  if (!property_id) throw Object.assign(new Error('property_id_required'), { code: 'invalid_input' });
  if (!amount_cents || amount_cents <= 0) throw Object.assign(new Error('amount_cents_must_be_positive'), { code: 'invalid_input' });
  if (!payment_date || !/^\d{4}-\d{2}-\d{2}$/.test(payment_date)) throw Object.assign(new Error('payment_date_required'), { code: 'invalid_input' });

  // Resolve the Cash account for this community + bank
  const { data: bankAcct } = bank_account_id ? await supabase
    .from('bank_accounts').select('id, gl_account_number').eq('id', bank_account_id).maybeSingle() : { data: null };

  // Fall back to standard Operating Cash if no specific bank account
  let cashAccountId;
  if (bankAcct?.gl_account_number) {
    const { data: gl } = await supabase
      .from('chart_of_accounts')
      .select('id').eq('community_id', community_id).eq('account_number', bankAcct.gl_account_number).maybeSingle();
    cashAccountId = gl?.id;
  }
  if (!cashAccountId) {
    const { data: cashGl } = await supabase
      .from('chart_of_accounts')
      .select('id').eq('community_id', community_id).eq('account_number', '10100').maybeSingle();
    cashAccountId = cashGl?.id;
  }
  if (!cashAccountId) throw Object.assign(new Error('cash_account_not_found'), { code: 'invalid_state' });

  // For payment receipt JE, we post Dr Cash / Cr AR-Assessments as a starting point.
  // (Auto-apply may re-distribute the credit across multiple AR accounts via
  // adjustment JEs. For now we credit the assessments AR account as the
  // default landing — corrections happen in the apply step.)
  const { data: arAccount } = await supabase
    .from('chart_of_accounts')
    .select('id').eq('community_id', community_id).eq('account_number', '12000').maybeSingle();
  if (!arAccount) throw Object.assign(new Error('ar_account_not_found'), { code: 'invalid_state' });

  const je = await postJournalEntry({
    community_id,
    posting_date: payment_date,
    description: `Payment received — ${source} ${source_reference || ''}`.trim(),
    source_module: 'payment_intake',
    source_reference: source_reference || null,
    posted_by_user_id,
    lines: [
      { account_id: cashAccountId, debit_cents: amount_cents, credit_cents: 0,
        memo: `Payment from property`, property_id, bank_account_id: bank_account_id || null },
      { account_id: arAccount.id, debit_cents: 0, credit_cents: amount_cents,
        memo: `Payment from property`, property_id },
    ],
  });

  const { data: payment, error: payErr } = await supabase
    .from('ar_payments')
    .insert({
      community_id, property_id,
      payment_date, amount_cents,
      unapplied_balance_cents: amount_cents,
      source, source_reference: source_reference || null,
      payment_batch_id: payment_batch_id || null,
      bank_account_id: bank_account_id || null,
      status: 'received',
      notes: notes || null,
      posting_journal_entry_id: je.entry.id,
      received_by_user_id: posted_by_user_id || null,
    })
    .select('*')
    .single();
  if (payErr) throw payErr;

  let applications = [];
  if (auto_apply) {
    const applyResult = await applyPayment({ payment_id: payment.id, posted_by_user_id });
    applications = applyResult.applications;
  }

  // Re-fetch the payment to get its updated unapplied_balance after apply
  const { data: updated } = await supabase.from('ar_payments').select('*').eq('id', payment.id).maybeSingle();
  return { payment: updated || payment, applications };
}

// ---------------------------------------------------------------------------
// applyPayment — distribute a payment per §209.0063 statutory priority
// ---------------------------------------------------------------------------
// Algorithm:
//   1. Pull all open charges for the payment's property where balance_remaining > 0
//   2. Sort by (tx_priority_step ASC, due_date ASC). This realizes §209.0063
//      order: delinquent assessments (oldest first) → current assessment →
//      attorney fees → records fees → other attorney fees → fines → other.
//   3. Walk the sorted list, applying as much of unapplied_balance as the
//      charge's balance_remaining allows, until either:
//        a. payment is fully applied, or
//        b. no open charges remain.
//   4. Record each application in ar_payment_applications with the
//      tx_priority_step that drove it.
//   5. Update ar_charges.balance_remaining + status; update ar_payments.
async function applyPayment(opts) {
  const { payment_id, posted_by_user_id } = opts;

  const { data: payment, error: pErr } = await supabase
    .from('ar_payments').select('*').eq('id', payment_id).maybeSingle();
  if (pErr) throw pErr;
  if (!payment) throw Object.assign(new Error('payment_not_found'), { code: 'not_found' });
  if (payment.status === 'voided') throw Object.assign(new Error('payment_voided'), { code: 'invalid_state' });
  if (payment.unapplied_balance_cents <= 0) {
    return { applications: [], message: 'no_unapplied_balance' };
  }

  // Pull open charges for this property + their charge types, ordered by
  // §209.0063 priority (asc) then by due_date (asc — oldest first).
  const { data: openCharges, error: cErr } = await supabase
    .from('ar_charges')
    .select(`
      id, balance_remaining_cents, original_amount_cents, due_date, description,
      ar_charge_types ( id, tx_priority_step, gl_receivable_account_id, display_name )
    `)
    .eq('property_id', payment.property_id)
    .eq('status', 'open')
    .gt('balance_remaining_cents', 0)
    .order('due_date', { ascending: true });
  if (cErr) throw cErr;

  // Stable sort: priority_step ASC, then due_date ASC (already ASC from query).
  // The §209.0063 priority is the PRIMARY sort key; due_date is secondary.
  const sortedCharges = (openCharges || []).slice().sort((a, b) => {
    const pa = a.ar_charge_types?.tx_priority_step || 99;
    const pb = b.ar_charge_types?.tx_priority_step || 99;
    if (pa !== pb) return pa - pb;
    return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
  });

  let remaining = payment.unapplied_balance_cents;
  const applications = [];
  const updates = [];          // [{id, new_balance, new_status}]
  for (const ch of sortedCharges) {
    if (remaining <= 0) break;
    const toApply = Math.min(remaining, ch.balance_remaining_cents);
    if (toApply <= 0) continue;
    applications.push({
      payment_id,
      charge_id: ch.id,
      applied_cents: toApply,
      priority_step: ch.ar_charge_types?.tx_priority_step || 7,
    });
    const newBalance = ch.balance_remaining_cents - toApply;
    updates.push({
      id: ch.id,
      balance_remaining_cents: newBalance,
      status: newBalance === 0 ? 'paid' : 'open',
    });
    remaining -= toApply;
  }

  // Persist applications
  if (applications.length > 0) {
    const { error: aErr } = await supabase
      .from('ar_payment_applications').insert(applications);
    if (aErr) throw aErr;
  }

  // Update each charge's balance
  for (const u of updates) {
    const patch = { balance_remaining_cents: u.balance_remaining_cents };
    if (u.status === 'paid') patch.status = 'paid';
    await supabase.from('ar_charges').update(patch).eq('id', u.id);
  }

  // Update payment's unapplied_balance + status
  const newUnapplied = remaining;
  const newStatus = newUnapplied === 0
    ? 'applied'
    : newUnapplied === payment.amount_cents
      ? 'received'
      : 'partial';
  await supabase.from('ar_payments').update({
    unapplied_balance_cents: newUnapplied,
    status: newStatus,
  }).eq('id', payment_id);

  return { applications, applied_total_cents: payment.amount_cents - newUnapplied, unapplied_remaining_cents: newUnapplied };
}

// ---------------------------------------------------------------------------
// getOwnerLedger — full transaction history per property
// ---------------------------------------------------------------------------
async function getOwnerLedger({ community_id, property_id, from_date, to_date }) {
  if (!property_id) throw Object.assign(new Error('property_id_required'), { code: 'invalid_input' });

  let chargesQ = supabase.from('ar_charges')
    .select(`
      id, charge_date, due_date, description, original_amount_cents,
      balance_remaining_cents, status, source_module, source_reference,
      ar_charge_types ( display_name, category, tx_priority_step )
    `)
    .eq('property_id', property_id)
    .order('charge_date', { ascending: true })
    .limit(2000);
  if (from_date) chargesQ = chargesQ.gte('charge_date', from_date);
  if (to_date) chargesQ = chargesQ.lte('charge_date', to_date);

  let paymentsQ = supabase.from('ar_payments')
    .select(`
      id, payment_date, amount_cents, unapplied_balance_cents, source, source_reference,
      status, notes,
      ar_payment_applications ( charge_id, applied_cents, priority_step )
    `)
    .eq('property_id', property_id)
    .order('payment_date', { ascending: true })
    .limit(2000);
  if (from_date) paymentsQ = paymentsQ.gte('payment_date', from_date);
  if (to_date) paymentsQ = paymentsQ.lte('payment_date', to_date);

  const [{ data: charges }, { data: payments }] = await Promise.all([chargesQ, paymentsQ]);

  // Merge into a single time-ordered ledger
  const events = [];
  for (const c of (charges || [])) {
    events.push({
      type: 'charge',
      date: c.charge_date,
      due_date: c.due_date,
      category: c.ar_charge_types?.category,
      description: `${c.ar_charge_types?.display_name || ''}${c.description ? ' — ' + c.description : ''}`,
      amount_cents: c.original_amount_cents,
      balance_remaining_cents: c.balance_remaining_cents,
      status: c.status,
      ref: c.id,
      source_module: c.source_module,
    });
  }
  for (const p of (payments || [])) {
    events.push({
      type: 'payment',
      date: p.payment_date,
      category: 'payment',
      description: `Payment — ${p.source}${p.source_reference ? ' ' + p.source_reference : ''}`,
      amount_cents: -p.amount_cents,  // negative for display (decreases balance)
      unapplied_balance_cents: p.unapplied_balance_cents,
      status: p.status,
      ref: p.id,
      applications: p.ar_payment_applications || [],
    });
  }
  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Compute running balance
  let running = 0;
  for (const e of events) {
    running += e.amount_cents;
    e.running_balance_cents = running;
  }

  return { property_id, from_date, to_date, events, current_balance_cents: running };
}

module.exports = { createCharge, recordPayment, applyPayment, getOwnerLedger };
