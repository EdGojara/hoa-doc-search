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

  // Homeowner subledger vs GL
  const accts = of(parsed, 'homeowner_transactions', 'homeowner_account');
  const aging = of(parsed, 'ar_aging', 'ar_aging_account');
  const ar = roles.ar_account ? glEnd(roles.ar_account) : null;
  if (!roles.ar_account) out.push(C.blocked('subledger.ar', { label: 'Homeowner AR controls', reason: 'batch has no ar_account role configured' }));
  else {
    if (accts.length) out.push(C.equals('subledger.debit_balances_equal_gl_ar', { label: `Homeowner debit balances = GL AR (${roles.ar_account})`, left: sum(accts.filter((a) => a.ending_cents > 0), 'ending_cents'), right: ar, leftLabel: 'homeowner debit balances', rightLabel: 'GL AR' }));
    else out.push(C.blocked('subledger.debit_balances_equal_gl_ar', { label: 'Homeowner debit balances = GL AR', reason: 'missing homeowner subledger', needs: need(['homeowner_transactions']) }));
    if (aging.length) out.push(C.equals('ar_aging.total_equals_gl_ar', { label: `AR aging total = GL AR (${roles.ar_account})`, left: sum(aging, 'balance_cents'), right: ar, leftLabel: 'AR aging', rightLabel: 'GL AR' }));
    else out.push(C.blocked('ar_aging.total_equals_gl_ar', { label: 'AR aging total = GL AR', reason: 'missing AR aging', needs: ['ar_aging'] }));
  }
  if (accts.length && aging.length) {
    const ag = Object.fromEntries(aging.map((a) => [a.source_account_key, a.balance_cents]));
    const failures = [];
    for (const a of accts) { const want = a.ending_cents > 0 ? a.ending_cents : 0; if ((ag[a.source_account_key] || 0) !== want) failures.push({ account: a.source_account_key, ledger_cents: a.ending_cents, aging_cents: ag[a.source_account_key] || 0 }); }
    for (const g of aging) if (!accts.find((a) => a.source_account_key === g.source_account_key)) failures.push({ account: g.source_account_key, ledger_cents: null, aging_cents: g.balance_cents, reason: 'in aging, not in subledger' });
    out.push(C.holds('subledger.aging_matches_ledger_by_account', { label: 'Every account: AR aging balance = subledger debit balance', failures }));
  }
  // A prepaid / credit-balance report (when supplied) lists every credit the GL carries,
  // including PREVIOUS owners who are not in the current-owner subledger. Keyed by account.
  const prepaid = of(parsed, 'prepaid_homeowners', 'prepaid_credit');
  const former = prepaid.filter((p) => p.previous_owner);
  if (roles.prepaid_account && accts.length) {
    const ledgerCredits = 0 - sum(accts.filter((a) => a.ending_cents < 0), 'ending_cents') || 0;   // never -0
    const credits = ledgerCredits + sum(former, 'amount_cents');
    const gl = glEnd(roles.prepaid_account);
    out.push(C.equals('subledger.credit_balances_equal_gl_prepaid', { label: prepaid.length ? `Current-owner credits (ledger) + previous-owner credits (prepaid report) = GL prepaid (${roles.prepaid_account})` : `Homeowner credit balances = GL prepaid (${roles.prepaid_account})`,
      left: credits, right: gl === null ? null : -gl, leftLabel: prepaid.length ? 'ledger credits + previous-owner credits' : 'homeowner credit balances', rightLabel: 'GL prepaid',
      detail: { ledger_credits_cents: ledgerCredits, previous_owner_credits_cents: sum(former, 'amount_cents'), previous_owner_accounts: former.length, note: 'If this fails, a source does not cover every credit the GL carries (e.g. former owners). Needs a source; never a plug.' } }));
  }
  if (prepaid.length) {
    const gl = roles.prepaid_account ? glEnd(roles.prepaid_account) : null;
    out.push(C.equals('prepaid_report.total_equals_gl_prepaid', { label: `Prepaid report total = GL prepaid (${roles.prepaid_account || 'no role'})`, left: sum(prepaid, 'amount_cents'), right: gl === null ? null : -gl, leftLabel: 'prepaid report', rightLabel: 'GL prepaid' }));
    if (accts.length) {
      const failures = [];
      const cur = prepaid.filter((p) => !p.previous_owner);
      for (const p of cur) { const a = accts.find((x) => x.source_account_key === p.source_account_key); if (!a || -a.ending_cents !== p.amount_cents) failures.push({ account: p.source_account_key, report_cents: p.amount_cents, ledger_cents: a ? -a.ending_cents : null }); }
      for (const a of accts.filter((x) => x.ending_cents < 0)) if (!cur.find((p) => p.source_account_key === a.source_account_key)) failures.push({ account: a.source_account_key, report_cents: null, ledger_cents: -a.ending_cents, reason: 'ledger credit not on the prepaid report as a current owner' });
      for (const p of former) if (accts.find((x) => x.source_account_key === p.source_account_key)) failures.push({ account: p.source_account_key, reason: 'marked previous owner but present in the current-owner ledger' });
      out.push(C.holds('prepaid_report.current_owner_credits_match_ledger', { label: 'Every current-owner credit on the prepaid report = that account’s ledger credit (and vice versa); previous owners are not current accounts', failures }));
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
