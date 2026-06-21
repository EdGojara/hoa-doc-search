// ============================================================================
// lib/accounting/late_fee_interest.js
// ----------------------------------------------------------------------------
// Monthly late-fee + interest run for a community, and a one-call reversal.
// Rules (Ed 2026-06-20):
//   - Late fee: FIXED per community. Charged the 1st to any account carrying a
//     balance at the prior month-end.
//   - Interest: FIXED rate per community, charged the 1st on the prior month-end
//     balance -- but ONLY on the unpaid ASSESSMENT balance, never on fees or
//     prior interest. Monthly interest = (APR/12)% x assessment balance.
//     (Validated: $260 assessment x 10%/12 = $2.17; $520 x 10%/12 = $4.33.)
//
// Catastrophic-output surface: refuses to double-run a month, dryRun returns the
// plan before anything posts, and reverse() pulls the whole month's run back off
// every account in one shot (so a mistake is one undo, not per-account surgery).
//
//   runLateFeesAndInterest({ supabase, communityId, runMonth, dryRun })  // 'YYYY-MM'
//   reverseLateFeesAndInterest({ supabase, communityId, runMonth })
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

const AR_ACCT = '1300', FEE_INCOME_ACCT = '4030';
const ASSESSMENT_TYPES = ['annual_assessment', 'balance_forward_assessment'];

async function _ctx(supabase, communityId, runMonth) {
  if (!/^\d{4}-\d{2}$/.test(runMonth || '')) throw new Error('runMonth must be YYYY-MM');
  const postDate = `${runMonth}-01`;
  const ref = `JE-${runMonth}-FEES`;
  const { data: policy } = await supabase.from('community_billing_policies').select('*')
    .eq('community_id', communityId).is('effective_end_date', null).maybeSingle();
  if (!policy) throw new Error('no billing policy set for this community');
  const cts = await _fetchAll(supabase, 'ar_charge_types', 'id, type_code', { community_id: communityId });
  const ctId = Object.fromEntries(cts.map((c) => [c.type_code, c.id]));
  const asmtTypeIds = new Set(ASSESSMENT_TYPES.map((t) => ctId[t]).filter(Boolean));
  const coa = await _fetchAll(supabase, 'chart_of_accounts', 'id, account_number', { community_id: communityId });
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  return { postDate, ref, policy, ctId, asmtTypeIds, acctId };
}

async function runLateFeesAndInterest({ supabase, communityId, runMonth, dryRun = true }) {
  const { postDate, ref, policy, ctId, asmtTypeIds, acctId } = await _ctx(supabase, communityId, runMonth);
  if (!ctId.late_fees || !ctId.late_interest) throw new Error('late_fees / late_interest charge types missing');
  if (!acctId[AR_ACCT] || !acctId[FEE_INCOME_ACCT]) throw new Error(`accounts ${AR_ACCT}/${FEE_INCOME_ACCT} missing`);

  const { data: existing } = await supabase.from('journal_entries').select('id').eq('community_id', communityId).eq('reference', ref).maybeSingle();
  if (existing) return { refused: `already run for ${runMonth} (${ref}). Reverse it first to re-run.` };

  const lateFee = Number(policy.late_fee_amount_cents) || 0;
  const monthlyRate = (Number(policy.interest_apr_pct) || 0) / 100 / 12;

  // balances per property: total + assessment-only
  const charges = await _fetchAll(supabase, 'ar_charges', 'property_id, charge_type_id, balance_remaining_cents', { community_id: communityId, status: 'open' });
  const total = {}, asmt = {};
  for (const c of charges) {
    const b = Number(c.balance_remaining_cents); if (b <= 0) continue;
    total[c.property_id] = (total[c.property_id] || 0) + b;
    if (asmtTypeIds.has(c.charge_type_id)) asmt[c.property_id] = (asmt[c.property_id] || 0) + b;
  }
  const propIds = [...new Set([...Object.keys(total)])];

  // Late fee is charged ONCE per fiscal year (assessments are annual): on the 1st
  // of the month after the grace period (assessment due Jan 1 + grace -> Feb 1 for
  // a 30-day grace), to accounts still owing. Interest is charged EVERY month.
  const fy = Number(runMonth.slice(0, 4));
  const graceEnd = new Date(Date.UTC(fy, 0, 1 + (Number(policy.grace_period_days) || 0)));
  const lfFirst = new Date(Date.UTC(graceEnd.getUTCFullYear(), graceEnd.getUTCMonth() + 1, 1));
  const lateFeeMonth = `${lfFirst.getUTCFullYear()}-${String(lfFirst.getUTCMonth() + 1).padStart(2, '0')}`;
  const lateFeeEligible = runMonth >= lateFeeMonth;
  // accounts that already received a late fee this fiscal year — never charge twice
  const priorLate = await _fetchAll(supabase, 'ar_charges', 'property_id, charge_date', { community_id: communityId, charge_type_id: ctId.late_fees });
  const lateThisYear = new Set(priorLate.filter((c) => String(c.charge_date || '').slice(0, 4) === String(fy)).map((c) => c.property_id));

  // Bankruptcy accounts are exempt from BOTH late fees and interest — the
  // automatic stay (11 U.S.C. 362) freezes collection. Handled via the pre/post-
  // petition ledger split, never by this batch run.
  let exempt = new Set();
  try {
    const coll = await _fetchAll(supabase, 'ar_account_collections', 'property_id, collection_status', { community_id: communityId });
    exempt = new Set(coll.filter((c) => c.collection_status === 'bankruptcy').map((c) => c.property_id));
  } catch (e) { /* collections table optional */ }

  const items = [];
  let feeTotal = 0, intTotal = 0;
  for (const pid of propIds) {
    if (exempt.has(pid)) continue; // bankruptcy — stayed
    // Late fee is for an UNPAID ASSESSMENT (everyone is billed the assessment
    // Jan 1; the late fee is for not paying it). Owing only leftover fees does
    // NOT trigger a late fee.
    const fee = (lateFeeEligible && asmt[pid] > 0 && lateFee > 0 && !lateThisYear.has(pid)) ? lateFee : 0;
    const interest = (asmt[pid] > 0 && monthlyRate > 0) ? Math.round(asmt[pid] * monthlyRate) : 0;
    if (fee === 0 && interest === 0) continue;
    items.push({ property_id: pid, assessment_balance_cents: asmt[pid] || 0, late_fee_cents: fee, interest_cents: interest });
    feeTotal += fee; intTotal += interest;
  }
  const grand = feeTotal + intTotal;
  const lateFeeCount = items.filter((i) => i.late_fee_cents > 0).length;
  const plan = { run_month: runMonth, post_date: postDate, accounts_charged: items.length, late_fee_month: lateFeeMonth, late_fee_eligible: lateFeeEligible, late_fee_accounts: lateFeeCount, late_fee_each: lateFee, late_fee_total_cents: feeTotal, interest_apr_pct: Number(policy.interest_apr_pct), interest_total_cents: intTotal, grand_total_cents: grand };
  if (dryRun) return { dry_run: true, plan, sample: items.slice(0, 5) };
  if (!items.length) return { posted: 0, plan };

  // last ledger balance per property (running balance on the new charges)
  const led = await _fetchAll(supabase, 'homeowner_ledger_entries', 'property_id, entry_date, sort_seq, running_balance_cents', { community_id: communityId });
  const lastBal = {};
  for (const e of led.sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || '') || (a.sort_seq - b.sort_seq))) lastBal[e.property_id] = Number(e.running_balance_cents);

  const pn = Number(runMonth.slice(5, 7));
  const { data: period } = await supabase.from('accounting_periods').select('id').eq('community_id', communityId).eq('fiscal_year', fy).eq('period_number', pn).maybeSingle();

  // ONE GL entry: Dr AR (total) / Cr fee income (total)
  const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
    community_id: communityId, period_id: period ? period.id : null, posting_date: postDate, reference: ref,
    description: `Late fees + interest — ${runMonth}`, source_module: 'system',
    total_debits_cents: grand, total_credits_cents: grand, status: 'posted',
  }).select('id').single();
  if (jeErr) throw jeErr;
  await supabase.from('journal_entry_lines').insert([
    { journal_entry_id: je.id, line_number: 1, account_id: acctId[AR_ACCT], debit_cents: grand, credit_cents: 0, memo: `Late fees ${(feeTotal / 100).toFixed(2)} + interest ${(intTotal / 100).toFixed(2)}` },
    { journal_entry_id: je.id, line_number: 2, account_id: acctId[FEE_INCOME_ACCT], debit_cents: 0, credit_cents: grand, memo: 'Late fee + interest income' },
  ]);

  // ar_charges + ledger entries per owner
  const arRows = [], ledRows = [];
  for (const it of items) {
    let bal = lastBal[it.property_id] || 0;
    if (it.late_fee_cents) {
      arRows.push({ community_id: communityId, property_id: it.property_id, charge_type_id: ctId.late_fees, charge_date: postDate, due_date: postDate, description: `Late Fee ${runMonth}`, original_amount_cents: it.late_fee_cents, balance_remaining_cents: it.late_fee_cents, status: 'open', source_module: 'late_fee_run', posting_journal_entry_id: je.id });
      bal += it.late_fee_cents;
      ledRows.push({ community_id: communityId, property_id: it.property_id, entry_date: postDate, description: 'Late Fee', charge_cents: it.late_fee_cents, payment_cents: 0, running_balance_cents: bal, entry_type: 'charge', source: 'late_fee_run', sort_seq: 60 });
    }
    if (it.interest_cents) {
      arRows.push({ community_id: communityId, property_id: it.property_id, charge_type_id: ctId.late_interest, charge_date: postDate, due_date: postDate, description: `Interest ${runMonth} (on ${(it.assessment_balance_cents / 100).toFixed(2)} assessment)`, original_amount_cents: it.interest_cents, balance_remaining_cents: it.interest_cents, status: 'open', source_module: 'late_fee_run', posting_journal_entry_id: je.id });
      bal += it.interest_cents;
      ledRows.push({ community_id: communityId, property_id: it.property_id, entry_date: postDate, description: 'Late Interest', charge_cents: it.interest_cents, payment_cents: 0, running_balance_cents: bal, entry_type: 'charge', source: 'late_fee_run', sort_seq: 61 });
    }
  }
  for (let i = 0; i < arRows.length; i += 500) await supabase.from('ar_charges').insert(arRows.slice(i, i + 500));
  for (let i = 0; i < ledRows.length; i += 500) await supabase.from('homeowner_ledger_entries').insert(ledRows.slice(i, i + 500));

  return { dry_run: false, posted: items.length, journal_entry: ref, late_fee_total_cents: feeTotal, interest_total_cents: intTotal, grand_total_cents: grand };
}

async function reverseLateFeesAndInterest({ supabase, communityId, runMonth }) {
  const { postDate, ref } = await _ctx(supabase, communityId, runMonth);
  const { data: je } = await supabase.from('journal_entries').select('id').eq('community_id', communityId).eq('reference', ref).maybeSingle();
  if (!je) return { reversed: 0, note: `nothing to reverse for ${runMonth}` };
  // charges tied to this run, ledger entries from this run, then the GL entry
  const { data: ch } = await supabase.from('ar_charges').select('id').eq('community_id', communityId).eq('posting_journal_entry_id', je.id).eq('source_module', 'late_fee_run');
  const chCount = (ch || []).length;
  if (chCount) await supabase.from('ar_charges').delete().in('id', ch.map((x) => x.id));
  await supabase.from('homeowner_ledger_entries').delete().eq('community_id', communityId).eq('source', 'late_fee_run').eq('entry_date', postDate);
  await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', je.id);
  await supabase.from('journal_entries').delete().eq('id', je.id);
  return { reversed: chCount, journal_entry: ref, note: `removed ${runMonth} late-fee/interest run from every account` };
}

module.exports = { runLateFeesAndInterest, reverseLateFeesAndInterest };
