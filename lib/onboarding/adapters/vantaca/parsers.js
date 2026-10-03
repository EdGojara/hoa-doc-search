// ============================================================================
// lib/onboarding/adapters/vantaca/parsers.js  (Issue #15)
// ----------------------------------------------------------------------------
// Read-only parsers for Vantaca report text produced by `pdftotext -layout`
// from the ORIGINAL Vantaca PDFs. Each parser returns canonical rows (with
// provenance: artifact sha256 + line number + raw line), the totals the
// report itself PRINTS (used as extraction controls), and extraction defects.
//
// Rule: never drop what we cannot read. Any line that looks like data (starts
// with a date, or carries an amount where an amount belongs) but does not
// parse is recorded as a defect, and every account/section is re-added against
// the report's own printed totals, so a misread layout fails a control instead
// of silently vanishing. (Scar: the Quail Ridge package's normalized GL CSV
// dropped 48 rows: ".38" interest amounts and wrapped payment lines.)
// ============================================================================
const { parseCents, isAmount } = require('../../money');
const { makeRow, isoDate } = require('../../canonical');

const AMT = String.raw`\(?-?\$?\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}\)?|-`;
const lines = (text) => String(text).replace(/\r\n/g, '\n').split('\n');
const prov = (artifact, i, raw) => ({ artifact_sha256: artifact.sha256, locator: { line: i + 1 }, raw });
const PAGE_NOISE = /^(Report generated on|\s*Page \d+\s*$|\f)/;

// ---------------------------------------------------------------- GL Trial Balance
// Account header:  "1000 - Operating Cash Account   40,542.98   23,888.96   22,725.28   41,706.66"
// Transaction:     "  01/30/2026   5304   January Interest   .38   -   GL Entry"
// The header repeats on every page an account spans; it must repeat identically.
function parseGlTrialBalance(text, artifact, { as_of } = {}) {
  const L = lines(text);
  const HDR = new RegExp(String.raw`^\s*(\d{3,6})\s+-\s+(.+?)\s{2,}(${AMT})\s+(${AMT})\s+(${AMT})\s+(${AMT})\s*$`);
  const TXN = new RegExp(String.raw`^\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(.*?)\s+(${AMT})\s+(${AMT})\s+([A-Za-z][A-Za-z ]*[A-Za-z])\s*$`);
  const accounts = {}; const order = []; const rows = []; const defects = [];
  let cur = null; let last = null; let period = null;
  for (let i = 0; i < L.length; i++) {
    const raw = L[i];
    if (!period) { const p = /GL Trial Balance For (\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(raw); if (p) period = { start: isoDate(p[1]), end: isoDate(p[2]) }; }
    const h = HDR.exec(raw);
    if (h) {
      const vals = { beginning_cents: parseCents(h[3]), debit_cents: parseCents(h[4]), credit_cents: parseCents(h[5]), ending_cents: parseCents(h[6]) };
      if (!accounts[h[1]]) { accounts[h[1]] = { account_code: h[1], account_name: h[2].trim(), ...vals, line: i + 1, raw }; order.push(h[1]); }
      else if (['beginning_cents', 'debit_cents', 'credit_cents', 'ending_cents'].some((k) => accounts[h[1]][k] !== vals[k])) defects.push({ code: 'GL_HEADER_REPEAT_DIFFERS', line: i + 1, account: h[1] });
      cur = h[1]; last = null; continue;
    }
    const t = TXN.exec(raw);
    if (t && cur) {
      // A ledger id is a number followed by 2+ spaces; "101 Example Lane: ..." is a description.
      const m = /^(\d+)\s{2,}(.*)$/.exec(t[2]);
      last = { account_code: cur, date: isoDate(t[1]), ledger_id: m ? m[1] : null, description: (m ? m[2] : t[2]).trim(), debit_cents: parseCents(t[3]), credit_cents: parseCents(t[4]), source_type: t[5].trim(), line: i + 1, raw };
      rows.push(last); continue;
    }
    if (/^\s+\d{1,2}\/\d{1,2}\/\d{4}\s/.test(raw)) { defects.push({ code: 'GL_DATA_LINE_UNREADABLE', line: i + 1, account: cur }); last = null; continue; }
    // continuation of a wrapped description (indented text, no amounts)
    if (last && /^\s{20,}\S/.test(raw) && !PAGE_NOISE.test(raw) && !/Debit\s+Credit/.test(raw) && !raw.trim().split(/\s+/).some(isAmount)) { last.description += ' ' + raw.trim(); last.raw += '\n' + raw; continue; }
    if (!raw.trim() || PAGE_NOISE.test(raw)) last = null;
  }
  const asOf = as_of || (period && period.end);
  const canonical = [
    ...order.map((a) => { const x = accounts[a]; return makeRow('gl_account_balance', { account_code: a, account_name: x.account_name, as_of: asOf, beginning_cents: x.beginning_cents, debit_cents: x.debit_cents, credit_cents: x.credit_cents, ending_cents: x.ending_cents }, prov(artifact, x.line - 1, x.raw)); }),
    ...rows.map((r) => makeRow('gl_transaction', { account_code: r.account_code, date: r.date, ledger_id: r.ledger_id, description: r.description, debit_cents: r.debit_cents, credit_cents: r.credit_cents, source_type: r.source_type }, prov(artifact, r.line - 1, r.raw))),
  ];
  return { artifact_type: 'gl_trial_balance', period, rows: canonical, defects, printed: { accounts: order.map((a) => ({ account_code: a, account_name: accounts[a].account_name, beginning_cents: accounts[a].beginning_cents, debit_cents: accounts[a].debit_cents, credit_cents: accounts[a].credit_cents, ending_cents: accounts[a].ending_cents })) } };
}

// ---------------------------------------------------------------- Balance Sheet
// Presentation signs: assets debit-positive; liabilities / equity credit-positive.
function parseBalanceSheet(text, artifact) {
  const L = lines(text);
  const LINE = new RegExp(String.raw`^\s+(\d{3,6})\s+-\s+(.+?)\s{2,}(${AMT})\s*$`);
  const TOTAL = new RegExp(String.raw`^\s*(Total [A-Za-z /]+?)\s{2,}(${AMT})\s*$`);
  let as_of = null; let section = null; const out = []; const totals = {}; const defects = [];
  for (let i = 0; i < L.length; i++) {
    const raw = L[i];
    if (!as_of) { const p = /Balance Sheet For (\d{1,2}\/\d{1,2}\/\d{4})/.exec(raw); if (p) as_of = isoDate(p[1]); }
    if (/^\s*(Assets|Liabilities|Equity)\s*$/.test(raw)) { section = raw.trim().toLowerCase(); continue; }
    const m = LINE.exec(raw);
    if (m) { out.push({ section, account_code: m[1], label: m[2].trim(), amount_cents: parseCents(m[3]), i, raw }); continue; }
    const t = TOTAL.exec(raw.replace(/^\s+(?=Total)/, '   '));
    if (t) { const k = t[1].trim().toLowerCase().replace(/\s+/g, ' '); const v = parseCents(t[2]); if (totals[k] !== undefined && totals[k] !== v) defects.push({ code: 'BS_TOTAL_REPEAT_DIFFERS', line: i + 1, total: k }); totals[k] = v; continue; }
    if (raw.trim() && raw.trim().split(/\s+/).some((tok) => /\.\d{2}\)?$/.test(tok)) && !/Report generated/.test(raw)) defects.push({ code: 'BS_LINE_UNREADABLE', line: i + 1 });
  }
  if (!as_of) defects.push({ code: 'BS_AS_OF_NOT_FOUND' });
  const rows = out.map((x) => makeRow('statement_line', { statement: 'balance_sheet', section: x.section, account_code: x.account_code, label: x.label, as_of: as_of || '1900-01-01', amount_cents: x.amount_cents }, prov(artifact, x.i, x.raw)));
  return { artifact_type: 'balance_sheet', as_of, rows, defects, printed: { totals } };
}

// ---------------------------------------------------------------- AR Aging
// "90000001 - <address> - <owner>"  then an account total line (often "Coll Status: ...") with
// 5 amounts (0-30, >30, >60, >90, balance), then indented charge-type lines with 5 amounts.
function parseArAging(text, artifact) {
  const L = lines(text);
  const FIVE = new RegExp(String.raw`(${AMT})\s+(${AMT})\s+(${AMT})\s+(${AMT})\s+(${AMT})\s*$`);
  let as_of = null; let inDetail = false; let cur = null; const accts = []; let total = null; const defects = [];
  const five = (m) => ({ current_cents: parseCents(m[1]), over_30_cents: parseCents(m[2]), over_60_cents: parseCents(m[3]), over_90_cents: parseCents(m[4]), balance_cents: parseCents(m[5]) });
  for (let i = 0; i < L.length; i++) {
    const raw = L[i];
    if (!as_of) { const p = /AR Aging - (\d{1,2}\/\d{1,2}\/\d{4})/.exec(raw); if (p) as_of = isoDate(p[1]); }
    if (/^\s*Property\s+0-30/.test(raw)) { inDetail = true; continue; }
    if (!inDetail) continue;
    if (/^\s*Total:/.test(raw)) { const m = FIVE.exec(raw); if (m) total = five(m); else defects.push({ code: 'AGING_TOTAL_UNREADABLE', line: i + 1 }); continue; }
    const h = /^\s*(\d{5,10}) - (.*)$/.exec(raw);
    if (h) { cur = { key: h[1], head: null, items: [], i, raw }; accts.push(cur); const m = FIVE.exec(raw); if (m) cur.head = five(m); continue; }
    if (!cur) continue;
    const m = FIVE.exec(raw);
    if (!m) continue;
    if (!cur.head) { cur.head = five(m); const s = /^\s*Coll Status:\s*(.*?)\s{2,}/.exec(raw); cur.collection_status = s ? s[1] : null; cur.headLine = i; cur.headRaw = raw; continue; }
    cur.items.push({ charge_type: raw.slice(0, m.index).trim(), ...five(m), i, raw });
  }
  if (!as_of) defects.push({ code: 'AGING_AS_OF_NOT_FOUND' });
  const rows = [];
  for (const a of accts) {
    if (!a.head) { defects.push({ code: 'AGING_ACCOUNT_TOTAL_MISSING', line: a.i + 1, account: a.key }); continue; }
    rows.push(makeRow('ar_aging_account', { source_account_key: a.key, as_of, collection_status: a.collection_status || null, ...a.head }, prov(artifact, a.headLine ?? a.i, a.headRaw || a.raw)));
    for (const it of a.items) rows.push(makeRow('ar_aging_item', { source_account_key: a.key, as_of, charge_type: it.charge_type, current_cents: it.current_cents, over_30_cents: it.over_30_cents, over_60_cents: it.over_60_cents, over_90_cents: it.over_90_cents, balance_cents: it.balance_cents }, prov(artifact, it.i, it.raw)));
  }
  return { artifact_type: 'ar_aging', as_of, rows, defects, printed: { total } };
}

// ---------------------------------------------------------------- Homeowner Transaction History
// "   90000001 - <owner> - <address>" then rows "1/1/2026  Annual Assessment  $260.00  $0.00  $260.00".
// The first row is "Prior Balance" (opening). Vantaca prints the END-OF-DAY balance on every row of
// a day with several items, so the running-balance check is done per day, not per row.
function parseHomeownerTransactions(text, artifact) {
  const L = lines(text);
  const ROW = new RegExp(String.raw`^\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(.*?)\s+(${AMT})\s+(${AMT})\s+(${AMT})\s*$`);
  let period = null; let cur = null; const accts = {}; const order = []; const defects = [];
  for (let i = 0; i < L.length; i++) {
    const raw = L[i];
    if (!period) { const p = /Transaction History For (\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(raw); if (p) period = { start: isoDate(p[1]), end: isoDate(p[2]) }; }
    const h = /^\s+(\d{5,10}) - (.*)$/.exec(raw);
    if (h) { cur = h[1]; if (!accts[cur]) { accts[cur] = { key: cur, rows: [], i, raw }; order.push(cur); } continue; }
    const m = ROW.exec(raw);
    if (m && cur) { accts[cur].rows.push({ date: isoDate(m[1]), description: m[2].trim(), charge_cents: parseCents(m[3]), payment_cents: parseCents(m[4]), balance_cents: parseCents(m[5]), i, raw }); continue; }
    if (/^\s*\d{1,2}\/\d{1,2}\/\d{4}\s/.test(raw)) defects.push({ code: 'LEDGER_DATA_LINE_UNREADABLE', line: i + 1, account: cur });
  }
  const end = period && period.end;
  const rows = []; const dayBreaks = [];
  for (const k of order) {
    const a = accts[k];
    if (!a.rows.length) { defects.push({ code: 'LEDGER_ACCOUNT_WITHOUT_ROWS', account: k, line: a.i + 1 }); continue; }
    const first = a.rows[0];
    const opening = /prior balance/i.test(first.description) ? first.balance_cents : null;
    if (opening === null) defects.push({ code: 'LEDGER_NO_PRIOR_BALANCE_ROW', account: k, line: first.i + 1 });
    // per-day running balance: day-end printed balance == previous day-end + that day's charges + payments
    let run = opening ?? first.balance_cents; let idx = opening === null ? 0 : 1;
    while (idx < a.rows.length) {
      const day = a.rows[idx].date; let net = 0; let j = idx;
      while (j < a.rows.length && a.rows[j].date === day) { net += a.rows[j].charge_cents + a.rows[j].payment_cents; j++; }
      const printed = a.rows[j - 1].balance_cents;
      if (run + net !== printed) dayBreaks.push({ account: k, date: day, expected_cents: run + net, printed_cents: printed, line: a.rows[j - 1].i + 1 });
      run = printed; idx = j;
    }
    const ending = a.rows[a.rows.length - 1].balance_cents;
    rows.push(makeRow('homeowner_account', { source_account_key: k, as_of: end || '1900-01-01', opening_cents: opening ?? 0, ending_cents: ending, row_count: a.rows.length }, prov(artifact, a.i, a.raw)));
    for (const r of a.rows) rows.push(makeRow('homeowner_txn', { source_account_key: k, date: r.date, description: r.description, charge_cents: r.charge_cents, payment_cents: r.payment_cents, balance_cents: r.balance_cents }, prov(artifact, r.i, r.raw)));
  }
  return { artifact_type: 'homeowner_transactions', period, rows, defects, printed: { day_balance_breaks: dayBreaks } };
}

// ---------------------------------------------------------------- Normalized GL transactions CSV
// A derivative someone else produced (e.g. a package's gl_transactions.csv). It is never trusted on its
// own: extractionControls re-adds it against the ORIGINAL GL report's printed account totals.
// Columns: account_code,date,ledger_id,description,debit,credit,type (description may be quoted).
function splitCsvLine(line) {
  const out = []; let f = ''; let q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(f); f = ''; } else f += ch; }
  out.push(f); return out;
}
const csvCents = (s) => { const t = String(s).trim(); if (!/^-?\d+(?:\.\d{1,2})?$/.test(t)) throw new Error(`unreadable amount: ${JSON.stringify(s)}`); return Math.round(Number(t) * 100); };
function parseNormalizedGlCsv(text, artifact) {
  const L = lines(text).filter((l, i) => i === 0 || l.trim());
  const head = splitCsvLine(L[0]).map((h) => h.trim());
  const idx = (k) => head.indexOf(k);
  for (const k of ['account_code', 'date', 'debit', 'credit']) if (idx(k) < 0) throw new Error(`normalized GL csv missing column ${k}`);
  const rows = []; const defects = [];
  for (let i = 1; i < L.length; i++) {
    const c = splitCsvLine(L[i]);
    try {
      rows.push(makeRow('gl_transaction', { account_code: c[idx('account_code')].trim(), date: isoDate(c[idx('date')]), ledger_id: idx('ledger_id') >= 0 ? (c[idx('ledger_id')] || null) : null, description: idx('description') >= 0 ? c[idx('description')] : '', debit_cents: csvCents(c[idx('debit')]), credit_cents: csvCents(c[idx('credit')]), source_type: idx('type') >= 0 ? c[idx('type')] : null }, prov(artifact, i, L[i])));
    } catch (e) { defects.push({ code: 'CSV_ROW_UNREADABLE', line: i + 1, error: e.message }); }
  }
  return { artifact_type: 'gl_transactions_csv', rows, defects, printed: {} };
}

// ---------------------------------------------------------------- Pre Paid Homeowners
// "Pre Paid Homeowners For 7/31/2026"; rows "[***]90000004  <property>  <owner name>  12.34"
// ("***" marks a PREVIOUS owner); a printed total line. Keyed by ACCOUNT NUMBER only:
// the owner-name column wraps and shifts rows in the PDF text, so names are never used.
function parsePrepaidHomeowners(text, artifact) {
  const L = lines(text);
  const ROW = new RegExp(String.raw`^\s*(\*\*\*)?(\d{5,10})\s+(.*?)\s{2,}(${AMT})\s*$`);
  let as_of = null; const rows = []; const defects = []; let total = null;
  for (let i = 0; i < L.length; i++) {
    const raw = L[i];
    if (!as_of) { const p = /Pre Paid Homeowners For (\d{1,2}\/\d{1,2}\/\d{4})/i.exec(raw); if (p) as_of = isoDate(p[1]); }
    const m = ROW.exec(raw);
    if (m) { rows.push(makeRow('prepaid_credit', { source_account_key: m[2], as_of: as_of || '1900-01-01', amount_cents: parseCents(m[4]), previous_owner: !!m[1] }, prov(artifact, i, raw))); continue; }
    if (/^\s*(\*\*\*)?\d{5,10}\s/.test(raw)) { defects.push({ code: 'PREPAID_ROW_UNREADABLE', line: i + 1 }); continue; }
    const t = new RegExp(String.raw`^\s+(${AMT})\s*(Total)?\s*$`).exec(raw);
    if (t && (t[2] || /^\s*Total\s*$/.test(L[i + 1] || ''))) total = parseCents(t[1]);
    const t2 = new RegExp(String.raw`^\s*Total\s+(${AMT})\s*$`).exec(raw);            // "Total   922.13" (label first)
    if (t2) total = parseCents(t2[1]);
  }
  if (!as_of) defects.push({ code: 'PREPAID_AS_OF_NOT_FOUND' });
  if (total === null) defects.push({ code: 'PREPAID_TOTAL_NOT_FOUND' });
  return { artifact_type: 'prepaid_homeowners', as_of, rows, defects, printed: { total } };
}

// ---------------------------------------------------------------- AP Aging
// "AP Aging for Ending Date: 7/31/2026"; per open invoice a header
// "<VENDOR> Inv # <number> on <date> - <memo>" and an amount row with five amounts
// (Current, Over 30, Over 60, Over 90, Total); the last amount row is the printed Total.
// In pdftotext layout an invoice's amount row can land on the line ABOVE or BELOW its
// header, so invoices and amount rows are paired strictly IN ORDER, and the count must
// agree (n invoices, n + 1 amount rows); any other shape is a defect, never a guess.
function parseApAging(text, artifact) {
  const L = lines(text);
  const FIVE = new RegExp(String.raw`(${AMT})\s+(${AMT})\s+(${AMT})\s+(${AMT})\s+(${AMT})\s*$`);
  const INV = /^(.*?)\s+Inv\s*#\s*(\S+)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i;
  let as_of = null; const heads = []; const amounts = []; const defects = [];
  for (let i = 0; i < L.length; i++) {
    const raw = L[i];
    if (!as_of) { const p = /AP Aging for Ending Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(raw); if (p) as_of = isoDate(p[1]); }
    const h = INV.exec(raw);
    if (h) heads.push({ vendor: h[1].trim(), invoice_number: h[2], invoice_date: isoDate(h[3]), i, raw });
    const m = FIVE.exec(raw);
    if (m) amounts.push({ v: m.slice(1, 6).map(parseCents), i, raw });
  }
  if (!as_of) defects.push({ code: 'AP_AGING_AS_OF_NOT_FOUND' });
  if (amounts.length !== heads.length + 1) defects.push({ code: 'AP_AGING_ROW_COUNT_MISMATCH', invoices: heads.length, amount_rows: amounts.length });
  const rows = [];
  const n = Math.min(heads.length, Math.max(0, amounts.length - 1));
  for (let k = 0; k < n; k++) {
    const h = heads[k]; const a = amounts[k];
    rows.push(makeRow('ap_open_item', { source_vendor_key: h.vendor, invoice_number: h.invoice_number, invoice_date: h.invoice_date, as_of: as_of || '1900-01-01',
      current_cents: a.v[0], over_30_cents: a.v[1], over_60_cents: a.v[2], over_90_cents: a.v[3], amount_cents: a.v[4] },
      { artifact_sha256: artifact.sha256, locator: { line: h.i + 1, amount_line: a.i + 1 }, raw: h.raw + '\n' + a.raw }));
  }
  const totalRow = amounts.length ? amounts[amounts.length - 1].v : null;
  return { artifact_type: 'ap_aging', as_of, rows, defects, printed: { total: totalRow ? { current_cents: totalRow[0], over_30_cents: totalRow[1], over_60_cents: totalRow[2], over_90_cents: totalRow[3], balance_cents: totalRow[4] } : null } };
}

module.exports = { parseGlTrialBalance, parseBalanceSheet, parseArAging, parseHomeownerTransactions, parseNormalizedGlCsv, parsePrepaidHomeowners, parseApAging };
