// ============================================================================
// scripts/archive_quail_ridge_cutover_docs.js
// ----------------------------------------------------------------------------
// Archive the source documents that back Quail Ridge's 2026 books into trustEd's
// document library (library_documents + Supabase 'library' storage), renamed to
// the house convention "{Community} - {Type} - {Qualifier} - {Period}.{ext}".
// These are association records — the HOA's financial books — so they hand over
// cleanly at termination.
//
// Only the authoritative cutover files are archived (not the dozens of duplicate
// downloads). Bank statements are also linked back to their reconciliation by
// setting bank_statement_imports.source_storage_path. Idempotent: dedup by
// (community_id, file_hash). --apply to write; dry-run shows the renames.
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const APPLY = process.argv.includes('--apply');
const CID = 'a0000000-0000-4000-8000-000000000005';
const DIR = 'C:/Users/edget/Downloads/';

// src file, category, normalized name, period_label, effective_date, title.
const DOCS = [
  ['12-2025 First Citizens Bank Statement - 4536.pdf', 'bank_statement', 'Quail Ridge - Bank Statement - Operating x4536 - 2025-12.pdf', '2025-12', '2025-12-31'],
  ['01-2026 First Citizens Bank Statement - 4536.pdf', 'bank_statement', 'Quail Ridge - Bank Statement - Operating x4536 - 2026-01.pdf', '2026-01', '2026-01-31'],
  ['02-2026 First Citizens Bank Statement - 4536.pdf', 'bank_statement', 'Quail Ridge - Bank Statement - Operating x4536 - 2026-02.pdf', '2026-02', '2026-02-28'],
  ['03-2026 First Citizens Bank Statement - 4536.pdf', 'bank_statement', 'Quail Ridge - Bank Statement - Operating x4536 - 2026-03.pdf', '2026-03', '2026-03-31'],
  ['04-2026 First Citizens Bank Statement - 4536.pdf', 'bank_statement', 'Quail Ridge - Bank Statement - Operating x4536 - 2026-04.pdf', '2026-04', '2026-04-30'],
  ['05-2026 First Citizens Bank Statement - 4536.pdf', 'bank_statement', 'Quail Ridge - Bank Statement - Operating x4536 - 2026-05.pdf', '2026-05', '2026-05-31'],
  ['GLTrialBalance.xls', 'gl_trial_balance', 'Quail Ridge - GL Trial Balance (Detail) - 2026 Jan-May.xls', '2026', '2026-05-31'],
  ['GLTrialBalance (1).xls', 'gl_trial_balance', 'Quail Ridge - GL Trial Balance (Detail) - 2026-06 through 06-18.xls', '2026-06', '2026-06-20'],
  ['BalanceSheet.xls', 'financial_statement', 'Quail Ridge - Balance Sheet - 2025-12-31 (Opening).xls', '2025-12', '2025-12-31'],
  ['Income Statement.xls', 'financial_statement', 'Quail Ridge - Income Statement - 2026 YTD through 05-31.xls', '2026', '2026-05-31'],
  ['AR Aging.xls', 'ar_aging', 'Quail Ridge - AR Aging - 2025-12-31.xls', '2025-12', '2025-12-31'],
  ['BankReconciliation.xls', 'bank_reconciliation', 'Quail Ridge - Bank Reconciliation - 2025-12-31.xls', '2025-12', '2025-12-31'],
  ['BankReconciliation (1).xls', 'bank_reconciliation', 'Quail Ridge - Bank Reconciliation - 2026-01-31.xls', '2026-01', '2026-01-31'],
  ['BankReconciliation (2).xls', 'bank_reconciliation', 'Quail Ridge - Bank Reconciliation - 2026-02-28.xls', '2026-02', '2026-02-28'],
  ['BankReconciliation (3).xls', 'bank_reconciliation', 'Quail Ridge - Bank Reconciliation - 2026-03-31.xls', '2026-03', '2026-03-31'],
  ['BankReconciliation (4).xls', 'bank_reconciliation', 'Quail Ridge - Bank Reconciliation - 2026-04-30.xls', '2026-04', '2026-04-30'],
  ['Bank Register Export.xlsx', 'bank_register', 'Quail Ridge - Bank Register (Operating x4536) - through 2026-06-18.xlsx', '2026', '2026-06-18'],
  ['TransactionHistoryAssoc (1).xls', 'unit_ledger', 'Quail Ridge - Homeowner Transaction History - 2026 through 06-09.xls', '2026', '2026-06-09'],
  ['PrepaidHomeowners.xls', 'ar_aging', 'Quail Ridge - Prepaid Homeowner Credits - 2025-12-31.xls', '2025-12', '2025-12-31'],
];
const MIME = { '.pdf': 'application/pdf', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

(async () => {
  const { data: comm } = await s.from('communities').select('slug, management_company_id').eq('id', CID).single();
  const slug = comm.slug, mc = comm.management_company_id;
  // existing hashes (dedup)
  const { data: existing } = await s.from('library_documents').select('file_hash').eq('community_id', CID);
  const seen = new Set((existing || []).map((e) => e.file_hash).filter(Boolean));

  // bank statement imports, to link the PDF back to its reconciliation
  const { data: bsi } = await s.from('bank_statement_imports').select('id, statement_period_end, source_storage_path').eq('community_id', CID);
  const bsiByPeriod = Object.fromEntries((bsi || []).map((b) => [String(b.statement_period_end).slice(0, 10), b]));

  console.log(`Archiving ${DOCS.length} cutover documents for Quail Ridge — renamed:\n`);
  let done = 0, skipped = 0;
  for (const [src, category, normalized, period, eff] of DOCS) {
    const path = DIR + src;
    if (!fs.existsSync(path)) { console.warn(`  MISSING: ${src}`); continue; }
    const buf = fs.readFileSync(path);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const ext = src.slice(src.lastIndexOf('.')).toLowerCase();
    console.log(`  ${src}`);
    console.log(`     ->  [${category}]  ${normalized}`);
    if (seen.has(hash)) { console.log('     (already archived — skipped)'); skipped++; continue; }
    if (!APPLY) { continue; }

    const storagePath = `${slug}/${category}/${hash.slice(0, 12)}${ext}`;
    const { error: upErr } = await s.storage.from('documents').upload(storagePath, buf, { contentType: MIME[ext] || 'application/octet-stream', upsert: true });
    if (upErr) { console.error('     upload failed:', upErr.message); continue; }
    const { data: doc, error: insErr } = await s.from('library_documents').insert({
      management_company_id: mc, community_id: CID, category,
      period_label: period, effective_date: eff, status: 'current',
      title: normalized.replace(/\.[^.]+$/, ''), file_name_original: src, file_name_normalized: normalized,
      file_path: storagePath, file_hash: hash, file_size_bytes: buf.length,
      created_by_mgmt_company: 'Bedrock',
      notes: 'Source document backing the Quail Ridge 2026 books (6/1 cutover). Association record.',
    }).select('id').single();
    if (insErr) { console.error('     record insert failed:', insErr.message); continue; }
    seen.add(hash); done++;
    // link bank statement PDFs to their reconciliation import
    if (category === 'bank_statement' && bsiByPeriod[eff] && !bsiByPeriod[eff].source_storage_path) {
      await s.from('bank_statement_imports').update({ source_storage_path: storagePath }).eq('id', bsiByPeriod[eff].id);
      console.log('     linked to its bank reconciliation ✓');
    }
  }
  console.log(`\n${APPLY ? `Archived ${done} documents (${skipped} already present).` : 'DRY RUN — pass --apply to upload + file these.'}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
