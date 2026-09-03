// ============================================================================
// lib/accounting/prepaid_amortization.js  (Ed 2026-09-03)
// ----------------------------------------------------------------------------
// When a vendor bill is coded to a PREPAID asset (e.g. 1400 Prepaid Insurance),
// the money shouldn't sit on the balance sheet forever — it has to amortize to
// expense over the applicable period. The recognition engine already does the
// monthly posting for a `prepaid_expense` schedule (Dr expense / Cr prepaid);
// this sets that schedule up from the bill so Emma doesn't hand-build journals.
//
// Celina flagged the LOPF Harned insurance ACH: $12,242 landed in 1400 Prepaid
// Insurance with no amortization set up. This creates the schedule so it earns
// out ~1/12 per month across the policy term.
//
// The initial Dr Prepaid / Cr AP entry is ALREADY posted by coding the bill —
// this ONLY creates the recognition schedule (+ segment). No JE here.
//
//   suggestForInvoice({ supabase, invoice })      -> { period_start, period_end, term_months, expense_account, is_prepaid }
//   setupPrepaidAmortization({ supabase, invoice, expenseAccountNumber, periodStart, periodEnd, label })
// ============================================================================

const firstOfMonth = (iso) => String(iso).slice(0, 8) + '01';

// Inclusive calendar-month span. If the end is the 1st of a month, treat it as
// an exclusive period boundary (a 9/1→9/1 policy is 12 months, Sep..Aug).
function monthsInclusive(startISO, endISO) {
  let end = String(endISO).slice(0, 10);
  if (end.slice(8, 10) === '01') { // exclusive boundary → step back one day's month
    const d = new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    end = d.toISOString().slice(0, 10);
  }
  const [sy, sm] = startISO.slice(0, 7).split('-').map(Number);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  return Math.max(1, (ey * 12 + em) - (sy * 12 + sm) + 1);
}

// Prepaid = a balance-sheet asset held for future expense. Recognize it by
// account type (asset) or an explicit "prepaid" in the name.
function isPrepaidAccount(acct) {
  if (!acct) return false;
  const name = String(acct.account_name || '').toLowerCase();
  const type = String(acct.account_type || '').toLowerCase();
  if (/prepaid/.test(name)) return true;
  return type === 'asset' && /prepaid|insurance|deposit/.test(name);
}

// What to default the setup form to.
async function suggestForInvoice({ supabase, invoice }) {
  const acct = invoice.coded_account || null;
  const out = { is_prepaid: isPrepaidAccount(acct), period_start: null, period_end: null, term_months: 12, expense_account: null };
  if (!out.is_prepaid) return out;

  const isInsurance = /insurance/i.test(String(acct.account_name || ''));

  // Period: for insurance, the community's active policy term is the applicable
  // period. Otherwise default to a 12-month term from the invoice month.
  if (isInsurance) {
    const { data: prog } = await supabase.from('insurance_programs')
      .select('policy_period_start, policy_period_end').eq('community_id', invoice.community_id)
      .eq('status', 'active').order('policy_period_start', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (prog && prog.policy_period_start) { out.period_start = prog.policy_period_start; out.period_end = prog.policy_period_end || null; }
  }
  if (!out.period_start) {
    const base = invoice.invoice_date || new Date().toISOString().slice(0, 10);
    out.period_start = firstOfMonth(base);
    const d = new Date(out.period_start + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1);
    out.period_end = d.toISOString().slice(0, 10);
  }
  out.term_months = monthsInclusive(out.period_start, out.period_end);

  // Suggested expense account: an expense account whose name matches the prepaid
  // theme (insurance -> "Insurance" expense). Operator can change it.
  const theme = isInsurance ? 'insurance' : null;
  if (theme) {
    const { data: accts } = await supabase.from('chart_of_accounts')
      .select('account_number, account_name, account_type').eq('community_id', invoice.community_id).limit(500);
    const exp = (accts || []).find((a) => /expense/i.test(a.account_type || '') && new RegExp(theme, 'i').test(a.account_name || ''));
    if (exp) out.expense_account = { account_number: exp.account_number, account_name: exp.account_name };
  }
  return out;
}

async function setupPrepaidAmortization({ supabase, invoice, expenseAccountNumber, periodStart, periodEnd, label }) {
  const acct = invoice.coded_account;
  if (!acct || !acct.account_number) throw new Error('bill is not coded to an account yet');
  if (!isPrepaidAccount(acct)) throw new Error('coded account is not a prepaid asset');
  const total = Number(invoice.total_cents);
  if (!(total > 0)) throw new Error('bill has no positive amount to amortize');
  const expNum = String(expenseAccountNumber || '').trim();
  if (!expNum) throw new Error('expense account required');
  if (!periodStart || !periodEnd) throw new Error('period start and end required');

  const communityId = invoice.community_id;
  const prepaidNum = acct.account_number;
  const start_month = firstOfMonth(periodStart);
  const term_months = monthsInclusive(periodStart, periodEnd);
  const monthly = Math.round(total / term_months);

  // Expense account must exist in this community's chart.
  const { data: expAcct } = await supabase.from('chart_of_accounts')
    .select('account_number').eq('community_id', communityId).eq('account_number', expNum).maybeSingle();
  if (!expAcct) throw new Error(`expense account ${expNum} not in this community's chart of accounts`);

  // Idempotent: same prepaid + amount + start = the same schedule.
  const { data: existing } = await supabase.from('recognition_schedules')
    .select('id, status').eq('community_id', communityId).eq('schedule_type', 'prepaid_expense')
    .eq('balance_account_number', prepaidNum).eq('recognize_amount_cents', total).eq('start_month', start_month)
    .in('status', ['active', 'fully_recognized']).maybeSingle();
  if (existing) return { existing: true, schedule_id: existing.id, term_months, monthly_amount_cents: monthly };

  const desc = label || `Prepaid amortization — ${acct.account_name}${invoice.vendor_invoice_number ? ` (bill ${invoice.vendor_invoice_number})` : ''}`;
  const { data: sched, error: sErr } = await supabase.from('recognition_schedules').insert({
    community_id: communityId, schedule_type: 'prepaid_expense', description: desc,
    balance_account_number: prepaidNum, recognize_amount_cents: total,
    start_month, term_months, monthly_amount_cents: monthly,
    period_start: periodStart, period_end: periodEnd, status: 'active',
  }).select('id').single();
  if (sErr) throw sErr;

  const { error: segErr } = await supabase.from('recognition_schedule_segments').insert([{
    schedule_id: sched.id, income_account_number: expNum,
    label: `${acct.account_name} → expense`, monthly_amount_cents: monthly,
  }]);
  if (segErr) throw segErr;

  return { existing: false, schedule_id: sched.id, term_months, monthly_amount_cents: monthly, prepaid_account: prepaidNum, expense_account: expNum };
}

module.exports = { setupPrepaidAmortization, suggestForInvoice, isPrepaidAccount, monthsInclusive };
