// ============================================================================
// lib/banking/extractors/newfirst_iremit.js  (Ed 2026-11-23)
// ----------------------------------------------------------------------------
// NewFirst iRemit payment files: the lockbox checks and the e-payments (e-check
// and card) the bank took for our associations. Pure reading; nothing here
// touches the database.
//
// TXT layout (derived from real files, 392 of 392 records, and checked row by
// row against the bank's own reports; never guessed):
//   1-8    processing date YYYYMMDD (equals the date in the file name)
//   9-14   association, zero-filled (the bank's code, see ASSOCIATIONS)
//   15-26  account as the bank holds it, zero-filled left. The bank's reports call
//          this "Remittance Number". It is NOT a transaction id, and it is usually a
//          pre-Vantaca (C3) account number, not a Vantaca one.
//   27-36  amount in cents, zero-filled
//   37-44  check number (the last 8 digits of the report's 10)
//   45-64  blank
// No header, trailer or control total, so a file is usable ONLY with its reports:
//   Detail   one row per payment (checks and e-payments are separate reports)
//   Summary  count and total per association, with the last 4 of the bank account
//   Images   batch and sequence per check
// Check-number field: 00111111 = e-check, 00999999 = card. They are placeholders
// shared by every e-payment and are never part of an identity as a "number".
// ============================================================================
const crypto = require('crypto');

const RECORD_LENGTH = 64;
const ECHECK = '00111111';
const CARD = '00999999';
// The bank's association codes, from its Summary reports (name and account last 4
// printed beside the code). A code not listed here is never assigned to anyone.
const ASSOCIATIONS = {
  '020': { community: 'Lakes of Pine Forest', evidence: 'account name and number on the Summary reports, 11/2026' },
  '101': { community: 'Waterview Estates', evidence: 'account name and number on the Summary reports, 11/2026' },
  '102': { community: 'Still Creek Ranch', evidence: 'account name and number on the Summary reports, 11/2026' },
};

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const usIso = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const cents = (s) => Math.round(Number(String(s).replace(/,/g, '')) * 100);
const realDate = (d) => /^\d{8}$/.test(d) && !Number.isNaN(Date.parse(`${iso(d)}T00:00:00Z`)) && new Date(`${iso(d)}T00:00:00Z`).toISOString().slice(0, 10) === iso(d);
const assocCode = (six) => six.replace(/^0+(?=\d{3})/, '');
const accountKey = (raw) => String(raw || '').replace(/[^0-9A-Za-z]/g, '').replace(/^0+/, '');

// -> { sha256, file_date, records, defects }. Any defect makes the whole file unusable.
function parseTxt(buffer, { filename = '' } = {}) {
  const defects = []; const records = [];
  const named = /(20\d{6})/.exec(String(filename));
  const text = Buffer.from(buffer).toString('latin1');
  text.split(/\r\n|\n/).forEach((line, i) => {
    if (line === '' || line === '\u001a') return;
    const at = `line ${i + 1}`;
    if (line.length !== RECORD_LENGTH) { defects.push(`${at}: ${line.length} characters, not ${RECORD_LENGTH}`); return; }
    const f = { date: line.slice(0, 8), assoc: line.slice(8, 14), account: line.slice(14, 26), amount: line.slice(26, 36), check: line.slice(36, 44), tail: line.slice(44) };
    const bad = [];
    if (!realDate(f.date)) bad.push('date');
    else if (named && named[1] !== f.date) bad.push(`date ${f.date} is not the file's ${named[1]}`);
    if (!/^\d{6}$/.test(f.assoc)) bad.push('association');
    if (!accountKey(f.account)) bad.push('account');
    if (!/^\d{10}$/.test(f.amount) || Number(f.amount) <= 0) bad.push('amount');
    if (!/^\d{8}$/.test(f.check)) bad.push('check number');
    if (f.tail.trim() !== '') bad.push('positions 45-64 are not blank');
    if (bad.length) { defects.push(`${at}: ${bad.join(', ')}`); return; }
    const kind = f.check === ECHECK ? 'echeck' : f.check === CARD ? 'card' : 'check';
    records.push({ line: i + 1, date: iso(f.date), association_code: assocCode(f.assoc), account: accountKey(f.account), account_as_sent: f.account,
      account_irregular: !/^\d{12}$/.test(f.account), amount_cents: Number(f.amount), kind, check_number: kind === 'check' ? f.check : null });
  });
  if (!records.length && !defects.length) defects.push('the file has no payment records');
  // Identity: no unique id exists, so identical payments in one file are numbered in file order.
  const seen = {};
  for (const r of records) {
    const tuple = `IREMIT:${r.date}:${r.association_code}:${r.account}:${r.amount_cents}:${r.kind === 'check' ? r.check_number : r.kind}`;
    seen[tuple] = (seen[tuple] || 0) + 1;
    r.tuple = tuple; r.ref = `${tuple}#${seen[tuple]}`;
  }
  return { sha256: sha256(buffer), filename, file_date: named ? iso(named[1]) : (records[0] && records[0].date) || null, records, defects };
}

const reportDate = (text) => { const m = /Report Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text) || /Date Processed:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text); return m ? usIso(m[1]) : null; };

// Remittance (detail) report text -> rows tied to its own printed totals.
function parseDetail(text) {
  const rows = []; const defects = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\S+)\s{2,}(.+?)\s{2,}(\d{5,12})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*(ACH)?\s*(ECK|CC)?\s*$/.exec(line);
    if (!m) continue;
    const check_cents = cents(m[4]); const remit_cents = cents(m[5]);
    if (check_cents !== remit_cents) defects.push(`account ${m[1]}: check amount and remittance amount differ`);
    const kind = m[6] ? (m[7] === 'CC' ? 'card' : m[7] === 'ECK' ? 'echeck' : 'unknown') : 'check';
    if (kind === 'unknown') defects.push(`account ${m[1]}: electronic payment of an unknown type`);
    rows.push({ account: accountKey(m[1]), name: m[2].trim(), check: m[3].slice(-8).padStart(8, '0'), amount_cents: remit_cents, kind });
  }
  const t = /Totals:\s+(\d+)\s+checks?\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/.exec(text);
  if (!t) defects.push('no printed totals');
  else if (Number(t[1]) !== rows.length || cents(t[3]) !== rows.reduce((s, r) => s + r.amount_cents, 0)) defects.push(`rows read (${rows.length}) do not equal the printed totals (${t[1]} for ${t[3]})`);
  return { date: reportDate(text), rows, defects };
}

// Summary report -> { association_code: { count, cents, last4 } }, tied to its totals.
function parseSummary(text) {
  const by = {}; const defects = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d{3})\s{2,}(.+?)\s+xx(\d{4})\s+(\d+)\s+([\d,]+\.\d{2})\s*$/.exec(line);
    if (!m) continue;
    if (by[m[1]]) defects.push(`association ${m[1]} is listed twice`);
    by[m[1]] = { name: m[2].trim(), last4: m[3], count: Number(m[4]), cents: cents(m[5]) };
  }
  const t = /Totals:\s+(\d+)\s+([\d,]+\.\d{2})/.exec(text);
  const v = Object.values(by);
  if (!t) defects.push('no printed totals');
  else if (Number(t[1]) !== v.reduce((s, x) => s + x.count, 0) || cents(t[2]) !== v.reduce((s, x) => s + x.cents, 0)) defects.push('associations do not add up to the printed totals');
  return { date: reportDate(text), associations: by, defects };
}

function parseImages(text) {
  const rows = [];
  for (const m of String(text).matchAll(/Batch:\s*(\d+)\s+Seq:\s*(\d+)\s+Remittance #:\s*(\S+)\s+Remittance Name:\s*(.*?)\s+Check#:\s*(\d+)\s+Amount:\s*([\d,]+\.\d{2})\s+Image\s+(\d+)\s+of\s+(\d+)/g)) {
    if (Number(m[7]) === 1) rows.push({ batch: m[1], seq: m[2], account: accountKey(m[3]), check: m[5].slice(-8).padStart(8, '0'), amount_cents: cents(m[6]) });
  }
  return { date: reportDate(text), rows };
}

// Which report a file is, from its printed content (never from its name alone).
function identifyReport(text) {
  const t = String(text);
  if (/Image Report/.test(t) && /Batch:\s*\d+/.test(t)) return 'images';
  if (/Summary Report/.test(t) && /Total Deposit/.test(t)) return /ECHECK/.test(t) ? 'epay_summary' : 'check_summary';
  if (/Remittance Report/.test(t) && /Remittance Number/.test(t)) return /ECHECK/.test(t) ? 'epay_detail' : 'check_detail';
  return null;
}

// The file against its reports. Refuses unless EVERY record pairs with exactly one
// detail row, every association total equals the Summary, and every check has one
// image entry. -> { ok, problems, records (with name, batch, seq, last4) }
function tieOut(txt, reports) {
  const problems = [...txt.defects.map((d) => `TXT ${d}`)];
  const sides = [['check', (r) => r.kind === 'check'], ['epay', (r) => r.kind !== 'check']];
  const records = txt.records.map((r) => ({ ...r }));
  for (const [side, is] of sides) {
    const R = records.filter(is);
    const detail = reports[`${side}_detail`]; const summary = reports[`${side}_summary`];
    if (!R.length && !detail && !summary) continue;
    if (!detail || !summary) { problems.push(`${side === 'check' ? 'lockbox check' : 'e-payment'} records need both the Detail and the Summary report`); continue; }
    for (const [n, p] of [['Detail', detail], ['Summary', summary]]) {
      for (const d of p.defects) problems.push(`${side} ${n}: ${d}`);
      if (p.date !== txt.file_date) problems.push(`${side} ${n} is dated ${p.date}, the file ${txt.file_date}`);
    }
    const pool = detail.rows.slice();
    for (const r of R) {
      const want = r.kind === 'check' ? r.check_number : r.kind === 'card' ? CARD : ECHECK;
      const k = pool.findIndex((d) => d.account === r.account && d.amount_cents === r.amount_cents && d.kind === r.kind && d.check === want);
      if (k < 0) { problems.push(`line ${r.line}: no matching row on the Detail report`); continue; }
      r.bank_name = pool[k].name; pool.splice(k, 1);
    }
    if (pool.length) problems.push(`${pool.length} Detail row(s) are not in the TXT`);
    const by = {}; for (const r of R) { const a = by[r.association_code] = by[r.association_code] || { count: 0, cents: 0 }; a.count++; a.cents += r.amount_cents; }
    for (const code of new Set([...Object.keys(by), ...Object.keys(summary.associations)])) {
      const a = by[code]; const s = summary.associations[code];
      if (!a || !s || a.count !== s.count || a.cents !== s.cents) problems.push(`association ${code}: the TXT and the ${side} Summary differ`);
    }
    for (const r of R) r.bank_last4 = (summary.associations[r.association_code] || {}).last4 || null;
  }
  const checks = records.filter((r) => r.kind === 'check');
  if (checks.length) {
    if (!reports.images) problems.push('check records need the Image report');
    else {
      if (reports.images.date !== txt.file_date) problems.push(`Image report is dated ${reports.images.date}, the file ${txt.file_date}`);
      const pool = reports.images.rows.slice();
      for (const r of checks) {
        const k = pool.findIndex((x) => x.account === r.account && x.amount_cents === r.amount_cents && x.check === r.check_number);
        if (k < 0) { problems.push(`line ${r.line}: no image entry`); continue; }
        r.batch = pool[k].batch; r.seq = pool[k].seq; pool.splice(k, 1);
      }
      if (pool.length) problems.push(`${pool.length} image entr(ies) are not in the TXT`);
    }
  }
  return { ok: problems.length === 0, problems, records };
}

module.exports = { parseTxt, parseDetail, parseSummary, parseImages, identifyReport, tieOut, accountKey, ASSOCIATIONS, ECHECK, CARD, RECORD_LENGTH };
