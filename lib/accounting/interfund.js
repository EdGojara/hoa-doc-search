// ============================================================================
// lib/accounting/interfund.js  (Ed 2026-09-04)
// ----------------------------------------------------------------------------
// Auto-bridge cross-fund journal entries so every FUND self-balances.
//
// The physical reality: there is ONE checking account (Operating's). Reserve and
// Adopt-a-School have no bank account of their own — their cash is commingled in
// Operating's. So when a journal entry books an expense/revenue in a non-Operating
// fund while the cash or A/P sits in Operating (e.g. an Adopt-a-School donation
// coded to 5950 but paid from Operating cash), the entry balances in TOTAL but
// each fund is left lopsided: Adopt-a-School shows an expense with nothing behind
// it, Operating shows a payable with nothing behind it.
//
// Fund accounting requires each fund's own trial balance to tie. We close the gap
// with interfund Due To / Due From lines: the away-fund records what it owes (or
// is owed by) Operating, and Operating records the mirror. The commingled cash is
// tracked by these balances until a real transfer settles them. (Ed: "reserve and
// adopt a school don't have checking accounts, so create a receivable/payable
// between the funds to balance the ledger, then make the transfer later.")
//
// This runs inside postJournalEntry (the ONE posting chokepoint), so every path —
// AP accrual, split accrual, the deposit poster, manual JEs — is bridged with no
// caller changes. A bridged entry already nets to zero per fund, so re-posting it
// (a reversal or an edit) adds nothing further.
//
// Resolution is by the interfund accounts' fund + type + name. A non-Operating
// fund is bridged only if all four of its interfund accounts resolve; otherwise
// the entry posts unchanged (today's behavior — no regression). The Operating <->
// Adopt-a-School accounts (1810/2810 on Operating, 1815/2815 on the fund) are
// created by migration 406. The legacy Reserve pair is inconsistently fund-tagged
// and will not resolve until normalized — a deliberate, logged skip.
// ============================================================================

const norm = (s) => String(s || '').toLowerCase();

// Resolve, for each non-Operating fund in a community, the four interfund
// accounts. Returns { oprFundId, map: { [fundId]: {fundDueTo, fundDueFrom,
// oprDueFrom, oprDueTo} } } or null if there's no Operating fund.
async function resolveInterfund(supabase, community_id) {
  const { data: funds, error: fe } = await supabase
    .from('account_funds')
    .select('id, fund_code, fund_name, fund_type, is_active')
    .eq('community_id', community_id);
  if (fe) throw fe;
  if (!funds || funds.length < 2) return null;
  const opr = funds.find((f) => f.fund_type === 'operating' || f.fund_code === 'OPR');
  if (!opr) return null;

  const { data: accts, error: ae } = await supabase
    .from('chart_of_accounts')
    .select('id, account_number, account_name, account_type, fund_id, is_active, is_summary')
    .eq('community_id', community_id)
    .eq('is_active', true)
    .in('account_type', ['asset', 'liability']);
  if (ae) throw ae;
  const pool = (accts || []).filter((a) => !a.is_summary);

  const map = {};
  for (const F of funds) {
    if (F.id === opr.id || F.is_active === false) continue;
    const fname = norm(F.fund_name); // "reserve", "adopt a school"
    // In the away-fund F:
    const fundDueTo = pool.find((a) => a.fund_id === F.id && a.account_type === 'liability' && /due to operating/.test(norm(a.account_name)));   // F owes Operating
    const fundDueFrom = pool.find((a) => a.fund_id === F.id && a.account_type === 'asset' && /due from operating/.test(norm(a.account_name)));   // Operating owes F
    // In Operating, referencing F by name:
    const oprDueFrom = pool.find((a) => a.fund_id === opr.id && a.account_type === 'asset' && norm(a.account_name).includes('due from') && norm(a.account_name).includes(fname));   // Operating owed by F
    const oprDueTo = pool.find((a) => a.fund_id === opr.id && a.account_type === 'liability' && norm(a.account_name).includes('due to') && norm(a.account_name).includes(fname));   // Operating owes F
    if (fundDueTo && fundDueFrom && oprDueFrom && oprDueTo) {
      map[F.id] = { fundDueTo: fundDueTo.id, fundDueFrom: fundDueFrom.id, oprDueFrom: oprDueFrom.id, oprDueTo: oprDueTo.id };
    } else {
      console.warn(`[interfund] ${F.fund_code} not bridged — interfund accounts incomplete (community ${community_id})`);
    }
  }
  return { oprFundId: opr.id, map };
}

// Given the entry's lines (each with an effective fund) compute the bridge lines
// that make every fund net to zero. `fundOf(line)` resolves a line's fund.
// Pure function — no I/O. Returns [] when nothing needs bridging.
function computeBridge(lines, fundOf, resolved) {
  if (!resolved || !resolved.map) return [];
  const { oprFundId, map } = resolved;
  const net = new Map();
  for (const ln of lines) {
    const f = fundOf(ln);
    if (!f) continue;
    net.set(f, (net.get(f) || 0) + Number(ln.debit_cents || 0) - Number(ln.credit_cents || 0));
  }
  const bridge = [];
  for (const [fundId, n] of net) {
    if (fundId === oprFundId || !n) continue;
    const acc = map[fundId];
    if (!acc) continue; // unresolved fund → leave as-is (no regression)
    if (n > 0) {
      // Away-fund has excess debit → it owes Operating.
      bridge.push({ account_id: acc.fundDueTo, fund_id: fundId, debit_cents: 0, credit_cents: n, memo: 'Interfund — due to Operating' });
      bridge.push({ account_id: acc.oprDueFrom, fund_id: oprFundId, debit_cents: n, credit_cents: 0, memo: 'Interfund — due from fund' });
    } else {
      const amt = -n;
      // Away-fund has excess credit → Operating owes it.
      bridge.push({ account_id: acc.fundDueFrom, fund_id: fundId, debit_cents: amt, credit_cents: 0, memo: 'Interfund — due from Operating' });
      bridge.push({ account_id: acc.oprDueTo, fund_id: oprFundId, debit_cents: 0, credit_cents: amt, memo: 'Interfund — due to fund' });
    }
  }
  return bridge;
}

// Build the journal lines for a transfer of cash between two accounts.
// - Same fund: a plain reallocation (Dr destination cash / Cr source cash).
// - Cross fund (one side is Operating): move the cash claim AND settle the
//   interfund Due To/Due From in the direction that CLEARS it toward zero — the
//   whole point of a transfer between funds when cash is pooled. The lines are
//   balanced within EACH fund, so the auto-bridge adds nothing on top.
//     sub -> Operating (sub pays down what it owes Operating):
//        Dr OPR cash, Cr OPR "Due from sub"    | Cr sub cash, Dr sub "Due to Operating"
//     Operating -> sub (Operating pays down what it owes sub):
//        Dr sub cash, Cr sub "Due from Operating" | Cr OPR cash, Dr OPR "Due to sub"
// `from`/`to` accounts each need { id, fund_id }. Returns JE line objects.
function buildTransferLines({ from, to, amountCents, resolved }) {
  const X = Math.round(Number(amountCents) || 0);
  if (!(X > 0)) throw Object.assign(new Error('amount_must_be_positive'), { code: 'invalid_input' });
  if (!from || !to || !from.id || !to.id) throw Object.assign(new Error('from_and_to_required'), { code: 'invalid_input' });
  if (from.id === to.id) throw Object.assign(new Error('from_and_to_must_differ'), { code: 'invalid_input' });

  const fromFund = from.fund_id || null;
  const toFund = to.fund_id || null;
  // Same fund (or fundless): a straight reallocation.
  if (!fromFund || !toFund || fromFund === toFund) {
    return [
      { account_id: to.id, fund_id: toFund, debit_cents: X, credit_cents: 0, memo: 'Transfer in' },
      { account_id: from.id, fund_id: fromFund, debit_cents: 0, credit_cents: X, memo: 'Transfer out' },
    ];
  }
  // Cross-fund: one side must be Operating (interfund accounts are Operating<->sub).
  if (!resolved || !resolved.oprFundId) throw Object.assign(new Error('interfund_accounts_unavailable'), { code: 'invalid_input' });
  const opr = resolved.oprFundId;
  if (fromFund !== opr && toFund !== opr) {
    throw Object.assign(new Error('cross_fund_transfer_must_involve_operating'), { code: 'invalid_input' });
  }
  const subFund = fromFund === opr ? toFund : fromFund;
  const acc = resolved.map[subFund];
  if (!acc) throw Object.assign(new Error('no_interfund_accounts_for_fund'), { code: 'invalid_input' });

  if (toFund === opr) {
    // sub -> Operating: settle sub's debt to Operating.
    return [
      { account_id: to.id, fund_id: opr, debit_cents: X, credit_cents: 0, memo: 'Transfer in' },
      { account_id: acc.oprDueFrom, fund_id: opr, debit_cents: 0, credit_cents: X, memo: 'Settle interfund — due from fund' },
      { account_id: from.id, fund_id: subFund, debit_cents: 0, credit_cents: X, memo: 'Transfer out' },
      { account_id: acc.fundDueTo, fund_id: subFund, debit_cents: X, credit_cents: 0, memo: 'Settle interfund — due to Operating' },
    ];
  }
  // Operating -> sub: settle Operating's debt to the sub-fund.
  return [
    { account_id: to.id, fund_id: subFund, debit_cents: X, credit_cents: 0, memo: 'Transfer in' },
    { account_id: acc.fundDueFrom, fund_id: subFund, debit_cents: 0, credit_cents: X, memo: 'Settle interfund — due from Operating' },
    { account_id: from.id, fund_id: opr, debit_cents: 0, credit_cents: X, memo: 'Transfer out' },
    { account_id: acc.oprDueTo, fund_id: opr, debit_cents: X, credit_cents: 0, memo: 'Settle interfund — due to fund' },
  ];
}

// Current interfund balances for a community: how much each non-Operating fund
// owes Operating (positive) or is owed by Operating (negative), netted from the
// posted Due To / Due From lines. Powers the transfer hint + month-end reminder.
async function interfundBalances(supabase, community_id) {
  const resolved = await resolveInterfund(supabase, community_id);
  if (!resolved || !resolved.map) return [];
  const { data: funds } = await supabase.from('account_funds').select('id, fund_code, fund_name').eq('community_id', community_id);
  const fundById = new Map((funds || []).map((f) => [f.id, f]));
  // Collect every interfund account id we care about.
  const acctIds = [];
  for (const m of Object.values(resolved.map)) acctIds.push(m.fundDueTo, m.fundDueFrom, m.oprDueFrom, m.oprDueTo);
  if (!acctIds.length) return [];
  const { data: lines } = await supabase.from('journal_entry_lines')
    .select('account_id, debit_cents, credit_cents').in('account_id', acctIds);
  const bal = new Map(); // account_id -> (Dr - Cr)
  for (const l of (lines || [])) bal.set(l.account_id, (bal.get(l.account_id) || 0) + Number(l.debit_cents || 0) - Number(l.credit_cents || 0));
  const out = [];
  for (const [fundId, m] of Object.entries(resolved.map)) {
    // sub owes Operating = (sub's Due-to-Operating liability, credit-normal)
    //                      - (sub's Due-from-Operating asset, debit-normal)
    const dueTo = -(bal.get(m.fundDueTo) || 0);   // liability balance = Cr - Dr
    const dueFrom = (bal.get(m.fundDueFrom) || 0); // asset balance = Dr - Cr
    const owesOperating = dueTo - dueFrom;
    if (owesOperating !== 0) {
      const f = fundById.get(fundId) || {};
      out.push({ fund_id: fundId, fund_code: f.fund_code || null, fund_name: f.fund_name || null, owes_operating_cents: owesOperating });
    }
  }
  return out;
}

module.exports = { resolveInterfund, computeBridge, buildTransferLines, interfundBalances };
