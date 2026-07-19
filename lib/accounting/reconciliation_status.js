// ============================================================================
// lib/accounting/reconciliation_status.js  (Ed 2026-07-19)
// ----------------------------------------------------------------------------
// The Accounting Manager's (Kat's) month-end reconciliation dashboard for one
// community — the same tie-outs run by hand during the Vantaca->trustEd
// cutovers, packaged so Kat can report "where do the books stand" and surface
// exceptions. Read-only: it INSPECTS the GL / subledgers / bank rec / budget
// and returns pass/fail per check. It never posts or "fixes" anything — money
// changes are always a human-reviewed exception.
//
//   const st = await reconciliationStatus(supabase, communityId);
//   → { tb, ar, bank, budget, exceptions: [...], all_clean }
// ============================================================================

const money = (c) => '$' + (Number(c || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// GL balance in the account's natural direction (debit-normal => Dr-Cr).
function acctNet(tbRow) {
  if (!tbRow) return 0;
  return (Number(tbRow.total_debits_cents || 0) - Number(tbRow.total_credits_cents || 0)) / 100;
}

async function reconciliationStatus(supabase, communityId) {
  const exceptions = [];

  // 1) Trial balance — must balance (Dr = Cr). The hard floor.
  let tb = { ok: false, debits: 0, credits: 0, accounts: 0 };
  try {
    const { data, error } = await supabase.from('v_trial_balance')
      .select('account_number, total_debits_cents, total_credits_cents').eq('community_id', communityId);
    if (error) throw error;
    const rows = data || [];
    const dr = rows.reduce((a, r) => a + Number(r.total_debits_cents || 0), 0);
    const cr = rows.reduce((a, r) => a + Number(r.total_credits_cents || 0), 0);
    tb = { ok: dr === cr, debits: dr / 100, credits: cr / 100, diff: (dr - cr) / 100, accounts: rows.length, _rows: rows };
    if (!tb.ok) exceptions.push(`Trial balance is OUT by ${money(tb.diff)} — the GL does not balance.`);
    if (!rows.length) exceptions.push('No GL activity found — community may not be migrated yet.');
  } catch (e) { exceptions.push(`Trial balance check failed: ${e.message}`); }

  // 2) AR subledger ties to the GL AR control (1300 receivable + 2400 prepaid).
  let ar = { ok: false, subledger: 0, gl_net: 0 };
  try {
    const rows = tb._rows || [];
    const byNum = Object.fromEntries(rows.map((r) => [String(r.account_number), r]));
    const glNet = acctNet(byNum['1300']) + acctNet(byNum['2400']);   // receivable + (negative) prepaid
    let sub = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await supabase.from('v_homeowner_current_balance').select('balance_cents').eq('community_id', communityId).range(f, f + 999);
      if (!data || !data.length) break; sub = sub.concat(data); if (data.length < 1000) break;
    }
    const subTotal = sub.reduce((a, r) => a + Number(r.balance_cents || 0), 0) / 100;
    const diff = Math.round((subTotal - glNet) * 100) / 100;
    ar = { ok: Math.abs(diff) < 0.01, subledger: subTotal, gl_net: glNet, diff };
    if (!ar.ok) exceptions.push(`AR subledger (${money(subTotal)}) does not tie to GL AR net (${money(glNet)}) — off ${money(diff)}.`);
  } catch (e) { exceptions.push(`AR tie-out failed: ${e.message}`); }

  // 3) Bank reconciliation — latest per account; are they all reconciled?
  let bank = { ok: false, accounts: [], through: null };
  try {
    const { data } = await supabase.from('bank_reconciliations')
      .select('bank_account_id, period_end, status, difference_cents, bank_accounts(account_nickname, bank_name)')
      .eq('community_id', communityId).order('period_end', { ascending: false }).limit(200);
    const latest = {};
    for (const r of data || []) if (!latest[r.bank_account_id]) latest[r.bank_account_id] = r;
    const accts = Object.values(latest).map((r) => ({
      account: (r.bank_accounts && (r.bank_accounts.account_nickname || r.bank_accounts.bank_name)) || '—',
      through: r.period_end, status: r.status,
      reconciled: r.status === 'reconciled' && Number(r.difference_cents || 0) === 0,
    }));
    const through = accts.map((a) => a.through).filter(Boolean).sort()[0] || null;   // oldest = the weakest link
    bank = { ok: accts.length > 0 && accts.every((a) => a.reconciled), accounts: accts, through };
    if (!accts.length) exceptions.push('No bank reconciliations on file — cash is unreconciled.');
    else if (!bank.ok) exceptions.push(`Bank rec incomplete — ${accts.filter((a) => !a.reconciled).map((a) => a.account).join(', ')} not reconciled.`);
  } catch (e) { /* pre-migration bank_reconciliations */ bank.error = e.message; }

  // 4) Budget loaded for the current fiscal year (needed for budget-vs-actual).
  let budget = { ok: false, fiscal_year: null, lines: 0 };
  try {
    const fy = Number(String(new Date().toISOString().slice(0, 4)));   // calendar year as FY (matches Vantaca budgets)
    const { data } = await supabase.from('community_budgets').select('id, fiscal_year, status').eq('community_id', communityId).eq('fiscal_year', fy).maybeSingle();
    if (data) {
      const { count } = await supabase.from('budget_line_items').select('id', { count: 'exact', head: true }).eq('budget_id', data.id);
      budget = { ok: (count || 0) > 0, fiscal_year: fy, lines: count || 0, status: data.status };
    } else { budget = { ok: false, fiscal_year: fy, lines: 0 }; exceptions.push(`No FY${fy} budget loaded — budget-vs-actual can't render.`); }
  } catch (e) { budget.error = e.message; }

  const all_clean = tb.ok && ar.ok && bank.ok && budget.ok;
  if (tb._rows) delete tb._rows;
  return { tb, ar, bank, budget, exceptions, all_clean, money };
}

module.exports = { reconciliationStatus, money };
