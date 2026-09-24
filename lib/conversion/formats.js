// ============================================================================
// lib/conversion/formats.js
// ----------------------------------------------------------------------------
// Input-file contract for a period-end conversion loader (first use: Lakes of
// Pine Forest, baseline 2026-07-31). Ed / ChatGPT supply the normalized files,
// the control totals and the control rules. This module defines ONLY the
// mechanical shape of each file: columns, types, required/optional, and a few
// per-file value rules. It encodes no accounting policy, no balance
// composition and no cross-file reconciliation; those arrive as data
// (control_totals.csv + control_rules.csv).
//
// The same FILES object drives the validator, the dry run and the generated
// format document (templates/conversion/IMPORT_FORMATS.md), so they cannot drift.
//
// Conventions for every file:
//   - CSV (UTF-8, header row, comma separated, RFC 4180 quoting) or .xlsx with
//     the same header row on the first sheet. File name must be exactly as listed.
//   - Header names must match exactly (case-insensitive, surrounding spaces
//     ignored). A missing required column or an unknown extra column is an
//     exception; nothing is guessed from position or similar names.
//   - Dates: ISO YYYY-MM-DD text. Money: plain dollars, up to 2 decimals, no "$",
//     no commas, no parentheses, negative = leading "-". Anything else is an
//     exception; no value is ever inferred, defaulted or coerced.
//   - A blank REQUIRED cell is an exception. A blank OPTIONAL cell stays blank
//     (NULL); the loader never fills it from another column.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const col = (name, type, desc, opts = {}) => ({ name, type, desc, required: opts.required !== false, values: opts.values });
const opt = (name, type, desc, extra = {}) => col(name, type, desc, { ...extra, required: false });

// Enumerations mirror existing Trusted CHECK constraints so staged values are
// insertable later (ar_charge_types.category, migration 172).
const CHARGE_CATEGORIES = [
  'assessment', 'late_fee', 'interest', 'attorney_fee_assessment_related', 'records_request_fee',
  'attorney_fee_other', 'fine', 'transfer_fee', 'resale_certificate_fee', 'nsf_fee', 'certified_letter', 'other',
];

const AR_COLUMNS = [
  col('vantaca_account_id', 'text', 'Vantaca account number exactly as in the source report.'),
  opt('vantaca_homeowner_id', 'text', 'Vantaca Homeowner ID, if the source report carries it.'),
  col('owner_name', 'text', 'Owner name exactly as on the Vantaca account.'),
  opt('property_address', 'text', 'Physical lot address as supplied. ar_former_owners rows need it to map (see mapping rules).'),
  col('tenure_status', 'enum', 'Supplied by the preparer: current or former.', { values: ['current', 'former'] }),
  col('charge_category', 'enum', 'Supplied by the preparer.', { values: CHARGE_CATEGORIES }),
  col('effective_date', 'date', 'Date supplied by the preparer for this item.'),
  opt('due_date', 'date', 'Due date if supplied. Never derived from effective_date.'),
  col('amount', 'money', 'Amount as supplied; see the file rule for the permitted sign.'),
  opt('aging_bucket', 'enum', 'Aging bucket if supplied.', { values: ['current', '1_30', '31_60', '61_90', '91_120', 'over_120'] }),
  opt('description', 'text', 'Free text.'),
  col('source_report', 'text', 'Source report name and run date this row came from.'),
  opt('source_row', 'text', 'Row / line identifier in the source report, for audit trace.'),
];

const FILES = {
  ar_debits: {
    title: 'Homeowner debit / open balances', filename: 'ar_debits.csv', columns: AR_COLUMNS,
    rule: 'amount > 0',
    rowCheck: (r) => (r.amount > 0 ? null : 'amount must be > 0'),
  },
  ar_credits: {
    title: 'Homeowner prepaid / credit balances', filename: 'ar_credits.csv', columns: AR_COLUMNS,
    rule: 'amount > 0 (supplied as a positive magnitude)',
    rowCheck: (r) => (r.amount > 0 ? null : 'amount must be > 0'),
  },
  ar_former_owners: {
    title: 'Former-owner balances', filename: 'ar_former_owners.csv', columns: AR_COLUMNS,
    rule: 'tenure_status = former; amount non-zero (sign as supplied)',
    rowCheck: (r) => (r.tenure_status !== 'former' ? 'tenure_status must be former' : r.amount === 0 ? 'amount must be non-zero' : null),
  },
  ap_open: {
    title: 'Open AP', filename: 'ap_open.csv',
    columns: [
      col('vendor_name', 'text', 'Vendor name; must equal a Trusted vendor name exactly.'),
      opt('vantaca_vendor_id', 'text', 'Vantaca vendor id if supplied.'),
      col('invoice_number', 'text', 'Invoice number as supplied.'),
      col('invoice_date', 'date', 'Invoice date.'),
      opt('due_date', 'date', 'Due date if supplied.'),
      col('gl_account', 'text', 'Account number; must equal a Trusted chart-of-accounts number exactly.'),
      opt('fund', 'text', 'Fund code; if supplied must equal a Trusted fund code exactly.'),
      col('original_amount', 'money', 'Original invoice amount.'),
      col('amount_open', 'money', 'Open amount.'),
      opt('description', 'text', 'Free text.'),
      col('source_report', 'text', 'Source report name and run date.'),
      opt('source_row', 'text', 'Row / line identifier in the source report.'),
    ],
    rule: 'amount_open > 0 and amount_open <= original_amount',
    rowCheck: (r) => (r.amount_open > 0 && r.amount_open <= r.original_amount ? null : 'amount_open must be > 0 and <= original_amount'),
  },
  gl_trial_balance: {
    title: 'GL trial balance (ending balances)', filename: 'gl_trial_balance.csv',
    columns: [
      col('account_number', 'text', 'Must equal a Trusted chart-of-accounts number exactly.'),
      col('account_name', 'text', 'As in the source report (informational).'),
      col('fund', 'text', 'Must equal a Trusted fund code exactly.'),
      col('ending_debit', 'money', 'Ending debit amount as supplied (0 if none).'),
      col('ending_credit', 'money', 'Ending credit amount as supplied (0 if none).'),
      col('source_report', 'text', 'Source report name and run date.'),
    ],
    rule: 'ending_debit >= 0 and ending_credit >= 0',
    rowCheck: (r) => (r.ending_debit >= 0 && r.ending_credit >= 0 ? null : 'ending_debit and ending_credit must be >= 0'),
  },
  bank_balances: {
    title: 'Bank balances and bank reconciliation summary', filename: 'bank_balances.csv',
    columns: [
      col('gl_account_number', 'text', 'Must equal the gl_account_number of exactly one active Trusted bank account.'),
      col('bank_account_last4', 'text', 'Must equal that bank account\'s last 4.'),
      col('statement_date', 'date', 'Statement closing date.'),
      col('statement_ending_balance', 'money', 'As supplied.'),
      col('outstanding_checks_total', 'money', 'As supplied.'),
      col('deposits_in_transit_total', 'money', 'As supplied.'),
      col('other_reconciling_total', 'money', 'As supplied (0 if none).'),
      col('reconciled_book_balance', 'money', 'As supplied. Not recomputed by the loader.'),
      col('source_report', 'text', 'Source report name and run date.'),
    ],
    rule: 'none beyond types',
    rowCheck: () => null,
  },
  outstanding_items: {
    title: 'Outstanding checks, deposits in transit, other reconciling items', filename: 'outstanding_items.csv',
    columns: [
      col('gl_account_number', 'text', 'Must equal the gl_account_number of exactly one active Trusted bank account.'),
      col('item_type', 'enum', 'Supplied by the preparer.', { values: ['check', 'deposit_in_transit', 'other'] }),
      opt('check_number', 'text', 'Required when item_type = check.'),
      col('item_date', 'date', 'Item date.'),
      opt('payee', 'text', 'Payee / payor.'),
      col('amount', 'money', 'As supplied.'),
      opt('cleared_date', 'date', 'Date it cleared, if supplied.'),
      col('source_report', 'text', 'Source report name and run date.'),
    ],
    rule: 'check_number required when item_type = check',
    rowCheck: (r) => (r.item_type === 'check' && !r.check_number ? 'check_number is required when item_type = check' : null),
  },
  july_gl_activity: {
    title: 'GL activity for the conversion month (every posted line)', filename: 'july_gl_activity.csv',
    columns: [
      col('posting_date', 'date', 'Posting date.'),
      col('account_number', 'text', 'Must equal a Trusted chart-of-accounts number exactly.'),
      opt('fund', 'text', 'If supplied, must equal a Trusted fund code exactly.'),
      col('debit', 'money', 'Debit amount as supplied (0 if none).'),
      col('credit', 'money', 'Credit amount as supplied (0 if none).'),
      col('description', 'text', 'Line description as exported.'),
      opt('reference', 'text', 'Invoice / check / receipt reference if exported separately.'),
      opt('vendor_name', 'text', 'Vendor if exported separately.'),
      opt('homeowner_account', 'text', 'Homeowner account if exported separately.'),
      opt('journal_type', 'text', 'Source transaction type if exported.'),
      opt('line_id', 'text', 'Source ledger line id; if supplied must be unique in the file.'),
      col('source_report', 'text', 'Source report name and run date.'),
    ],
    rule: 'debit >= 0 and credit >= 0',
    rowCheck: (r) => (r.debit >= 0 && r.credit >= 0 ? null : 'debit and credit must be >= 0'),
  },
  control_totals: {
    title: 'Control totals (supplied externally)', filename: 'control_totals.csv',
    columns: [
      col('control_code', 'text', 'Any code the preparer chooses (letters, digits, _). Referenced by control_rules.csv. Must be unique.'),
      col('amount', 'money', 'Value as supplied. Counts are supplied the same way (579 = 579).'),
      col('as_of', 'date', 'As-of date of the control.'),
      col('source_report', 'text', 'Report the control was taken from.'),
      opt('note', 'text', 'Free text.'),
    ],
    rule: 'control_code matches ^[A-Za-z0-9_]+$',
    rowCheck: (r) => (/^[A-Za-z0-9_]+$/.test(r.control_code) ? null : 'control_code may contain only letters, digits and _'),
  },
  control_rules: {
    title: 'Control rules (supplied externally): each rule says left must equal right', filename: 'control_rules.csv',
    columns: [
      col('rule_code', 'text', 'Unique rule name.'),
      col('left', 'text', 'Expression: control codes and/or loader measures joined by + and - (see Measures).'),
      col('right', 'text', 'Expression, same syntax.'),
      opt('note', 'text', 'What the rule proves, in words.'),
    ],
    rule: 'left/right contain only names, +, -',
    rowCheck: (r) => (/^[A-Za-z0-9_@=.+\- ]+$/.test(r.left) && /^[A-Za-z0-9_@=.+\- ]+$/.test(r.right) ? null : 'left/right may contain only names (letters, digits, _ @ = .), + and -'),
  },
};

// ---------------------------------------------------------------------------
function toCents(raw) {
  const s = String(raw).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const cents = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -cents : cents;
}
function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function readTable(filePath) {
  const buf = fs.readFileSync(filePath);
  const wb = /\.xlsx$/i.test(filePath)
    ? XLSX.read(buf, { type: 'buffer', cellDates: false })
    : XLSX.read(buf.toString('utf8'), { type: 'string', raw: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  return { rows, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

// Parse + validate one file. Never throws on data: every problem is returned as
// an exception { file, line, field, code, detail }. Rows with problems are kept
// (with _errors) so the staging record is complete, but they are not mapped.
function parseInputFile(kind, filePath) {
  const spec = FILES[kind];
  const { rows, sha256 } = readTable(filePath);
  const exceptions = [];
  const X = (line, field, code, detail) => exceptions.push({ file: kind, line, field, code, detail });
  const base = { kind, file: path.basename(filePath), sha256, rows: [], exceptions };
  if (!rows.length) { X(1, null, 'FILE_EMPTY', 'file has no header row'); return { ...base, header_ok: false, ok: false }; }
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const names = spec.columns.map((c) => c.name);
  for (const c of spec.columns) if (c.required && !header.includes(c.name)) X(1, c.name, 'COLUMN_MISSING', `required column "${c.name}" is not in the header`);
  header.forEach((h, i) => { if (!h) X(1, null, 'COLUMN_UNNAMED', `column ${i + 1} has no header`); else if (!names.includes(h)) X(1, h, 'COLUMN_UNKNOWN', `column "${h}" is not part of the ${spec.filename} format`); });
  for (const h of new Set(header.filter((h, i) => h && header.indexOf(h) !== i))) X(1, h, 'COLUMN_DUPLICATED', `column "${h}" appears more than once`);
  if (exceptions.length) return { ...base, header_ok: false, ok: false, diagnostic: { headers: rows[0], sample_rows: rows.slice(1, 4), expected_header: names.join(',') } };
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  rows.slice(1).forEach((raw, i) => {
    const line = i + 2;
    if (raw.every((v) => String(v).trim() === '')) return;
    const rec = { _line: line, _errors: [] };
    const bad = (field, code, detail) => { rec._errors.push(code); X(line, field, code, detail); };
    for (const c of spec.columns) {
      const v = idx[c.name] === undefined ? '' : String(raw[idx[c.name]] ?? '').trim();
      if (v === '') { rec[c.name] = null; if (c.required) bad(c.name, 'FIELD_MISSING', `${c.name} is required`); continue; }
      if (c.type === 'money') { const cents = toCents(v); if (cents === null) bad(c.name, 'FIELD_INVALID_MONEY', `${c.name} "${v}" is not a plain dollar amount`); rec[c.name] = cents; }
      else if (c.type === 'date') { if (!isIsoDate(v)) bad(c.name, 'FIELD_INVALID_DATE', `${c.name} "${v}" is not YYYY-MM-DD`); rec[c.name] = v; }
      else if (c.type === 'enum') { const lv = v.toLowerCase(); if (!c.values.includes(lv)) bad(c.name, 'FIELD_NOT_ALLOWED', `${c.name} "${v}" not in [${c.values.join(', ')}]`); rec[c.name] = lv; }
      else rec[c.name] = v;
    }
    if (!rec._errors.length) { const r = spec.rowCheck(rec); if (r) bad(null, 'ROW_RULE', r); }
    base.rows.push(rec);
  });
  if (!base.rows.length) X(2, null, 'FILE_NO_ROWS', 'file has a header but no data rows');
  return { ...base, header_ok: true, ok: exceptions.length === 0 };
}

// Load every file present in a directory. A missing file is PENDING, never empty.
function loadInputSet(dir) {
  const result = { dir, files: {}, pending: [] };
  for (const [kind, spec] of Object.entries(FILES)) {
    const found = [spec.filename, spec.filename.replace(/\.csv$/, '.xlsx')].map((f) => path.join(dir, f)).find((p) => fs.existsSync(p));
    if (!found) { result.pending.push(kind); continue; }
    result.files[kind] = parseInputFile(kind, found);
  }
  return result;
}

module.exports = { FILES, CHARGE_CATEGORIES, parseInputFile, loadInputSet, toCents, isIsoDate };
