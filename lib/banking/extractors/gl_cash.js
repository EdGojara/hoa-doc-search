// ============================================================================
// lib/banking/extractors/gl_cash.js
// ----------------------------------------------------------------------------
// Parse a Vantaca "GL Trial Balance" detail .xls into per-account transactions.
// The bank reconciliation reconciles to the GL (the complete book — every
// deposit, check, ACH, fee, interest), so this is the authoritative book side
// for pre-cutover periods (trustEd's own GL covers post-cutover).
//
// Layout: an account header row ("1000 - Operating Cash Account" with beginning
// / debit / credit / ending), then a column-header row (Date, Ledger ID,
// Description, Debit, Credit, Type), then transaction rows, repeating per
// account. Amounts: "$x" debit / credit, "-" for zero, "($x)" negative.
//
//   parseGlTrialBalance(buffer) -> { period_start, period_end, accounts:[{
//       account_number, account_name, beginning_cents, ending_cents,
//       transactions:[{date, ledger_id, description, amount_cents(signed: debit
//       positive, credit negative), type}] }] }
//   cashTransactions(parsed, accountNumber='1000') -> the cash account's txns
// ============================================================================

const XLSX = require('xlsx');

const RE_ACCT = /^(\d{3,6})\s*-\s*(.+)$/;
const RE_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function toIso(v) {
  const m = String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
}
function toCents(v) {
  const t = String(v == null ? '' : v).trim();
  if (t === '' || t === '-' || !/\d/.test(t)) return 0;
  const neg = /^\(/.test(t) || /-/.test(t.replace(/[^-\d]/g, '').slice(0, 1));
  const n = Number(t.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(n) ? (neg ? -1 : 1) * Math.round(n * 100) : 0;
}

function parseRows(rows) {
  let period_start = null, period_end = null;
  const accounts = [];
  let acct = null;
  let dateCol = 1, debitCol = 8, creditCol = 10, descCol = 3, ledgerCol = 2, typeCol = 12;

  for (const raw of rows) {
    const cells = (raw || []).map((c) => (c == null ? '' : String(c).trim()));
    const joined = cells.join(' ');

    if (!period_end && /trial balance for/i.test(joined)) {
      const m = joined.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (m) { period_start = toIso(m[1]); period_end = toIso(m[2]); }
      continue;
    }
    // column-header row — lock in the column positions by content
    if (cells.some((c) => /^date$/i.test(c)) && cells.some((c) => /^debit$/i.test(c))) {
      dateCol = cells.findIndex((c) => /^date$/i.test(c));
      debitCol = cells.findIndex((c) => /^debit$/i.test(c));
      creditCol = cells.findIndex((c) => /^credit$/i.test(c));
      descCol = cells.findIndex((c) => /^description$/i.test(c));
      ledgerCol = cells.findIndex((c) => /ledger/i.test(c));
      typeCol = cells.findIndex((c) => /^type$/i.test(c));
      continue;
    }
    // account header
    const hm = (cells[0] || '').match(RE_ACCT);
    if (hm) {
      acct = {
        account_number: hm[1], account_name: hm[2].trim(),
        beginning_cents: toCents(cells[7]) || toCents(cells[6]),
        ending_cents: toCents(cells[11]) || toCents(cells[12]),
        transactions: [],
      };
      accounts.push(acct);
      continue;
    }
    if (!acct) continue;
    const date = toIso(cells[dateCol]);
    if (!date) continue;
    const amt = toCents(cells[debitCol]) - toCents(cells[creditCol]);
    if (amt === 0) continue;
    acct.transactions.push({
      date,
      ledger_id: cells[ledgerCol] || null,
      description: cells[descCol] || '',
      amount_cents: amt,
      type: cells[typeCol] || null,
    });
  }
  return { period_start, period_end, accounts };
}

function parseGlTrialBalance(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return parseRows(rows);
}

function cashTransactions(parsed, accountNumber = '1000') {
  const a = (parsed.accounts || []).find((x) => x.account_number === accountNumber);
  return a ? a.transactions : [];
}

module.exports = { parseGlTrialBalance, parseRows, cashTransactions, toCents, toIso };
