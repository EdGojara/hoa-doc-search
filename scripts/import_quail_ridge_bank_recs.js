// ============================================================================
// scripts/import_quail_ridge_bank_recs.js
// ----------------------------------------------------------------------------
// Import Quail Ridge's Vantaca Bank Reconciliation reports (5 monthly periods,
// 12/31/2025 - 4/30/2026; Ed 2026-06-20) into trustEd's bank-rec tables
// (migration 169). Two accounts per period: QR Operating (-4536, GL 1000) and
// QR CAP RSV (-9471, GL 1100).
//
// Each file maps cleanly onto the existing schema:
//   Bank Bal.       -> bank_ending_balance_cents
//   Uncleared Items -> bank_reconciliation_items (deposit_in_transit if +,
//                      outstanding_check if -) + DIT / outstanding totals
//   Adj. Balance    -> reconciled_balance_cents (= bank + net uncleared)
//   Book Balance    -> gl_ending_balance_cents
//   difference      -> Adj - Book (0 = Balanced; else Vantaca's own out-of-
//                      balance amount, preserved verbatim)
//   Status          -> 'reconciled' | 'unbalanced'
//
// Verifies: 12/31 book balances = trustEd GL opening cash (1000/1100), and each
// period's Book Balance against trustEd's own GL cash running balance.
// Requires migration 233 (grants) applied. --apply to write.
// ============================================================================
require('dotenv').config();
const XLSX = require('xlsx');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extract: extractBankStatement } = require('../lib/banking/extractors/bank_statement');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const FILES = ['BankReconciliation.xls', 'BankReconciliation (1).xls', 'BankReconciliation (2).xls', 'BankReconciliation (3).xls', 'BankReconciliation (4).xls'];
const DIR = 'C:/Users/edget/Downloads/';
// First Citizens operating-account (-4536) statements, by period end. The
// statement ending balance ties to each rec's Bank Balance (verified).
const STMT_FILES = {
  '2025-12-31': '12-2025 First Citizens Bank Statement - 4536.pdf',
  '2026-01-31': '01-2026 First Citizens Bank Statement - 4536.pdf',
  '2026-02-28': '02-2026 First Citizens Bank Statement - 4536.pdf',
  '2026-03-31': '03-2026 First Citizens Bank Statement - 4536.pdf',
  '2026-04-30': '04-2026 First Citizens Bank Statement - 4536.pdf',
  '2026-05-31': '05-2026 First Citizens Bank Statement - 4536.pdf',
};

const D = (d) => Math.round(d * 100);
const num = (v) => { let t = String(v || '').trim(); if (t === '-' || t === '') return 0; const neg = /^-/.test(t) || /^\(.*\)$/.test(t); t = t.replace(/[^0-9.]/g, ''); const n = parseFloat(t) || 0; return neg ? -n : n; };
const isoDate = (mdy) => { const m = String(mdy || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null; };
// Account label -> {nickname, last4, type, gl}
const ACCT_META = {
  'QR Operating - 4536': { nickname: 'QR Operating', last4: '4536', type: 'operating', gl: '1000' },
  'QR CAP RSV - 9471':   { nickname: 'QR CAP RSV',   last4: '9471', type: 'reserve',   gl: '1100' },
};

function parseRecFile(file) {
  const aoa = XLSX.utils.sheet_to_json(XLSX.readFile(DIR + file).Sheets['BankReconciliation'], { header: 1, defval: null, raw: false });
  const period = isoDate((aoa.find((r) => /for Period/i.test(String((r && r[0]) || ''))) || [''])[0].match(/for Period\s*(.+)/i)[1]);
  const summary = {}; // acctLabel -> { bank, uncleared, adj, book, status }
  const uncleared = {}; // acctLabel -> [{date, desc, check, amount}]
  let section = null, curAcct = null;
  for (const r of aoa) {
    const c0 = String((r && r[0]) || '').trim();
    if (/^Reconciliation Summary/i.test(c0)) { section = 'summary'; continue; }
    if (/^Unreconciled Items/i.test(c0)) { section = 'unreconciled'; curAcct = null; continue; }
    if (/^Reconciled Items/i.test(c0)) { section = 'reconciled'; curAcct = null; continue; }
    // Real column layout (null-padded): label=0, Bank=2, Uncleared=4, Adj=5, Book=6, Status=9.
    if (section === 'summary' && ACCT_META[c0]) {
      summary[c0] = { bank: num(r[2]), uncleared: num(r[4]), adj: num(r[5]), book: num(r[6]), status: String(r[9] || '').trim() };
    } else if (section === 'unreconciled') {
      if (ACCT_META[c0]) { curAcct = c0; uncleared[c0] = []; continue; }
      if (/^Total/i.test(c0)) { curAcct = null; continue; }
      // Item layout: date=0, desc=1, check=7, amount=8.
      if (curAcct && isoDate(c0)) uncleared[curAcct].push({ date: isoDate(c0), desc: String(r[1] || '').trim(), check: String(r[7] || '').trim(), amount: num(r[8]) });
    }
  }
  return { period, summary, uncleared };
}

(async () => {
  const { data: comm } = await s.from('communities').select('id, management_company_id').eq('id', CID).single();
  const mc = comm.management_company_id;

  // GL cash balances per month-end (for the integration cross-check).
  const { data: coa } = await s.from('chart_of_accounts').select('id, account_number').eq('community_id', CID).in('account_number', ['1000', '1100']);
  const acctId = Object.fromEntries(coa.map((a) => [a.account_number, a.id]));
  const glRunning = {}; // 'YYYY-MM-DD' period_end -> { '1000': cents, '1100': cents }

  const parsed = FILES.map(parseRecFile).sort((a, b) => a.period.localeCompare(b.period));
  console.log('Parsed periods:', parsed.map((p) => p.period).join(', '));

  // GL cash running balance at each period end (signed debit-positive).
  for (const p of parsed) {
    glRunning[p.period] = {};
    for (const gl of ['1000', '1100']) {
      const { data } = await s.from('journal_entry_lines')
        .select('debit_cents, credit_cents, journal_entries!inner(posting_date, community_id)')
        .eq('account_id', acctId[gl]).eq('journal_entries.community_id', CID).lte('journal_entries.posting_date', p.period);
      glRunning[p.period][gl] = (data || []).reduce((a, l) => a + Number(l.debit_cents) - Number(l.credit_cents), 0);
    }
  }

  // Verify book balances vs GL cash.
  console.log('\nPERIOD       ACCT          BOOK(Vantaca)   GL-CASH(trustEd)   MATCH');
  for (const p of parsed) {
    for (const [label, meta] of Object.entries(ACCT_META)) {
      const sm = p.summary[label]; if (!sm) continue;
      const book = D(sm.book), glc = glRunning[p.period][meta.gl];
      console.log(`${p.period}   ${meta.nickname.padEnd(12)}  ${('$' + (book / 100).toLocaleString()).padStart(12)}   ${('$' + (glc / 100).toLocaleString()).padStart(14)}   ${book === glc ? '✓' : 'Δ $' + ((book - glc) / 100).toFixed(2)}`);
    }
  }

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write bank accounts + reconciliations.'); return; }

  // 1) bank_accounts (find or create by community + last4).
  const { data: existingBa } = await s.from('bank_accounts').select('id, account_last4').eq('community_id', CID);
  const baByLast4 = Object.fromEntries((existingBa || []).map((b) => [b.account_last4, b.id]));
  for (const [label, meta] of Object.entries(ACCT_META)) {
    if (baByLast4[meta.last4]) continue;
    const { data, error } = await s.from('bank_accounts').insert({
      management_company_id: mc, community_id: CID, account_nickname: meta.nickname,
      account_last4: meta.last4, account_type: meta.type, gl_account_number: meta.gl, is_active: true,
    }).select('id').single();
    if (error) { console.error('bank_account insert failed:', error.message); process.exit(1); }
    baByLast4[meta.last4] = data.id;
  }

  // 2) idempotent: clear existing recs for these periods (items cascade).
  const periods = parsed.map((p) => p.period);
  await s.from('bank_reconciliations').delete().eq('community_id', CID).in('period_end', periods);

  // 3) insert reconciliations + items.
  let recCount = 0, itemCount = 0;
  for (const p of parsed) {
    for (const [label, meta] of Object.entries(ACCT_META)) {
      const sm = p.summary[label]; if (!sm) continue;
      const items = p.uncleared[label] || [];
      const dit = items.filter((i) => i.amount > 0).reduce((a, i) => a + D(i.amount), 0);
      const oc = items.filter((i) => i.amount < 0).reduce((a, i) => a - D(i.amount), 0); // stored positive
      const reconciled = D(sm.bank) + dit - oc;       // = Adj. Balance
      const difference = reconciled - D(sm.book);      // Adj - Book
      const balanced = difference === 0;
      const { data: rec, error: recErr } = await s.from('bank_reconciliations').insert({
        management_company_id: mc, community_id: CID, bank_account_id: baByLast4[meta.last4],
        period_end: p.period,
        bank_ending_balance_cents: D(sm.bank), gl_ending_balance_cents: D(sm.book),
        deposits_in_transit_total_cents: dit, outstanding_checks_total_cents: oc,
        reconciled_balance_cents: reconciled, difference_cents: difference,
        status: balanced ? 'reconciled' : 'unbalanced',
        notes: `Imported from Vantaca rec (${sm.status})`,
      }).select('id').single();
      if (recErr) { console.error(`rec insert failed (${p.period} ${label}):`, recErr.message); process.exit(1); }
      recCount++;
      const itemRows = items.map((i) => ({
        reconciliation_id: rec.id,
        category: i.amount >= 0 ? 'deposit_in_transit' : 'outstanding_check',
        amount_cents: D(i.amount), date_ref: i.date, description: i.desc,
        check_number: i.check && !/^cash receipts$/i.test(i.check) ? i.check : null,
        match_method: 'vantaca_import',
      }));
      if (itemRows.length) { const { error } = await s.from('bank_reconciliation_items').insert(itemRows); if (error) { console.error('items insert failed:', error.message); process.exit(1); } itemCount += itemRows.length; }
    }
  }
  console.log(`\nImported ${recCount} reconciliations + ${itemCount} uncleared items across ${periods.length} periods.`);

  // 4) Bank statements (operating account, -4536) — the third leg. Extract via
  // Claude PDF-binary, store summary + transactions, link to the period's rec.
  const operatingBaId = baByLast4['4536'];
  // idempotent: clear prior statement imports for these periods (tx cascade).
  await s.from('bank_statement_imports').delete().eq('community_id', CID).eq('bank_account_id', operatingBaId).in('statement_period_end', Object.keys(STMT_FILES));
  // re-fetch recs so we can link by period.
  const { data: recsForLink } = await s.from('bank_reconciliations').select('id, period_end').eq('community_id', CID).eq('bank_account_id', operatingBaId);
  const recByPeriod = Object.fromEntries((recsForLink || []).map((r) => [String(r.period_end).slice(0, 10), r.id]));

  let stmtCount = 0, stmtTx = 0;
  for (const [periodEnd, file] of Object.entries(STMT_FILES)) {
    const path = DIR + file;
    if (!fs.existsSync(path)) { console.warn('  statement missing:', file); continue; }
    const buf = fs.readFileSync(path);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    let ext;
    try { ext = await extractBankStatement(buf, 'application/pdf', file); }
    catch (e) { console.error(`  statement extract failed (${file}):`, e.message); continue; }
    const { data: bsi, error: bsiErr } = await s.from('bank_statement_imports').insert({
      management_company_id: mc, community_id: CID, bank_account_id: operatingBaId,
      statement_period_start: ext.period_start || null, statement_period_end: ext.period_end || periodEnd,
      beginning_balance_cents: ext.beginning_balance_cents ?? null, ending_balance_cents: ext.ending_balance_cents ?? null,
      total_deposits_cents: ext.total_deposits_cents ?? null, total_withdrawals_cents: ext.total_withdrawals_cents ?? null,
      total_fees_cents: ext.total_fees_cents ?? null, total_interest_cents: ext.total_interest_cents ?? null,
      source_filename: file, source_sha256: sha, source_file_mime: 'application/pdf',
      extraction_raw: ext, extraction_warnings: ext.warnings || [], status: 'completed',
    }).select('id').single();
    if (bsiErr) { console.error(`  statement insert failed (${file}):`, bsiErr.message); continue; }
    stmtCount++;
    const txRows = (ext.transactions || []).filter((t) => t.posting_date && t.amount_cents != null).map((t) => ({
      bank_statement_import_id: bsi.id, posting_date: t.posting_date, amount_cents: t.amount_cents,
      description: t.description || null, check_number: t.check_number || null, transaction_type: t.transaction_type || 'other',
    }));
    if (txRows.length) { const { error } = await s.from('bank_statement_transactions').insert(txRows); if (error) console.warn('  tx insert failed:', error.message); else stmtTx += txRows.length; }
    // link to the rec for this period (if one exists)
    if (recByPeriod[periodEnd]) await s.from('bank_reconciliations').update({ bank_statement_import_id: bsi.id }).eq('id', recByPeriod[periodEnd]);
    console.log(`  ${periodEnd}: ${file} — ending ${(ext.ending_balance_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}, ${txRows.length} txns${recByPeriod[periodEnd] ? ' (linked)' : ' (no rec)'}`);
  }
  console.log(`\nImported ${stmtCount} bank statements + ${stmtTx} statement transactions.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
