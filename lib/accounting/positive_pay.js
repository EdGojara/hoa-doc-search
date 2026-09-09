// ============================================================================
// lib/accounting/positive_pay.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// Positive Pay issued-check file for NewFirst National Bank. The bank clears a
// presented check only if it matches a check we told them we issued — the fraud
// control. NewFirst confirmed (Melody Hess, 2026-09-09, "Sample PP File - ACCT #
// INCLUDED.csv") that ALL operating accounts go in ONE combined file, with the
// account number as a column — so one upload per check run, not one per account.
// The format is a HEADER row + one row per check:
//
//   DATE ,CHECK #,CHECK PAYEE,CHECK AMOUNT ,ACCOUNT #
//   3/3/2022,31852,Joh Doe Rentals,478.30,123456
//
// Header text matches the bank's sample verbatim (regulated-content rule). Upload
// is manual through NewFirst Treasury Management (they have no API/SFTP yet), so
// this just produces the file for a person to upload after a check run.
//
// PAYEE MUST CARRY NO PUNCTUATION. NewFirst Treasury Management (Madilyn Matura,
// via Melody Hess, 2026-09-08) confirmed: "They should not use any punctuation in
// the payee column because it will throw the items into exceptions." So a payee
// like "RABKA PEST CONTROL, LLC" or "O'Brien & Sons, Inc." is stripped to letters,
// digits, and single spaces ("RABKA PEST CONTROL LLC" / "O Brien Sons Inc") before
// it is written — NOT CSV-quoted, which the bank still rejects.
// ============================================================================

// M/D/YYYY with no leading zeros, from a YYYY-MM-DD (or Date) — the sample's shape.
function fmtDate(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  const dt = new Date(d);
  if (!isNaN(dt)) return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
  return s;
}

// Quote a CSV field only if it needs it (comma, quote, or newline).
function csv(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// NewFirst rejects ANY punctuation in the payee column (throws exceptions), so we
// strip everything that isn't a letter, digit, or space, then collapse runs of
// whitespace to one space and trim. Commas, periods, apostrophes, quotes, #, &,
// hyphens, slashes — all removed. "RABKA PEST CONTROL, LLC" -> "RABKA PEST CONTROL LLC".
function sanitizePayee(name) {
  return String(name == null ? '' : name)
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The bank's column header, verbatim from "Sample PP File - ACCT # INCLUDED.csv".
const PP_HEADER = 'DATE ,CHECK #,CHECK PAYEE,CHECK AMOUNT ,ACCOUNT #';

// Bank account numbers are digits; strip anything else (a "1777"/"ending 1777"
// slip would misroute the row). Blank when we have no account on the check.
function acctDigits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

/**
 * @param checks array of { issue_date, check_number, payee_name, amount_cents, account_number }
 * @returns { csv, count, total_cents, missing_account } — NewFirst combined CSV:
 *          a header row + one row per check, all accounts in one file.
 */
function generatePositivePayCsv(checks) {
  const valid = (checks || []).filter((c) => c && c.check_number && Number(c.amount_cents) > 0);
  const rows = valid.map((c) => [
    fmtDate(c.issue_date),
    String(c.check_number).trim(),
    csv(sanitizePayee(c.payee_name)), // punctuation stripped — bank throws exceptions otherwise
    (Number(c.amount_cents) / 100).toFixed(2),
    acctDigits(c.account_number),     // ACCOUNT # — routes the row to the right operating account
  ].join(','));
  const body = rows.length ? (rows.join('\r\n') + '\r\n') : ''; // CRLF — banks parse it most reliably
  return {
    csv: PP_HEADER + '\r\n' + body,
    count: rows.length,
    total_cents: valid.reduce((a, c) => a + (Number(c.amount_cents) || 0), 0),
    // A row with no account number can't be matched by the bank — surface it so a
    // person fixes it before upload rather than the bank silently rejecting it.
    missing_account: valid.filter((c) => !acctDigits(c.account_number)).length,
  };
}

module.exports = { generatePositivePayCsv, fmtDate, sanitizePayee, PP_HEADER };
