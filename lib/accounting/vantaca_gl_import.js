// ============================================================================
// lib/accounting/vantaca_gl_import.js
// ----------------------------------------------------------------------------
// Generalized, file-driven parsers for the two Vantaca exports that drive a
// community's move to trustEd as book of record ([[project_portfolio_gl_migration]]):
//
//   parseBalanceSheet(path)  -> fund structure + per-account opening balances.
//       The Balance Sheet's COLUMNS are the funds (Operating / Reserve /
//       Savings / ...). Each account row carries its balance under exactly one
//       fund column, so the column tells us which fund the account belongs to.
//
//   parseTrialBalance(path)  -> real chart of accounts (header rows), the
//       1/1 opening (Beginning Balance column), every line of daily detail,
//       and Vantaca's ending balance per account (the tie-out target).
//
// Both replace the HARDCODED Quail Ridge one-offs (migrate_quail_ridge_gl_*.js)
// with pure functions that read ANY community's export. No DB, no I/O beyond
// reading the file — the driver (scripts/migrate_community_gl.js) does the rest.
//
// Column layout is fixed by Vantaca's report templates (verified against
// Quail Ridge, Waterview, and Lakes of Pine Forest exports, 2026-06):
//   Trial Balance detail: col1=Date col2=LedgerID col3=Description
//                         col8=Debit col10=Credit col12=Type
//   Trial Balance acct header: col0="NNNN - Name" col7=Beginning col8=Debit
//                         col10=Credit col11=Ending
// ============================================================================
const XLSX = require('xlsx');

// "$1,234.56" / "(1,234.56)" / "-" / "" -> number (dollars). Parens & leading
// minus both mean negative; "-" alone means zero (Vantaca's empty-cell glyph).
function num(v) {
  let t = String(v == null ? '' : v).trim();
  if (t === '' || t === '-') return 0;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/[\s$]/g, ''));
  t = t.replace(/[^0-9.]/g, '');
  const n = parseFloat(t) || 0;
  return neg ? -n : n;
}
const cents = (dollars) => Math.round(dollars * 100);

// Account type + normal balance inferred from Vantaca's number prefix.
// 1=asset 2=liability 3=equity 4=revenue 5/6/7=expense. Contra accounts
// (allowance, accumulated depreciation) keep their parent type but the
// opening sign reveals the true normal balance — the driver trusts the
// signed opening, this is only the default.
function classify(num4) {
  const d = String(num4)[0];
  switch (d) {
    case '1': return { type: 'asset', normal_balance: 'debit', subtype: 'current_asset' };
    case '2': return { type: 'liability', normal_balance: 'credit', subtype: 'current_liability' };
    case '3': return { type: 'equity', normal_balance: 'credit', subtype: 'fund_balance' };
    case '4': return { type: 'revenue', normal_balance: 'credit', subtype: 'operating_revenue' };
    default: return { type: 'expense', normal_balance: 'debit', subtype: 'operating_expense' };
  }
}

function readSheet(path, sheetName) {
  const wb = XLSX.readFile(path);
  const ws = sheetName ? wb.Sheets[sheetName] : wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`sheet not found in ${path} (have: ${wb.SheetNames.join(', ')})`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
}

// ---------------------------------------------------------------------------
// parseBalanceSheet(path) -> { association, asOf, funds, accounts }
//   funds:    [{ code, name, colIndex }]  derived from the column headers
//   accounts: [{ number, name, fund_code, opening_cents }]  opening signed
//             so debits are +, credits are - (matches the opening-JE convention)
// The header row is the one starting "Assets" — its non-empty cells after col0
// (minus the trailing "Total") are the fund columns. A 3-letter code is coined
// per fund name: Operating->OPR, Reserve->RES, Savings->SAV, else first 3 chars.
//
// FUND ACCOUNTING: each fund is its own balanced book, so an account can carry
// a balance in MORE THAN ONE fund column (equity accounts like Current Year
// Surplus / Accumulated Fund Balance routinely do). We emit one opening line
// per (account, fund) cell that is non-zero — never collapse to a single fund —
// or the opening JE silently loses the other funds' balances.
// ---------------------------------------------------------------------------
const FUND_CODE = (name) => {
  const n = String(name).trim().toLowerCase();
  if (n.startsWith('oper')) return 'OPR';
  if (n.startsWith('reserv')) return 'RES';
  if (n.startsWith('sav')) return 'SAV';
  if (n.startsWith('capital')) return 'CAP';
  if (n.startsWith('special')) return 'SPA';
  return String(name).trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'OPR';
};

function parseBalanceSheet(path) {
  const rows = readSheet(path);
  const association = String((rows[0] || [])[0] || '').trim();
  const asOfRow = String((rows[1] || [])[0] || '');
  const asOf = (asOfRow.match(/as of\s+(.+)$/i) || [])[1] || null;

  // Locate the column-header row ("Assets", <fund>, <fund>, ..., "Total").
  const hdrIdx = rows.findIndex((r) => String((r || [])[0] || '').trim().toLowerCase() === 'assets');
  if (hdrIdx < 0) throw new Error('balance sheet: no "Assets" header row found');
  const hdr = rows[hdrIdx];
  const funds = [];
  for (let c = 1; c < hdr.length; c++) {
    const label = String(hdr[c] || '').trim();
    if (!label || /^total/i.test(label)) continue;
    funds.push({ code: FUND_CODE(label), name: label.replace(/\s+$/, ''), colIndex: c });
  }

  // Walk account rows ("NNNN - Name", ...). Emit one line per non-zero fund
  // cell. Liabilities/equity are credit-normal: a positive figure on the BS
  // means a credit, so flip sign for those so the opening JE convention holds
  // (+ = debit, - = credit).
  const accounts = [];
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const m = String(r[0] || '').trim().match(/^(\d{3,5})\s*-\s*(.+)$/);
    if (!m) continue;
    const number = m[1];
    const name = m[2].trim();
    const isCredit = /^[23]/.test(number);
    for (const f of funds) {
      const v = num(r[f.colIndex]);
      if (v === 0) continue;
      accounts.push({ number, name, fund_code: f.code, opening_cents: cents(isCredit ? -v : v) });
    }
  }
  return { association, asOf, funds, accounts };
}

// ---------------------------------------------------------------------------
// parseTrialBalance(path) -> { association, range, accounts, byDay }
//   accounts: [{ number, name, type, normal_balance, subtype,
//                beginning_cents, debit_cents, credit_cents, ending_cents }]
//   byDay:    { 'YYYY-MM-DD': [{ accountNumber, debit_cents, credit_cents,
//                                description, type, ledgerId }] }
// beginning/ending are SIGNED debit-positive. byDay preserves every detail line
// for line-level daily journal entries (each day must balance — driver checks).
// ---------------------------------------------------------------------------
function parseTrialBalance(path) {
  const rows = readSheet(path, 'GLTrialBalance');
  const association = String((rows[0] || [])[0] || '').trim();
  const range = String((rows[1] || [])[0] || '').replace(/^GL Trial Balance\s*/i, '').trim();

  const accounts = [];
  const byAcct = {};
  const byDay = {};
  let cur = null;
  for (const r of rows) {
    if (!r) continue;
    const c0 = String(r[0] || '').trim();
    const hm = c0.match(/^(\d{3,5})\s*-\s*(.+)$/);
    if (hm) {
      const number = hm[1];
      const cls = classify(number);
      const beginning = num(r[7]);            // signed dollars, debit-positive
      const debit = num(r[8]);
      const credit = num(r[10]);
      const ending = num(r[11]);
      cur = {
        number, name: hm[2].trim(), ...cls,
        beginning_cents: cents(beginning), debit_cents: cents(debit),
        credit_cents: cents(credit), ending_cents: cents(ending),
      };
      accounts.push(cur);
      byAcct[number] = cur;
      continue;
    }
    const dm = String(r[1] || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!cur || !dm) continue;
    const debit = cents(num(r[8])), credit = cents(num(r[10]));
    if (debit === 0 && credit === 0) continue;
    const iso = `${dm[3]}-${dm[1]}-${dm[2]}`;
    (byDay[iso] = byDay[iso] || []).push({
      accountNumber: cur.number, debit_cents: debit, credit_cents: credit,
      description: String(r[3] || '').trim(), type: String(r[12] || '').trim(),
      ledgerId: String(r[2] || '').trim() || null,
    });
  }
  return { association, range, accounts, byDay };
}

module.exports = { parseBalanceSheet, parseTrialBalance, num, cents, classify, FUND_CODE };
