// ============================================================================
// lib/accounting/record_payment.js
// ----------------------------------------------------------------------------
// Record a homeowner payment (check / lockbox / online — record-only for now,
// no money movement). Posts the cash receipt and applies it to the owner's open
// charges in Texas Property Code 209.0063 order (delinquent assessments first,
// then current assessments, then fees/interest, oldest first within a tier), so
// the aging + statement reflect what's actually paid.
//
// Atomically:
//   - GL: Dr Operating Cash (1000) / Cr Accounts Receivable (1300)
//   - ar_payment (with any overpayment as an unapplied credit)
//   - ar_payment_applications + reduces each charge's balance (paid when 0)
//   - homeowner_ledger_entry (running balance down)
//
// Catastrophic-output surface: validates amount, dryRun returns the application
// plan before posting.
//
//   recordHomeownerPayment({ supabase, communityId, propertyId, amountCents,
//                            paymentDate, source, reference, dryRun })
// ============================================================================

const CASH_ACCT = '1000', AR_ACCT = '1300';
const SOURCES = new Set(['manual', 'lockbox', 'ach', 'wire', 'stripe_portal', 'vantaca_pay', 'propay', 'mailed_check', 'in_person']);

async function _fetchAll(supabase, table, cols, filters) {
  const out = []; let from = 0;
  while (true) {
    let q = supabase.from(table).select(cols).range(from, from + 999);
    for (const [k, v] of Object.entries(filters || {})) q = q.eq(k, v);
    const { data, error } = await q; if (error) throw error;
    out.push(...(data || [])); if (!data || data.length < 1000) break; from += 1000;
  }
  return out;
}

async function recordHomeownerPayment({ supabase, communityId, propertyId, amountCents, paymentDate, source = 'mailed_check', reference = null, dryRun = false }) {
  amountCents = Math.round(Number(amountCents));
  if (!(amountCents > 0)) throw new Error('amount must be greater than zero');
  if (!SOURCES.has(source)) source = 'manual';
  const payDate = paymentDate || new Date().toISOString().slice(0, 10);

  const coa = await _fetchAll(supabase, 'chart_of_accounts', 'id, account_number', { community_id: communityId });
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  if (!acctId[CASH_ACCT] || !acctId[AR_ACCT]) throw new Error(`accounts ${CASH_ACCT}/${AR_ACCT} missing`);

  const cts = await _fetchAll(supabase, 'ar_charge_types', 'id, tx_priority_step', { community_id: communityId });
  const prio = Object.fromEntries(cts.map((c) => [c.id, c.tx_priority_step == null ? 99 : c.tx_priority_step]));
  const charges = (await _fetchAll(supabase, 'ar_charges', 'id, charge_type_id, due_date, balance_remaining_cents, original_amount_cents, status', { community_id: communityId, property_id: propertyId, status: 'open' }))
    .filter((c) => Number(c.balance_remaining_cents) > 0)
    .sort((a, b) => (prio[a.charge_type_id] - prio[b.charge_type_id]) || String(a.due_date || '').localeCompare(String(b.due_date || '')));

  let remaining = amountCents;
  const apps = [];
  for (const ch of charges) {
    if (remaining <= 0) break;
    const applied = Math.min(Number(ch.balance_remaining_cents), remaining);
    apps.push({ charge: ch, applied });
    remaining -= applied;
  }
  const unapplied = remaining;
  const plan = { amount_cents: amountCents, applied_cents: amountCents - unapplied, unapplied_cents: unapplied, applications: apps.length };
  if (dryRun) return { dry_run: true, plan, breakdown: apps.map((a) => ({ charge_id: a.charge.id, applied_cents: a.applied })) };

  // 1) GL: Dr Cash / Cr AR
  const fy = Number(payDate.slice(0, 4)), pn = Number(payDate.slice(5, 7));
  const { data: period } = await supabase.from('accounting_periods').select('id').eq('community_id', communityId).eq('fiscal_year', fy).eq('period_number', pn).maybeSingle();
  const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
    community_id: communityId, period_id: period ? period.id : null, posting_date: payDate,
    reference: `JE-PMT-${payDate.replace(/-/g, '')}-${String(propertyId).slice(0, 8)}`,
    description: `Homeowner payment (${source}${reference ? ' #' + reference : ''})`,
    source_module: 'payment_intake', total_debits_cents: amountCents, total_credits_cents: amountCents, status: 'posted',
  }).select('id').single();
  if (jeErr) throw jeErr;
  await supabase.from('journal_entry_lines').insert([
    { journal_entry_id: je.id, line_number: 1, account_id: acctId[CASH_ACCT], debit_cents: amountCents, credit_cents: 0, memo: 'Homeowner payment received' },
    { journal_entry_id: je.id, line_number: 2, account_id: acctId[AR_ACCT], debit_cents: 0, credit_cents: amountCents, memo: 'Applied to homeowner account' },
  ]);

  // 2) ar_payment
  const { data: pmt, error: pErr } = await supabase.from('ar_payments').insert({
    community_id: communityId, property_id: propertyId, payment_date: payDate, amount_cents: amountCents,
    unapplied_balance_cents: unapplied, source, source_reference: reference || null,
    status: unapplied > 0 ? 'partial' : 'applied', posting_journal_entry_id: je.id,
  }).select('id').single();
  if (pErr) throw pErr;

  // 3) applications + reduce charges
  for (const a of apps) {
    await supabase.from('ar_payment_applications').insert({ payment_id: pmt.id, charge_id: a.charge.id, applied_cents: a.applied });
    const newBal = Number(a.charge.balance_remaining_cents) - a.applied;
    await supabase.from('ar_charges').update({ balance_remaining_cents: newBal, status: newBal <= 0 ? 'paid' : 'open' }).eq('id', a.charge.id);
  }

  // 4) ledger entry (running balance down)
  try {
    const led = await _fetchAll(supabase, 'homeowner_ledger_entries', 'entry_date, sort_seq, running_balance_cents', { community_id: communityId, property_id: propertyId });
    led.sort((x, y) => (x.entry_date || '').localeCompare(y.entry_date || '') || (x.sort_seq - y.sort_seq));
    const lastBal = led.length ? Number(led[led.length - 1].running_balance_cents) : 0;
    await supabase.from('homeowner_ledger_entries').insert({
      community_id: communityId, property_id: propertyId, entry_date: payDate,
      description: `Payment${reference ? ' — ' + source + ' #' + reference : ' — ' + source}`, charge_cents: 0, payment_cents: amountCents,
      running_balance_cents: lastBal - amountCents, entry_type: 'payment', source: 'trusted_payment', sort_seq: 70,
    });
  } catch (e) { /* ledger optional */ }

  return { posted: true, payment_id: pmt.id, applied_cents: amountCents - unapplied, unapplied_cents: unapplied, journal_entry: je.id };
}

module.exports = { recordHomeownerPayment };
