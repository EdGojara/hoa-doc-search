// ============================================================================
// lib/accounting/prepaid_amortization.js
// ----------------------------------------------------------------------------
// The prepaid amortization engine. For each active prepaid schedule, posts the
// monthly amortization journal entry (Dr the expense segments, Cr the prepaid
// asset) for every month that is due but not yet posted. Idempotent — a month
// can only post once (enforced by the prepaid_amortization_postings unique key
// AND re-checked here). The last month stubs to the exact remaining balance so
// the prepaid zeros out precisely.
//
// This is the "trustEd knows the journal entries" core: staff upload a document
// and set up a schedule; this runs monthly (cron) or on demand and books the
// entries with no human touching a journal.
//
//   postDueAmortization({ supabase, communityId?, throughMonth })
//     throughMonth: 'YYYY-MM-01' — post months up to and including this one.
// ============================================================================

const firstOfMonth = (d) => String(d).slice(0, 8) + '01';
function addMonths(iso, n) {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

async function postDueAmortization({ supabase, communityId = null, throughMonth }) {
  if (!throughMonth) throw new Error('throughMonth required (YYYY-MM-01)');
  const through = firstOfMonth(throughMonth);

  let q = supabase.from('prepaid_schedules').select('*').eq('status', 'active');
  if (communityId) q = q.eq('community_id', communityId);
  const { data: schedules, error } = await q;
  if (error) throw error;

  const results = [];
  for (const sch of schedules || []) {
    const { data: segments } = await supabase.from('prepaid_schedule_segments').select('*').eq('schedule_id', sch.id);
    if (!segments || !segments.length) { results.push({ schedule: sch.description, skipped: 'no segments' }); continue; }

    // Resolve accounts for this community.
    const { data: coa } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', sch.community_id);
    const acctId = Object.fromEntries((coa || []).map((a) => [a.account_number, a.id]));
    const prepaidId = acctId[sch.prepaid_account_number];
    if (!prepaidId) { results.push({ schedule: sch.description, skipped: `prepaid acct ${sch.prepaid_account_number} not found` }); continue; }

    // Already-posted months.
    const { data: posted } = await supabase.from('prepaid_amortization_postings').select('period_month').eq('schedule_id', sch.id);
    const postedSet = new Set((posted || []).map((p) => String(p.period_month).slice(0, 10)));

    const monthly = Number(sch.monthly_amount_cents);
    const total = Number(sch.amortize_amount_cents);
    let postedCount = 0;
    for (let k = 0; k < sch.term_months; k++) {
      const month = addMonths(sch.amortize_start_month, k);
      if (month > through) break;
      if (postedSet.has(month)) { postedCount++; continue; }

      // Last month stubs to the exact remaining balance.
      const isLast = k === sch.term_months - 1;
      const monthTotal = isLast ? (total - monthly * (sch.term_months - 1)) : monthly;
      // Build segment debits; absorb any rounding into the largest segment on the last month.
      const segLines = segments.map((s) => ({ account_id: acctId[s.expense_account_number], debit_cents: Number(s.monthly_amount_cents), credit_cents: 0, memo: `${sch.description} — ${s.label || s.expense_account_number} amortization` }));
      const segSum = segLines.reduce((a, l) => a + l.debit_cents, 0);
      if (segSum !== monthTotal && segLines.length) {
        const big = segLines.reduce((a, b) => (b.debit_cents > a.debit_cents ? b : a));
        big.debit_cents += (monthTotal - segSum); // absorb rounding/stub
      }
      const valid = segLines.filter((l) => l.account_id && l.debit_cents !== 0);
      if (!valid.length) { results.push({ schedule: sch.description, month, skipped: 'no valid expense accounts' }); continue; }

      // Period for the month.
      const fy = Number(month.slice(0, 4)), pn = Number(month.slice(5, 7));
      const { data: period } = await supabase.from('accounting_periods').select('id').eq('community_id', sch.community_id).eq('fiscal_year', fy).eq('period_number', pn).maybeSingle();
      const postDate = addMonths(month, 1).slice(0, 8) + '01'; // post on the last day equivalent? use month-end
      const monthEnd = new Date(Date.UTC(fy, pn, 0)).getUTCDate();
      const posting = `${month.slice(0, 7)}-${String(monthEnd).padStart(2, '0')}`;

      const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
        community_id: sch.community_id, period_id: period ? period.id : null, posting_date: posting,
        reference: `JE-AMORT-${month.slice(0, 7)}-${sch.prepaid_account_number}`,
        description: `${sch.description} — monthly amortization (${month.slice(0, 7)})`,
        source_module: 'system', total_debits_cents: monthTotal, total_credits_cents: monthTotal, status: 'posted',
      }).select('id').single();
      if (jeErr) { results.push({ schedule: sch.description, month, error: jeErr.message }); continue; }

      const lines = valid.map((l, i) => ({ journal_entry_id: je.id, line_number: i + 1, ...l }));
      lines.push({ journal_entry_id: je.id, line_number: lines.length + 1, account_id: prepaidId, debit_cents: 0, credit_cents: monthTotal, memo: `${sch.description} — prepaid drawdown` });
      const { error: lErr } = await supabase.from('journal_entry_lines').insert(lines);
      if (lErr) { results.push({ schedule: sch.description, month, error: lErr.message }); continue; }

      await supabase.from('prepaid_amortization_postings').insert({ schedule_id: sch.id, period_month: month, journal_entry_id: je.id, amount_cents: monthTotal });
      postedCount++;
      results.push({ schedule: sch.description, month, amount_cents: monthTotal, posted: true });
    }

    if (postedCount >= sch.term_months) await supabase.from('prepaid_schedules').update({ status: 'fully_amortized' }).eq('id', sch.id);
  }
  return results;
}

module.exports = { postDueAmortization, addMonths };
