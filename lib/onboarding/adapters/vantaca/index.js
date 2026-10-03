// ============================================================================
// lib/onboarding/adapters/vantaca/index.js  (Issue #15) — read-only Vantaca adapter
// ----------------------------------------------------------------------------
// Input: text from `pdftotext -layout` of the ORIGINAL Vantaca report PDFs.
// Output: canonical rows + extraction controls (parsed rows vs the report's
// own printed totals) + Vantaca reporting-mechanics controls.
//
// Vantaca mechanic, verified on Quail Ridge 7/31/2026: the GL keeps account
// 3000 "Current Year Surplus/(Deficit)" at its carried balance all year, and
// the Balance Sheet DISPLAYS 3000 as that carried balance plus the current
// period's P&L result. So BS 3000 = -(GL 3000 ending) + (revenue - expense).
// This lives here, not in core, because it is a Vantaca presentation rule.
// ============================================================================
const P = require('./parsers');
const C = require('../../controls');

const ARTIFACT_TYPES = ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'gl_transactions_csv'];

function parse(artifactType, text, artifact, opts = {}) {
  switch (artifactType) {
    case 'gl_trial_balance': return P.parseGlTrialBalance(text, artifact, opts);
    case 'balance_sheet': return P.parseBalanceSheet(text, artifact, opts);
    case 'ar_aging': return P.parseArAging(text, artifact, opts);
    case 'homeowner_transactions': return P.parseHomeownerTransactions(text, artifact, opts);
    case 'gl_transactions_csv': return P.parseNormalizedGlCsv(text, artifact, opts);
    default: throw new Error(`vantaca adapter: unsupported artifact type ${artifactType}`);
  }
}

const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const X = C.LEVEL.EXTRACTION;

// Extraction controls: did the adapter read everything the report printed?
function extractionControls(parsed) {
  const out = [];
  for (const [type, p] of Object.entries(parsed)) {
    out.push(C.holds(`${type}.no_unreadable_lines`, { label: `${type}: every data line parsed`, level: X, failures: p.defects }));
  }
  const gl = parsed.gl_trial_balance;
  const tieToPrinted = (bal, tx) => {
    const failures = [];
    for (const a of bal) {
      const t = tx.filter((r) => r.account_code === a.account_code);
      const d = sum(t, 'debit_cents'), c = sum(t, 'credit_cents');
      if (d !== a.debit_cents || c !== a.credit_cents) failures.push({ account: a.account_code, parsed_debit_cents: d, printed_debit_cents: a.debit_cents, parsed_credit_cents: c, printed_credit_cents: a.credit_cents });
    }
    for (const code of new Set(tx.map((r) => r.account_code))) if (!bal.find((a) => a.account_code === code)) failures.push({ account: code, reason: 'account not on the printed GL' });
    return failures;
  };
  if (parsed.gl_transactions_csv) {
    out.push(gl
      ? C.holds('gl_transactions_csv.ties_to_printed_account_totals', { label: 'Normalized GL CSV: rows add to the printed per-account totals of the original GL report', level: X, failures: tieToPrinted(gl.rows.filter((r) => r.domain === 'gl_account_balance'), parsed.gl_transactions_csv.rows) })
      : C.blocked('gl_transactions_csv.ties_to_printed_account_totals', { label: 'Normalized GL CSV ties to the original GL report', level: X, reason: 'a normalized CSV can only be used against the original GL report', needs: ['gl_trial_balance'] }));
  }
  if (gl) {
    const bal = gl.rows.filter((r) => r.domain === 'gl_account_balance'); const tx = gl.rows.filter((r) => r.domain === 'gl_transaction');
    const rollFail = [];
    for (const a of bal) if (a.beginning_cents + a.debit_cents - a.credit_cents !== a.ending_cents) rollFail.push({ account: a.account_code });
    const sumFail = tieToPrinted(bal, tx);
    out.push(C.holds('gl.accounts_roll_forward', { label: 'GL: beginning + debits - credits = ending, every account', level: X, failures: rollFail }));
    out.push(C.holds('gl.transactions_tie_to_printed_account_totals', { label: 'GL: parsed transaction lines add to each account\'s printed debit/credit totals', level: X, failures: sumFail }));
  }
  const ag = parsed.ar_aging;
  if (ag) {
    const heads = ag.rows.filter((r) => r.domain === 'ar_aging_account'); const items = ag.rows.filter((r) => r.domain === 'ar_aging_item');
    const itemFail = [];
    for (const h of heads) { const it = items.filter((r) => r.source_account_key === h.source_account_key); for (const k of ['current_cents', 'over_30_cents', 'over_60_cents', 'over_90_cents', 'balance_cents']) if (sum(it, k) !== h[k]) { itemFail.push({ account: h.source_account_key, bucket: k }); break; } }
    out.push(C.holds('ar_aging.items_tie_to_account_totals', { label: 'AR aging: charge lines add to each account total', level: X, failures: itemFail }));
    const pt = ag.printed.total;
    for (const k of ['current_cents', 'over_30_cents', 'over_60_cents', 'over_90_cents', 'balance_cents']) {
      out.push(C.equals(`ar_aging.accounts_tie_to_printed_total.${k.replace('_cents', '')}`, { label: `AR aging: parsed accounts add to the printed ${k.replace('_cents', '')} total`, level: X, left: sum(heads, k), right: pt ? pt[k] : null, leftLabel: 'parsed accounts', rightLabel: 'printed Total' }));
    }
  }
  const led = parsed.homeowner_transactions;
  if (led) out.push(C.holds('ledger.day_end_balances_follow', { label: 'Homeowner ledger: each day-end printed balance = prior day-end + that day\'s activity', level: X, failures: led.printed.day_balance_breaks }));
  const bs = parsed.balance_sheet;
  if (bs) {
    const t = bs.printed.totals; const lines = bs.rows;
    const sec = (s) => sum(lines.filter((r) => r.section === s), 'amount_cents');
    out.push(C.equals('balance_sheet.asset_lines_tie', { label: 'Balance Sheet: asset lines add to Total Assets', level: X, left: sec('assets'), right: t['total assets'] ?? null, leftLabel: 'asset lines', rightLabel: 'Total Assets' }));
    out.push(C.equals('balance_sheet.liability_lines_tie', { label: 'Balance Sheet: liability lines add to Total Liabilities', level: X, left: sec('liabilities'), right: t['total liabilities'] ?? null, leftLabel: 'liability lines', rightLabel: 'Total Liabilities' }));
    out.push(C.equals('balance_sheet.equity_lines_tie', { label: 'Balance Sheet: equity lines add to Total Equity', level: X, left: sec('equity'), right: t['total equity'] ?? null, leftLabel: 'equity lines', rightLabel: 'Total Equity' }));
  }
  return out;
}

// Vantaca presentation mechanics: the printed Balance Sheet vs the GL.
function mechanicsControls(parsed, { current_year_equity_account = '3000', revenue_prefixes = ['4'], expense_prefixes = ['5', '6', '7', '8', '9'] } = {}) {
  const out = []; const gl = parsed.gl_trial_balance; const bs = parsed.balance_sheet;
  if (!gl || !bs) return [C.blocked('vantaca.balance_sheet_vs_gl', { label: 'Balance Sheet lines equal GL ending balances', reason: 'needs both gl_trial_balance and balance_sheet', needs: ['gl_trial_balance', 'balance_sheet'] })];
  const bal = Object.fromEntries(gl.rows.filter((r) => r.domain === 'gl_account_balance').map((r) => [r.account_code, r.ending_cents]));
  const pl = Object.entries(bal).filter(([a]) => revenue_prefixes.some((p) => a.startsWith(p)) || expense_prefixes.some((p) => a.startsWith(p)));
  const netIncome = -pl.reduce((s, [, v]) => s + v, 0);   // credit-positive result
  for (const line of bs.rows) {
    const a = line.account_code; const glEnd = bal[a];
    if (glEnd === undefined) { out.push(C.blocked(`vantaca.bs_vs_gl.${a}`, { label: `Balance Sheet ${a} has a GL account`, reason: `GL has no account ${a}` })); continue; }
    const presented = line.section === 'assets' ? glEnd : -glEnd;
    if (a === current_year_equity_account) {
      out.push(C.equals(`vantaca.bs_vs_gl.${a}`, { label: `Balance Sheet ${a} = GL ${a} carried balance + current-period P&L result (Vantaca display rule)`, left: line.amount_cents, right: presented + netIncome, leftLabel: 'Balance Sheet', rightLabel: `GL ${a} + P&L`, detail: { gl_carried_cents: presented, current_period_result_cents: netIncome } }));
    } else {
      out.push(C.equals(`vantaca.bs_vs_gl.${a}`, { label: `Balance Sheet ${a} = GL ${a} ending`, left: line.amount_cents, right: presented, leftLabel: 'Balance Sheet', rightLabel: 'GL ending' }));
    }
  }
  return out;
}

module.exports = {
  provider: 'vantaca',
  version: '1.0.0',
  input_format: 'pdftotext -layout text of the original Vantaca PDF',
  artifact_types: ARTIFACT_TYPES,
  parse,
  extractionControls,
  mechanicsControls,
};
