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

const ARTIFACT_TYPES = ['gl_trial_balance', 'balance_sheet', 'ar_aging', 'homeowner_transactions', 'gl_transactions_csv', 'prepaid_homeowners', 'ap_aging'];

function parse(artifactType, text, artifact, opts = {}) {
  switch (artifactType) {
    case 'gl_trial_balance': return P.parseGlTrialBalance(text, artifact, opts);
    case 'balance_sheet': return P.parseBalanceSheet(text, artifact, opts);
    case 'ar_aging': return P.parseArAging(text, artifact, opts);
    case 'homeowner_transactions': return P.parseHomeownerTransactions(text, artifact, opts);
    case 'gl_transactions_csv': return P.parseNormalizedGlCsv(text, artifact, opts);
    case 'prepaid_homeowners': return P.parsePrepaidHomeowners(text, artifact, opts);
    case 'ap_aging': return P.parseApAging(text, artifact, opts);
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
  const pp = parsed.prepaid_homeowners;
  if (pp) out.push(C.equals('prepaid_homeowners.rows_tie_to_printed_total', { label: 'Prepaid homeowners: parsed account rows add to the printed total', level: X, left: sum(pp.rows, 'amount_cents'), right: pp.printed.total, leftLabel: 'parsed rows', rightLabel: 'printed Total' }));
  const apa = parsed.ap_aging;
  if (apa) {
    const pt = apa.printed.total;
    for (const k of ['current_cents', 'over_30_cents', 'over_60_cents', 'over_90_cents']) out.push(C.equals(`ap_aging.items_tie_to_printed_total.${k.replace('_cents', '')}`, { label: `AP aging: invoice rows add to the printed ${k.replace('_cents', '')} total`, level: X, left: sum(apa.rows, k), right: pt ? pt[k] : null, leftLabel: 'invoice rows', rightLabel: 'printed Total' }));
    out.push(C.equals('ap_aging.items_tie_to_printed_total.balance', { label: 'AP aging: invoice rows add to the printed Total', level: X, left: sum(apa.rows, 'amount_cents'), right: pt ? pt.balance_cents : null, leftLabel: 'invoice rows', rightLabel: 'printed Total' }));
    out.push(C.holds('ap_aging.invoice_buckets_add_to_invoice_total', { label: 'AP aging: each invoice buckets add to its total', level: X, failures: apa.rows.filter((r) => r.current_cents + r.over_30_cents + r.over_60_cents + r.over_90_cents !== r.amount_cents).map((r) => ({ invoice: r.invoice_number })) }));
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
    // Fund-column layout only: each printed line's fund amounts add to its Total, and each
    // fund column's lines add to that fund's printed section totals (a misplaced amount fails here).
    const funds = bs.printed.fund_columns;
    if (funds) {
      const fsum = (fa) => (fa || []).reduce((s, f) => s + f.amount_cents, 0);
      const ft = bs.printed.fund_totals || {};
      out.push(C.holds('balance_sheet.fund_columns_add_to_total', { label: 'Balance Sheet: on every line the fund columns add to the Total column', level: X,
        failures: [...lines.filter((r) => fsum(r.fund_amounts) !== r.amount_cents).map((r) => ({ account: r.account_code, funds_cents: fsum(r.fund_amounts), total_cents: r.amount_cents })),
          ...Object.entries(ft).filter(([k, f]) => Object.values(f).reduce((s, v) => s + v, 0) !== t[k]).map(([k, f]) => ({ total: k, funds_cents: Object.values(f).reduce((s, v) => s + v, 0), total_cents: t[k] }))] }));
      for (const fund of funds) {
        const fl = (s) => lines.filter((r) => r.section === s).reduce((acc, r) => acc + ((r.fund_amounts || []).find((f) => f.fund === fund) || { amount_cents: 0 }).amount_cents, 0);
        const printedFund = (k) => (ft[k] ? (ft[k][fund] ?? 0) : null);
        for (const [s, k, name] of [['assets', 'total assets', 'Total Assets'], ['liabilities', 'total liabilities', 'Total Liabilities'], ['equity', 'total equity', 'Total Equity']]) {
          out.push(C.equals(`balance_sheet.fund_lines_tie.${fund.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.${s}`, { label: `Balance Sheet: ${fund} ${s} lines add to its ${name}`, level: X, left: fl(s), right: printedFund(k), leftLabel: `${fund} ${s} lines`, rightLabel: `${fund} ${name}` }));
        }
      }
    }
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

// ---- Operator support (deterministic; no AI) ----------------------------------
// The source package: every report Trusted reads from Vantaca, by the name Vantaca
// prints on it, the date it must carry for a cutoff, and the file name Vantaca
// usually saves it under (so a user can find it in Downloads). ONE list: the
// start screen, recognition, the intake requests and the batch checklist all
// read it, so they cannot drift apart.
// All six are the initial financial package the user obtains; the user never
// decides which support is worth including. 'need' is INTERNAL validation only:
//   'always'      -> intake blocks without it
//   'if_balance'  -> intake blocks without it when the GL carries a balance in
//                    that role's account (requiredSources); otherwise not demanded
const PACKAGE = Object.freeze([
  { type: 'gl_trial_balance', name: 'GL Trial Balance', dated: 'period', saved_as: 'GLTrialBalance.pdf', need: 'always', why: 'the authoritative ending balance of every account at the cutoff' },
  { type: 'balance_sheet', name: 'Balance Sheet', dated: 'as_of', saved_as: 'BalanceSheet.pdf', need: 'always', why: 'the printed balance-sheet totals Trusted ties back to the GL' },
  { type: 'ar_aging', name: 'AR Aging', dated: 'as_of', saved_as: 'AR Aging.pdf', need: 'if_balance', role: 'ar_account', why: 'what each homeowner owes at the cutoff' },
  { type: 'homeowner_transactions', name: 'Homeowner Transaction History', dated: 'period', saved_as: 'TransactionHistoryAssoc.pdf', need: 'if_balance', role: 'ar_account', why: 'the homeowner activity behind each balance' },
  { type: 'prepaid_homeowners', name: 'Pre Paid Homeowners', dated: 'as_of', saved_as: 'PrepaidHomeowners.pdf', need: 'if_balance', role: 'prepaid_account', why: 'every homeowner credit, including previous owners', note: 'include previous owners' },
  { type: 'ap_aging', name: 'AP Aging', dated: 'as_of', saved_as: 'APAging.pdf', need: 'if_balance', role: 'ap_account', why: 'the open vendor invoices at the cutoff' },
]);
// Scope, said out loud: these reports establish the FINANCIAL position only.
// Party data (owner vs co-owner vs tenant/occupant, mailing address, emails,
// phones, ownership relationships) is never inferred from financial-report
// layout; the readers keep only account keys, amounts and dates (with the raw
// line as provenance). Owner / property / contact onboarding is a separate path.
function scopeStatement(cutoff) {
  return {
    kind: 'financial',
    text: `Financial conversion: these reports establish the association's accounting position through ${cutoff ? mdy(cutoff) : 'the cutoff'}. Owner, property and contact onboarding is handled separately and is not inferred from these reports.`,
    detail: 'Names or addresses printed on a financial report are never read as owner, co-owner, tenant, mailing-address, email or phone records. The Owner Changes Summary is not a roster and is not used as one.',
  };
}
const mdy = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return `${m}/${d}/${y}`; };
// The report's own title, dated for this cutoff. Period reports run from the start
// of the fiscal year; a calendar year is assumed and said, never hidden.
function reportLabel(entry, cutoff) {
  if (!cutoff) return `${entry.name} ${entry.dated === 'period' ? '(fiscal-year start through the cutoff)' : 'as of the cutoff'}${entry.note ? ` (${entry.note})` : ''}`;
  const c = mdy(cutoff);
  const base = entry.dated === 'period' ? `${entry.name} for 1/1/${c.split('/')[2]} - ${c}` : `${entry.name} as of ${c}`;
  return base + (entry.note ? ` (${entry.note})` : '');
}
function sourcePackage(cutoff) {
  return {
    provider: 'vantaca',
    cutoff: cutoff || null,
    reports: PACKAGE.map((e) => ({ type: e.type, name: e.name, report: reportLabel(e, cutoff), saved_as: e.saved_as, why: e.why,
      period_note: e.dated === 'period' ? 'if the association\'s fiscal year does not start in January, run it from the fiscal-year start' : null })),
    scope: scopeStatement(cutoff),
  };
}

// Recognize a Vantaca report from its own header text, and read the date it carries.
const HEADERS = [
  ['gl_trial_balance', /GL Trial Balance For\s+([^\n]*)/i, true],
  ['balance_sheet', /Balance Sheet For\s+([^\n]*)/i, true],
  ['balance_sheet', /Balance Sheet as of\s+([^\n]*)/i, true],   // the fund-column layout (Canyon Gate, LOPF)
  ['ar_aging', /AR Aging\s*-\s*([^\n]*)/i, true],
  ['homeowner_transactions', /Homeowner Transaction History For\s*([^\n]*)/i, false],
  ['prepaid_homeowners', /Pre Paid Homeowners For\s*([^\n]*)/i, false],
  ['ap_aging', /AP Aging for Ending Date:?\s*([^\n]*)/i, false],
];
const isoOf = (s) => { const [m, d, y] = s.split('/').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
function identify(text) {
  const head = String(text || '').slice(0, 4000);
  for (const [type, re, dateRequired] of HEADERS) {
    const m = re.exec(head); if (!m) continue;
    const dates = (m[1].match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || []).map(isoOf);
    if (dateRequired && !dates.length) continue;   // same strictness as the original header patterns
    return { type, as_of: dates.length ? dates[dates.length - 1] : null, period_start: dates.length > 1 ? dates[0] : null };
  }
  return null;
}
function detect(text) { const id = identify(text); return id ? id.type : null; }
// Does a recognized report carry the batch cutoff? ok null = it printed no date.
function cutoffCheck(id, cutoff) {
  if (!id || !cutoff || !id.as_of) return { ok: null, note: id && !id.as_of ? 'no date printed on the report' : null };
  const entry = PACKAGE.find((e) => e.type === id.type);
  if (id.as_of !== cutoff) return { ok: false, note: `this report is dated ${mdy(id.as_of)}; the cutoff is ${mdy(cutoff)}. Please run ${reportLabel(entry, cutoff)}.` };
  return { ok: true, note: null };
}

// Infer the control accounts from the SOURCE chart's own account names (overridable).
function inferRoles(parsed) {
  const bal = ((parsed.gl_trial_balance && parsed.gl_trial_balance.rows) || []).filter((r) => r.domain === 'gl_account_balance');
  const pick = (re, not) => { const hits = bal.filter((a) => re.test(a.account_name) && !(not && not.test(a.account_name))); return hits.length === 1 ? hits[0].account_code : null; };
  return { ar_account: pick(/accounts receivable/i, /allowance|doubtful/i), prepaid_account: pick(/prepaid\s+(owners?|homeowners?)|prepaid\s+assessments?/i), ap_account: pick(/accounts payable/i) };
}

// What supporting reports does this GL need? 'always' reports always; an
// 'if_balance' report only when the GL balance it supports is non-zero.
const REPORT_NAMES = Object.fromEntries(PACKAGE.map((e) => [e.type, reportLabel(e, null)]));
const WHY = { homeowner_transactions: (r) => `homeowner detail behind AR ${r.ar_account}`, ar_aging: (r) => `aging behind AR ${r.ar_account}`,
  prepaid_homeowners: (r) => `every credit behind prepaid ${r.prepaid_account}, including previous owners`, ap_aging: (r) => `open invoices behind AP ${r.ap_account}` };
function requiredSources(parsed, roles, cutoff) {
  const bal = ((parsed.gl_trial_balance && parsed.gl_trial_balance.rows) || []).filter((r) => r.domain === 'gl_account_balance');
  const end = (code) => { const a = bal.find((x) => x.account_code === code); return a ? a.ending_cents : 0; };
  const label = (e) => reportLabel(e, cutoff);
  const out = PACKAGE.filter((e) => e.need === 'always').map((e) => ({ type: e.type, why: e.why, report: label(e) }));
  if (!parsed.gl_trial_balance) return out;
  for (const e of PACKAGE.filter((x) => x.need === 'if_balance')) if (roles[e.role] && end(roles[e.role]) !== 0) out.push({ type: e.type, why: WHY[e.type](roles), report: label(e) });
  return out;
}
// The dates the parsed reports carry (for the intake cutoff request).
function reportDates(parsed) {
  const out = [];
  const add = (t, d) => { if (parsed[t] && d) out.push({ type: t, as_of: d }); };
  add('gl_trial_balance', parsed.gl_trial_balance && parsed.gl_trial_balance.period && parsed.gl_trial_balance.period.end);
  add('balance_sheet', parsed.balance_sheet && parsed.balance_sheet.as_of);
  add('ar_aging', parsed.ar_aging && parsed.ar_aging.as_of);
  add('homeowner_transactions', parsed.homeowner_transactions && parsed.homeowner_transactions.period && parsed.homeowner_transactions.period.end);
  add('prepaid_homeowners', parsed.prepaid_homeowners && parsed.prepaid_homeowners.as_of);
  add('ap_aging', parsed.ap_aging && parsed.ap_aging.as_of);
  return out;
}

module.exports = {
  detect,
  identify,
  cutoffCheck,
  sourcePackage,
  reportLabel,
  reportDates,
  PACKAGE,
  inferRoles,
  requiredSources,
  REPORT_NAMES,
  provider: 'vantaca',
  version: '1.0.0',
  input_format: 'pdftotext -layout text of the original Vantaca PDF',
  artifact_types: ARTIFACT_TYPES,
  parse,
  extractionControls,
  mechanicsControls,
};
