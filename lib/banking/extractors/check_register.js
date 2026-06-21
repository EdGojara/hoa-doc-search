// ============================================================================
// lib/banking/extractors/check_register.js
// ----------------------------------------------------------------------------
// Parse a Vantaca "Check Register Report" .xls — the issued-check side of a
// bank reconciliation (and the basis for check processing). Columns:
//   Date | Description (payee) | Type | Check No | Amount   (amounts in parens
// are disbursements / negative). Segmented by account header ("QR Operating -
// 4536"). One check number can carry MULTIPLE lines (several invoices paid on
// one check, e.g. check #26 = 4× $476.30 Superior Lawncare) — we group by check
// number and total them, keeping the line detail.
//
// A check clears the bank as ONE debit equal to its total; checks not yet on
// the bank statement are outstanding (reduce the bank-side balance).
//
//   parseCheckRegister(buffer) -> { accounts:[{account_label, account_last4,
//       checks:[{check_number, date, payee, amount_cents, lines:[{description,
//       amount_cents}]}], total_cents}], total_cents, warnings }
//   checksToMatcherShape(checks) -> [{check_number, amount_cents, issue_date,
//       payee, status}]  (feeds reconcile()'s checkRegisterChecks)
// ============================================================================

const XLSX = require('xlsx');

const RE_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const RE_MONEY = /^\(?\$?[\d,]+\.\d{2}\)?$/;     // 550.00, $550.00, ($550.00)
const RE_CHECKNO = /^\d{1,7}$/;
const RE_ACCT_HEADER = /-\s*(\d{3,6})\s*$/;
const RE_TYPE = /^(invoice check|hand check|manual check|eft|ach|wire|void|printed check)/i;

function toIso(s) {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
}
// magnitude in cents (sign dropped — disbursement direction is implied)
function toCents(a) {
  const n = Number(String(a).replace(/[()$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function parseRows(rows) {
  const accounts = [];
  let current = null;
  const warnings = [];

  const ensureAccount = () => {
    if (!current) { current = { account_label: 'Unknown', account_last4: null, _byNum: {}, checks: [], total_cents: 0 }; accounts.push(current); }
    return current;
  };

  for (const raw of rows) {
    const cells = (raw || []).map((c) => (c == null ? '' : String(c).trim()));
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) continue;

    const dateCell = cells.find((c) => RE_DATE.test(c));
    const checkNoCell = cells.find((c) => RE_CHECKNO.test(c) && c !== dateCell);
    const amountCell = cells.find((c) => RE_MONEY.test(c));

    // Check line: has a check number + an amount (and usually a date).
    if (checkNoCell && amountCell && dateCell) {
      const acct = ensureAccount();
      const payee = cells.find((c) => c && c !== dateCell && c !== checkNoCell && c !== amountCell && !RE_DATE.test(c) && !RE_MONEY.test(c) && !RE_TYPE.test(c) && !RE_CHECKNO.test(c)) || '';
      const amount_cents = toCents(amountCell);
      if (amount_cents == null) { warnings.push(`Unparseable check amount: ${nonEmpty.join(' | ').slice(0, 50)}`); continue; }
      const num = checkNoCell;
      if (!acct._byNum[num]) {
        acct._byNum[num] = { check_number: num, date: toIso(dateCell), payee, amount_cents: 0, lines: [] };
        acct.checks.push(acct._byNum[num]);
      }
      acct._byNum[num].amount_cents += amount_cents;
      acct._byNum[num].lines.push({ description: payee, amount_cents });
      if (!acct._byNum[num].payee && payee) acct._byNum[num].payee = payee;
      continue;
    }

    // Total row — ignore.
    if (/^total$/i.test(nonEmpty[0]) || nonEmpty.some((c) => /^total$/i.test(c))) continue;

    // Account header.
    const hdr = cells.find((c) => RE_ACCT_HEADER.test(c) && !RE_DATE.test(c) && !RE_MONEY.test(c));
    if (hdr && !dateCell) {
      current = { account_label: hdr, account_last4: (hdr.match(RE_ACCT_HEADER) || [])[1] || null, _byNum: {}, checks: [], total_cents: 0 };
      accounts.push(current);
    }
  }

  let total_cents = 0;
  for (const a of accounts) { delete a._byNum; a.total_cents = a.checks.reduce((s, c) => s + c.amount_cents, 0); total_cents += a.total_cents; }
  return { accounts: accounts.filter((a) => a.checks.length), total_cents, warnings };
}

function parseCheckRegister(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return parseRows(rows);
}

// Shape the matcher expects for checkRegisterChecks (one row per check, total).
function checksToMatcherShape(checks) {
  return (checks || []).map((c) => ({
    check_number: c.check_number,
    amount_cents: c.amount_cents,
    issue_date: c.date,
    payee: c.payee,
    status: 'issued',
  }));
}

module.exports = { parseCheckRegister, parseRows, checksToMatcherShape };
