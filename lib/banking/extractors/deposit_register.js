// ============================================================================
// lib/banking/extractors/deposit_register.js
// ----------------------------------------------------------------------------
// Parse a Vantaca "Deposit Register" .xls into structured deposit rows — the
// BOOK/deposit side of a bank reconciliation. Vantaca lists each homeowner
// payment individually here; the bank statement shows them as batched payouts.
// Feeding these into the matcher (as the deposit side) is what lets the batch
// pass group payouts → individual payments and clear them.
//
// The file is segmented by bank account (header rows like "QR Operating - 4536",
// "QR CAP RSV - 9471"), each followed by deposit lines and a subtotal, then a
// grand Total row. Cells are null-padded so columns shift (a known Vantaca .xls
// quirk) — so we parse by CONTENT, not fixed column index: a deposit line is any
// row carrying both an M/D/YYYY date and a single-$ amount.
//
//   parseDepositRegister(buffer) -> { accounts:[{account_label, account_last4,
//       deposits:[{date, description, check_number, amount_cents}], subtotal_cents}],
//       total_cents, community_name, warnings }
//   depositsToGlEntries(deposits) -> matcher glEntries shape (deposit side)
// ============================================================================

const XLSX = require('xlsx');

const RE_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const RE_AMOUNT = /^\$(?!\$)[\d,]*\.\d{2}$/;      // single leading $ — subtotals use $$; allow "$.38" (no leading zero)
const RE_CHECKNUM = /^\d{1,6}$/;                 // standalone check# cell
const RE_ACCT_HEADER = /-\s*(\d{3,6})\s*$/;      // "...- 4536"

function toIso(mdy) {
  const m = String(mdy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toCents(amt) {
  const n = Number(String(amt).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function parseRows(rows) {
  const accounts = [];
  let current = null;
  const warnings = [];
  let communityName = null;

  for (const raw of rows) {
    const cells = (raw || []).map((c) => (c == null ? '' : String(c).trim()));
    const nonEmpty = cells.filter(Boolean);
    if (!nonEmpty.length) continue;

    const dateCell = cells.find((c) => RE_DATE.test(c));
    const amountCell = cells.find((c) => RE_AMOUNT.test(c));

    // Deposit line: must have both a date and a single-$ amount.
    if (dateCell && amountCell) {
      if (!current) { current = { account_label: 'Unknown', account_last4: null, deposits: [], subtotal_cents: 0 }; accounts.push(current); }
      const checkCell = cells.find((c) => RE_CHECKNUM.test(c) && c !== dateCell);
      const description = cells.find((c) => c && c !== dateCell && c !== amountCell && c !== checkCell && !RE_DATE.test(c) && !RE_AMOUNT.test(c)) || '';
      const date = toIso(dateCell);
      const amount_cents = toCents(amountCell);
      if (date && amount_cents != null) {
        current.deposits.push({ date, description, check_number: checkCell || null, amount_cents });
      } else {
        warnings.push(`Skipped unparseable line: ${nonEmpty.join(' | ').slice(0, 60)}`);
      }
      continue;
    }

    // Grand total / community name / subtotal rows (no date).
    const firstText = nonEmpty[0] || '';
    if (/^total:?$/i.test(firstText) || (amountCell && /^\$\$/.test(cells.find((c) => /^\$\$/.test(c)) || ''))) {
      // subtotal/total — ignore for line data (used only as a cross-check)
      continue;
    }

    // Account header: a cell ending in "- NNNN" and no date on the row.
    const hdr = cells.find((c) => RE_ACCT_HEADER.test(c) && !RE_DATE.test(c) && !RE_AMOUNT.test(c));
    if (hdr) {
      const last4 = (hdr.match(RE_ACCT_HEADER) || [])[1] || null;
      current = { account_label: hdr, account_last4: last4, deposits: [], subtotal_cents: 0 };
      accounts.push(current);
      continue;
    }

    // First meaningful single-cell line is usually the community name.
    if (!communityName && nonEmpty.length === 1 && !/deposit register/i.test(firstText)) {
      communityName = firstText;
    }
  }

  for (const a of accounts) a.subtotal_cents = a.deposits.reduce((s, d) => s + d.amount_cents, 0);
  const total_cents = accounts.reduce((s, a) => s + a.subtotal_cents, 0);
  return { community_name: communityName, accounts: accounts.filter((a) => a.deposits.length), total_cents, warnings };
}

function parseDepositRegister(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return parseRows(rows);
}

// Map deposit-register rows into the matcher's GL/deposit shape.
function depositsToGlEntries(deposits) {
  return (deposits || []).map((d, i) => ({
    ref: `DEP-${i}`,
    posting_date: d.date,
    entry_type: 'deposit',
    amount_signed_cents: d.amount_cents,
    description: d.description,
    check_number: d.check_number,
  }));
}

module.exports = { parseDepositRegister, parseRows, depositsToGlEntries };
