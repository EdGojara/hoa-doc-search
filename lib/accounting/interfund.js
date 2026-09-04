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

module.exports = { resolveInterfund, computeBridge };
