// ============================================================================
// lib/onboarding/source_controls.js  (Issue #15) — Stage 2, provider-agnostic
// ----------------------------------------------------------------------------
// Validates the SOURCE against its own authoritative controls, using canonical
// rows only (no provider logic):
//   - GL activity debits = credits; beginning and ending trial balances balance
//   - printed Balance Sheet: assets = liabilities + equity
//   - homeowner subledger debit balances = GL AR; AR aging = GL AR; aging = ledger by account
//   - homeowner credit balances = GL prepaid owner account
//   - the human-supplied authoritative control totals (e.g. the issue's list)
// Account roles (which GL account is AR, prepaid, cash...) come from the batch
// configuration, never from a hard-coded chart.
// Existing Trusted balances are NOT a target here; this stage never reads Trusted.
// ============================================================================
const C = require('./controls');

const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const of = (parsed, type, domain) => ((parsed[type] && parsed[type].rows) || []).filter((r) => r.domain === domain);

function sourceControls(parsed, { roles = {}, expected = {} } = {}) {
  const out = [];
  const bal = of(parsed, 'gl_trial_balance', 'gl_account_balance');
  const glEnd = (code) => { const r = bal.find((x) => x.account_code === code); return r ? r.ending_cents : null; };
  const need = (types) => types.filter((t) => !parsed[t]);

  if (bal.length) {
    out.push(C.equals('gl.activity_debits_equal_credits', { label: 'GL activity: total debits = total credits', left: sum(bal, 'debit_cents'), right: sum(bal, 'credit_cents'), leftLabel: 'debits', rightLabel: 'credits' }));
    out.push(C.equals('gl.beginning_trial_balance_balances', { label: 'GL beginning trial balance nets to zero', left: sum(bal, 'beginning_cents'), right: 0, leftLabel: 'net beginning', rightLabel: 'zero' }));
    out.push(C.equals('gl.ending_trial_balance_balances', { label: 'GL ending trial balance nets to zero', left: sum(bal, 'ending_cents'), right: 0, leftLabel: 'net ending', rightLabel: 'zero' }));
  } else out.push(C.blocked('gl.trial_balance', { label: 'GL trial balance controls', reason: 'no GL trial balance artifact', needs: ['gl_trial_balance'] }));

  const bs = of(parsed, 'balance_sheet', 'statement_line');
  if (bs.length) {
    const s = (sec) => sum(bs.filter((r) => r.section === sec), 'amount_cents');
    out.push(C.equals('balance_sheet.assets_equal_liabilities_plus_equity', { label: 'Balance Sheet: assets = liabilities + equity', left: s('assets'), right: s('liabilities') + s('equity'), leftLabel: 'assets', rightLabel: 'liabilities + equity' }));
  } else out.push(C.blocked('balance_sheet.assets_equal_liabilities_plus_equity', { label: 'Balance Sheet: assets = liabilities + equity', reason: 'no balance sheet artifact', needs: ['balance_sheet'] }));

  // Homeowner subledger vs GL.
  // The subledger (homeowner transaction history) holds CURRENT owners only. Where an AR aging is
  // supplied, the account-level model is (per current owner, all at the cutoff):
  //     ledger balance = AR aging balance - prepaid credit
  // An account can carry an aged balance (AR aging; may be negative) AND an unapplied prepayment
  // (prepaid report, GL prepaid) at the same time; the ledger shows only the net. AR-aging rows the
  // source EXPLICITLY marks as previous owners (previous_owner, Vantaca's "***") are not expected in
  // the current-owner subledger; an unmarked AR row with no current-owner ledger account is a
  // per-account failure (never inferred to be a previous owner). Every AR row without a ledger account
  // stays in the GL AR tie. Without a prepaid report, a ledger credit is
  // taken to be the prepaid credit (the original assumption). Without an AR aging, the original
  // controls run unchanged. Real differences still fail: the identity is exact, no tolerance.
  const accts = of(parsed, 'homeowner_transactions', 'homeowner_account');
  const aging = of(parsed, 'ar_aging', 'ar_aging_account');
  const prepaid = of(parsed, 'prepaid_homeowners', 'prepaid_credit');
  const former = prepaid.filter((p) => p.previous_owner);
  const ar = roles.ar_account ? glEnd(roles.ar_account) : null;
  const agingBy = Object.fromEntries(aging.map((a) => [a.source_account_key, a.balance_cents]));
  const ledgerKeys = new Set(accts.map((a) => a.source_account_key));
  const prepaidCur = Object.fromEntries(prepaid.filter((p) => !p.previous_owner).map((p) => [p.source_account_key, p.amount_cents]));
  const prepaidOf = (a) => (prepaid.length ? (prepaidCur[a.source_account_key] || 0) : (a.ending_cents < 0 ? -a.ending_cents : 0));
  const agingOnly = aging.filter((g) => !ledgerKeys.has(g.source_account_key));   // AR rows with no current-owner ledger account
  const agingPrevious = agingOnly.filter((g) => g.previous_owner === true);         // explicitly marked previous owners
  const agingUnmarked = agingOnly.filter((g) => g.previous_owner !== true);         // not marked: must fail per account
  const modelled = accts.length > 0 && aging.length > 0;
  if (!roles.ar_account) out.push(C.blocked('subledger.ar', { label: 'Homeowner AR controls', reason: 'batch has no ar_account role configured' }));
  else {
    if (!accts.length) out.push(C.blocked('subledger.debit_balances_equal_gl_ar', { label: 'Homeowner debit balances = GL AR', reason: 'missing homeowner subledger', needs: need(['homeowner_transactions']) }));
    else if (!modelled) out.push(C.equals('subledger.debit_balances_equal_gl_ar', { label: `Homeowner debit balances = GL AR (${roles.ar_account})`, left: sum(accts.filter((a) => a.ending_cents > 0), 'ending_cents'), right: ar, leftLabel: 'homeowner debit balances', rightLabel: 'GL AR' }));
    else {
      const left = sum(accts, 'ending_cents') + accts.reduce((s, a) => s + prepaidOf(a), 0) + sum(agingOnly, 'balance_cents');
      out.push(C.equals('subledger.debit_balances_equal_gl_ar', { label: `Homeowner AR = GL AR (${roles.ar_account}): current-owner ledger balances + their prepaid credits + AR-aging rows with no current-owner ledger account (${agingPrevious.length} marked previous owner${agingUnmarked.length ? `, ${agingUnmarked.length} not marked` : ''})`,
        left, right: ar, leftLabel: 'ledger + prepaid + previous-owner AR', rightLabel: 'GL AR' }));
    }
    if (aging.length) out.push(C.equals('ar_aging.total_equals_gl_ar', { label: `AR aging total = GL AR (${roles.ar_account})`, left: sum(aging, 'balance_cents'), right: ar, leftLabel: 'AR aging', rightLabel: 'GL AR' }));
    else out.push(C.blocked('ar_aging.total_equals_gl_ar', { label: 'AR aging total = GL AR', reason: 'missing AR aging', needs: ['ar_aging'] }));
  }
  if (modelled) {
    const failures = [];
    for (const a of accts) { const g = agingBy[a.source_account_key] || 0; const p = prepaidOf(a); if (a.ending_cents !== g - p) failures.push({ account: a.source_account_key, ledger_cents: a.ending_cents, aging_cents: g, prepaid_cents: p, difference_cents: a.ending_cents - (g - p) }); }
    for (const g of agingUnmarked) failures.push({ account: g.source_account_key, ledger_cents: null, aging_cents: g.balance_cents, reason: 'in AR aging, not marked previous owner, and no current-owner ledger account' });
    out.push(C.holds('subledger.aging_matches_ledger_by_account', { label: `Every current owner: ledger balance = AR aging balance - prepaid credit (${agingPrevious.length} AR-aging rows marked previous owner are not expected in the current-owner ledger)`, failures }));
  }
  // A prepaid / credit-balance report (when supplied) lists every unapplied credit the GL prepaid
  // account carries, including PREVIOUS owners who are not in the current-owner subledger.
  if (roles.prepaid_account && accts.length) {
    const gl = glEnd(roles.prepaid_account);
    if (!modelled) {
      const ledgerCredits = 0 - sum(accts.filter((a) => a.ending_cents < 0), 'ending_cents') || 0;   // never -0
      const credits = ledgerCredits + sum(former, 'amount_cents');
      out.push(C.equals('subledger.credit_balances_equal_gl_prepaid', { label: prepaid.length ? `Current-owner credits (ledger) + previous-owner credits (prepaid report) = GL prepaid (${roles.prepaid_account})` : `Homeowner credit balances = GL prepaid (${roles.prepaid_account})`,
        left: credits, right: gl === null ? null : -gl, leftLabel: prepaid.length ? 'ledger credits + previous-owner credits' : 'homeowner credit balances', rightLabel: 'GL prepaid',
        detail: { ledger_credits_cents: ledgerCredits, previous_owner_credits_cents: sum(former, 'amount_cents'), previous_owner_accounts: former.length, note: 'If this fails, a source does not cover every credit the GL carries (e.g. former owners). Needs a source; never a plug.' } }));
    } else {
      // Each current owner's prepaid credit, derived from ledger and aging (AR aging balance - ledger
      // balance) for every account that carries one (on the prepaid report, or a ledger credit).
      // A ledger credit that sits in AR aging as a negative balance derives to zero: it is AR, not prepaid.
      const carriers = accts.filter((a) => prepaidOf(a) !== 0 || a.ending_cents < 0);
      const derived = carriers.reduce((s, a) => s + (agingBy[a.source_account_key] || 0) - a.ending_cents, 0);
      out.push(C.equals('subledger.credit_balances_equal_gl_prepaid', { label: `Current-owner prepaid credits (AR aging - ledger) + previous-owner credits (prepaid report) = GL prepaid (${roles.prepaid_account})`,
        left: derived + sum(former, 'amount_cents'), right: gl === null ? null : -gl, leftLabel: 'derived current prepaid + previous-owner credits', rightLabel: 'GL prepaid',
        detail: { ledger_credits_cents: 0 - sum(accts.filter((a) => a.ending_cents < 0), 'ending_cents') || 0, derived_current_prepaid_cents: derived,
          previous_owner_credits_cents: sum(former, 'amount_cents'), previous_owner_accounts: former.length, note: 'If this fails, a source does not cover every credit the GL carries (e.g. former owners). Needs a source; never a plug.' } }));
    }
  }
  if (prepaid.length) {
    const gl = roles.prepaid_account ? glEnd(roles.prepaid_account) : null;
    out.push(C.equals('prepaid_report.total_equals_gl_prepaid', { label: `Prepaid report total = GL prepaid (${roles.prepaid_account || 'no role'})`, left: sum(prepaid, 'amount_cents'), right: gl === null ? null : -gl, leftLabel: 'prepaid report', rightLabel: 'GL prepaid' }));
    if (accts.length) {
      const failures = [];
      const cur = prepaid.filter((p) => !p.previous_owner);
      if (!modelled) {
        for (const p of cur) { const a = accts.find((x) => x.source_account_key === p.source_account_key); if (!a || -a.ending_cents !== p.amount_cents) failures.push({ account: p.source_account_key, report_cents: p.amount_cents, ledger_cents: a ? -a.ending_cents : null }); }
        for (const a of accts.filter((x) => x.ending_cents < 0)) if (!cur.find((p) => p.source_account_key === a.source_account_key)) failures.push({ account: a.source_account_key, report_cents: null, ledger_cents: -a.ending_cents, reason: 'ledger credit not on the prepaid report as a current owner' });
      } else {
        for (const p of cur) { const a = accts.find((x) => x.source_account_key === p.source_account_key); if (!a) { failures.push({ account: p.source_account_key, report_cents: p.amount_cents, ledger_cents: null, reason: 'current-owner credit with no current-owner ledger account' }); continue; }
          const g = agingBy[a.source_account_key] || 0; if (a.ending_cents !== g - p.amount_cents) failures.push({ account: p.source_account_key, report_cents: p.amount_cents, ledger_cents: a.ending_cents, aging_cents: g, difference_cents: a.ending_cents - (g - p.amount_cents) }); }
        for (const a of accts.filter((x) => x.ending_cents < 0)) if (!(a.source_account_key in prepaidCur) && (agingBy[a.source_account_key] || 0) !== a.ending_cents) failures.push({ account: a.source_account_key, report_cents: null, ledger_cents: a.ending_cents, aging_cents: agingBy[a.source_account_key] || 0, reason: 'ledger credit neither on the prepaid report nor in AR aging' });
      }
      for (const p of former) if (accts.find((x) => x.source_account_key === p.source_account_key)) failures.push({ account: p.source_account_key, reason: 'marked previous owner but present in the current-owner ledger' });
      out.push(C.holds('prepaid_report.current_owner_credits_match_ledger', { label: modelled
        ? 'Every current-owner credit on the prepaid report: ledger = AR aging - prepaid; every other ledger credit sits in AR aging; previous owners are not current accounts'
        : 'Every current-owner credit on the prepaid report = that account’s ledger credit (and vice versa); previous owners are not current accounts', failures }));
    }
  }

  // AP aging (when supplied): open invoices = GL AP.
  const apItems = of(parsed, 'ap_aging', 'ap_open_item');
  if (parsed.ap_aging) {
    const apGl = roles.ap_account ? glEnd(roles.ap_account) : null;
    if (!roles.ap_account) out.push(C.blocked('ap_aging.total_equals_gl_ap', { label: 'AP aging total = GL AP', reason: 'batch has no ap_account role configured', needs: ['ap_account'] }));
    else out.push(C.equals('ap_aging.total_equals_gl_ap', { label: `AP aging open invoices = GL AP (${roles.ap_account})`, left: sum(apItems, 'amount_cents'), right: apGl === null ? null : -apGl, leftLabel: 'AP aging', rightLabel: 'GL AP' }));
  }

  // Human-supplied authoritative controls: { code: { cents, derive: fn(parsed) -> cents|null, label } }
  for (const [code, spec] of Object.entries(expected)) {
    const derived = spec.derive(parsed, { glEnd, bal, bs });
    out.push(C.equals(`authoritative.${code}`, { label: spec.label || code, left: derived, right: spec.cents, leftLabel: 'derived from source', rightLabel: 'authoritative control' }));
  }
  return out;
}

module.exports = { sourceControls };
