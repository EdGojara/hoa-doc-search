// ============================================================================
// lib/accounting/recognition_engine.js
// ----------------------------------------------------------------------------
// The revenue/expense recognition engine. For each active schedule, posts the
// monthly recognition journal entry for every month that is due but not yet
// posted. Idempotent — a month posts once (unique (schedule, month) + re-check).
// The last month stubs to the exact remaining balance so the balance-sheet
// account zeros precisely.
//
// Two mirror-image directions, driven by schedule_type:
//   prepaid_expense   Dr income (expense) / Cr balance (prepaid asset)
//   deferred_revenue  Dr balance (unearned liability) / Cr income (revenue)
//
// This is "trustEd knows the journal entries": a schedule is set up once (from
// an uploaded document or the annual assessment), and this runs monthly (cron)
// or on demand with no human touching a journal.
//
//   postDueRecognition({ supabase, communityId?, throughMonth })
//     throughMonth: 'YYYY-MM-01' — post months up to and including this one.
// ============================================================================

const firstOfMonth = (d) => String(d).slice(0, 8) + '01';
function addMonths(iso, n) {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

async function postDueRecognition({ supabase, communityId = null, throughMonth }) {
  if (!throughMonth) throw new Error('throughMonth required (YYYY-MM-01)');
  const through = firstOfMonth(throughMonth);

  let q = supabase.from('recognition_schedules').select('*').eq('status', 'active');
  if (communityId) q = q.eq('community_id', communityId);
  const { data: schedules, error } = await q;
  if (error) throw error;

  const results = [];
  for (const sch of schedules || []) {
    const isRevenue = sch.schedule_type === 'deferred_revenue';
    const { data: segments } = await supabase.from('recognition_schedule_segments').select('*').eq('schedule_id', sch.id);
    if (!segments || !segments.length) { results.push({ schedule: sch.description, skipped: 'no segments' }); continue; }

    const { data: coa } = await supabase.from('chart_of_accounts').select('id, account_number').eq('community_id', sch.community_id);
    const acctId = Object.fromEntries((coa || []).map((a) => [a.account_number, a.id]));
    const balanceId = acctId[sch.balance_account_number];
    if (!balanceId) { results.push({ schedule: sch.description, skipped: `balance acct ${sch.balance_account_number} not found` }); continue; }

    const { data: posted } = await supabase.from('recognition_postings').select('period_month').eq('schedule_id', sch.id);
    const postedSet = new Set((posted || []).map((p) => String(p.period_month).slice(0, 10)));

    const monthly = Number(sch.monthly_amount_cents);
    const total = Number(sch.recognize_amount_cents);
    let postedCount = 0;
    for (let k = 0; k < sch.term_months; k++) {
      const month = addMonths(sch.start_month, k);
      if (month > through) break;
      if (postedSet.has(month)) { postedCount++; continue; }

      const isLast = k === sch.term_months - 1;
      const monthTotal = isLast ? (total - monthly * (sch.term_months - 1)) : monthly;
      // Income-statement side: one line per segment.
      const segAmts = segments.map((s) => ({ acctNum: s.income_account_number, label: s.label, amount: Number(s.monthly_amount_cents) }));
      const segSum = segAmts.reduce((a, x) => a + x.amount, 0);
      if (segSum !== monthTotal && segAmts.length) {
        const big = segAmts.reduce((a, b) => (b.amount > a.amount ? b : a));
        big.amount += (monthTotal - segSum); // absorb rounding/stub on the largest
      }
      const incomeLines = segAmts.filter((x) => acctId[x.acctNum] && x.amount !== 0).map((x) => ({
        account_id: acctId[x.acctNum],
        // prepaid_expense: income side is a Dr (expense). deferred_revenue: income side is a Cr (revenue).
        debit_cents: isRevenue ? 0 : x.amount,
        credit_cents: isRevenue ? x.amount : 0,
        memo: `${sch.description} — ${x.label || x.acctNum}`,
      }));
      if (!incomeLines.length) { results.push({ schedule: sch.description, month, skipped: 'no valid income accounts' }); continue; }
      // Balance-sheet side: the offsetting line.
      const balanceLine = {
        account_id: balanceId,
        debit_cents: isRevenue ? monthTotal : 0,   // deferred_revenue draws DOWN the liability (Dr)
        credit_cents: isRevenue ? 0 : monthTotal,  // prepaid_expense draws DOWN the asset (Cr)
        memo: `${sch.description} — ${isRevenue ? 'unearned recognized' : 'prepaid drawdown'}`,
      };

      const fy = Number(month.slice(0, 4)), pn = Number(month.slice(5, 7));
      const { data: period } = await supabase.from('accounting_periods').select('id').eq('community_id', sch.community_id).eq('fiscal_year', fy).eq('period_number', pn).maybeSingle();
      const monthEnd = new Date(Date.UTC(fy, pn, 0)).getUTCDate();
      const posting = `${month.slice(0, 7)}-${String(monthEnd).padStart(2, '0')}`;
      const ref = `JE-${isRevenue ? 'DEFREV' : 'AMORT'}-${month.slice(0, 7)}-${sch.balance_account_number}`;

      const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
        community_id: sch.community_id, period_id: period ? period.id : null, posting_date: posting,
        reference: ref, description: `${sch.description} — monthly ${isRevenue ? 'revenue recognition' : 'amortization'} (${month.slice(0, 7)})`,
        source_module: 'system', total_debits_cents: monthTotal, total_credits_cents: monthTotal, status: 'posted',
      }).select('id').single();
      if (jeErr) { results.push({ schedule: sch.description, month, error: jeErr.message }); continue; }

      const allLines = [...incomeLines, balanceLine].map((l, i) => ({ journal_entry_id: je.id, line_number: i + 1, ...l }));
      const { error: lErr } = await supabase.from('journal_entry_lines').insert(allLines);
      if (lErr) { results.push({ schedule: sch.description, month, error: lErr.message }); continue; }

      await supabase.from('recognition_postings').insert({ schedule_id: sch.id, period_month: month, journal_entry_id: je.id, amount_cents: monthTotal });
      postedCount++;
      results.push({ schedule: sch.description, type: sch.schedule_type, month, amount_cents: monthTotal, posted: true });
    }

    if (postedCount >= sch.term_months) await supabase.from('recognition_schedules').update({ status: 'fully_recognized' }).eq('id', sch.id);
  }
  return results;
}

module.exports = { postDueRecognition, addMonths };
