// ============================================================================
// lib/accounting/assessment_billing.js
// ----------------------------------------------------------------------------
// Annual assessment billing run for a community. The accounting Ed wants:
// bill every owner the annual assessment, but DON'T recognize it as income up
// front -- credit deferred revenue and let the recognition engine earn it 1/12
// per month. One run produces, atomically:
//   - an ar_charge per owner (the receivable subledger detail)
//   - a homeowner_ledger_entry per owner (statement history, running balance)
//   - ONE GL entry: Dr AR control / Cr Deferred Revenue (total)
//   - a deferred_revenue recognition schedule (Deferred -> Assessment Income, 12mo)
//
// Catastrophic-output surface: refuses to double-bill (idempotent per fiscal
// year), validates accounts + charge type exist, and supports dryRun so the plan
// is verified before a penny posts.
//
//   runAnnualBilling({ supabase, communityId, fiscalYear, perUnitCents,
//                      billingDate, dueDate, dryRun })
// ============================================================================

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

const AR_ACCT = '1300';          // Accounts Receivable control
const DEFERRED_ACCT = '2205';    // Unearned / Deferred Assessment Revenue
const REVENUE_ACCT = '4000';     // Current Year Assessment Income
const CHARGE_TYPE = 'annual_assessment';

async function runAnnualBilling({ supabase, communityId, fiscalYear, perUnitCents, billingDate, dueDate, dryRun = true }) {
  if (!communityId || !fiscalYear || !perUnitCents) throw new Error('communityId, fiscalYear, perUnitCents required');
  const bill = billingDate || `${fiscalYear}-01-01`;
  const due = dueDate || `${fiscalYear}-01-31`;
  const ref = `JE-${fiscalYear}-ASMT-BILL`;

  // accounts + charge type must exist
  const coa = await _fetchAll(supabase, 'chart_of_accounts', 'id, account_number', { community_id: communityId });
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  for (const n of [AR_ACCT, DEFERRED_ACCT, REVENUE_ACCT]) if (!acctId[n]) throw new Error(`account ${n} not in chart of accounts`);
  const { data: ct } = await supabase.from('ar_charge_types').select('id').eq('community_id', communityId).eq('type_code', CHARGE_TYPE).maybeSingle();
  if (!ct) throw new Error(`charge type ${CHARGE_TYPE} not configured`);

  // idempotency: refuse if already billed this fiscal year
  const { data: existing } = await supabase.from('journal_entries').select('id').eq('community_id', communityId).eq('reference', ref).maybeSingle();
  if (existing) return { refused: `already billed for ${fiscalYear} (${ref} exists)`, billed: 0 };

  const props = await _fetchAll(supabase, 'properties', 'id, street_address', { community_id: communityId });
  if (!props.length) throw new Error('community has no properties to bill');
  const total = props.length * perUnitCents;

  const plan = {
    fiscal_year: fiscalYear, properties: props.length, per_unit_cents: perUnitCents, total_cents: total,
    billing_date: bill, due_date: due,
    gl: `Dr ${AR_ACCT} ${(total / 100).toFixed(2)} / Cr ${DEFERRED_ACCT} ${(total / 100).toFixed(2)}`,
    recognition: `deferred_revenue ${DEFERRED_ACCT} -> ${REVENUE_ACCT}, ${(total / 100).toFixed(2)} over 12 months from ${fiscalYear}-01`,
  };
  if (dryRun) return { dry_run: true, plan };

  // last ledger balance per property (for the running balance on the new charge)
  const led = await _fetchAll(supabase, 'homeowner_ledger_entries', 'property_id, entry_date, sort_seq, running_balance_cents', { community_id: communityId });
  const lastBal = {};
  for (const e of led.sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || '') || (a.sort_seq - b.sort_seq))) lastBal[e.property_id] = Number(e.running_balance_cents);

  // period
  const { data: period } = await supabase.from('accounting_periods').select('id').eq('community_id', communityId).eq('fiscal_year', fiscalYear).eq('period_number', 1).maybeSingle();

  // 1) GL entry: Dr AR / Cr Deferred
  const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
    community_id: communityId, period_id: period ? period.id : null, posting_date: bill, reference: ref,
    description: `${fiscalYear} annual assessment billed (deferred, recognized 1/12 monthly)`,
    source_module: 'assessment_billing', total_debits_cents: total, total_credits_cents: total, status: 'posted',
  }).select('id').single();
  if (jeErr) throw jeErr;
  await supabase.from('journal_entry_lines').insert([
    { journal_entry_id: je.id, line_number: 1, account_id: acctId[AR_ACCT], debit_cents: total, credit_cents: 0, memo: `${fiscalYear} annual assessment` },
    { journal_entry_id: je.id, line_number: 2, account_id: acctId[DEFERRED_ACCT], debit_cents: 0, credit_cents: total, memo: `${fiscalYear} assessment deferred` },
  ]);

  // 2) ar_charge + 3) ledger entry per owner
  const charges = props.map((p) => ({
    community_id: communityId, property_id: p.id, charge_type_id: ct.id, charge_date: bill, due_date: due,
    description: `Annual Assessment ${fiscalYear}`, original_amount_cents: perUnitCents, balance_remaining_cents: perUnitCents,
    status: 'open', source_module: 'assessment_billing', posting_journal_entry_id: je.id,
  }));
  for (let i = 0; i < charges.length; i += 500) await supabase.from('ar_charges').insert(charges.slice(i, i + 500));

  const ledgerRows = props.map((p) => {
    const nb = (lastBal[p.id] || 0) + perUnitCents;
    return { community_id: communityId, property_id: p.id, entry_date: bill, description: `Annual Assessment ${fiscalYear}`, charge_cents: perUnitCents, payment_cents: 0, running_balance_cents: nb, entry_type: 'charge', source: 'trusted_billing', sort_seq: 50 };
  });
  for (let i = 0; i < ledgerRows.length; i += 500) await supabase.from('homeowner_ledger_entries').insert(ledgerRows.slice(i, i + 500));

  // 4) recognition schedule (deferred -> income, 1/12 monthly)
  const monthly = Math.round(total / 12);
  const { data: sched } = await supabase.from('recognition_schedules').insert({
    community_id: communityId, schedule_type: 'deferred_revenue', description: `${fiscalYear} Annual Assessment revenue`,
    balance_account_number: DEFERRED_ACCT, recognize_amount_cents: total, start_month: `${fiscalYear}-01-01`,
    term_months: 12, monthly_amount_cents: monthly, period_start: `${fiscalYear}-01-01`, period_end: `${fiscalYear}-12-31`,
    notes: 'Annual assessment recognized 1/12 per month (auto-billed).',
  }).select('id').single();
  await supabase.from('recognition_schedule_segments').insert([{ schedule_id: sched.id, income_account_number: REVENUE_ACCT, label: 'Assessment Income', monthly_amount_cents: monthly }]);

  return { dry_run: false, billed: props.length, total_cents: total, journal_entry: ref, recognition_schedule_id: sched.id, plan };
}

module.exports = { runAnnualBilling };
