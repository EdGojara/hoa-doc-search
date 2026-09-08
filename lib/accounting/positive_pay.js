// ============================================================================
// lib/accounting/positive_pay.js  (Ed 2026-09-08)
// ----------------------------------------------------------------------------
// Positive Pay issued-check file for NewFirst National Bank. The bank clears a
// presented check only if it matches a check we told them we issued — the fraud
// control. NewFirst's format (from Melody Hess's sample, "Sample PP File.csv") is
// a headerless CSV, one row per check, ONE FILE PER ACCOUNT (the account is
// selected in the Treasury Management upload, not in the file):
//
//   IssueDate(M/D/YYYY), CheckNumber, PayeeName, Amount(no $, 2 decimals)
//   3/3/2022,31852,Joh Doe Rentals,478.30
//
// Upload is manual through NewFirst Treasury Management (they have no API/SFTP),
// so this just produces the file for a person to upload after a check run.
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

/**
 * @param checks array of { issue_date, check_number, payee_name, amount_cents }
 * @returns { csv, count, total_cents } — NewFirst headerless CSV, one row per check.
 */
function generatePositivePayCsv(checks) {
  const rows = (checks || [])
    .filter((c) => c && c.check_number && Number(c.amount_cents) > 0)
    .map((c) => [
      fmtDate(c.issue_date),
      String(c.check_number).trim(),
      csv((c.payee_name || '').trim()),
      (Number(c.amount_cents) / 100).toFixed(2),
    ].join(','));
  return {
    csv: rows.join('\r\n') + (rows.length ? '\r\n' : ''), // CRLF — banks parse it most reliably
    count: rows.length,
    total_cents: (checks || []).reduce((a, c) => a + (Number(c.amount_cents) || 0), 0),
  };
}

module.exports = { generatePositivePayCsv, fmtDate };
