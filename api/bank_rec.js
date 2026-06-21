// ============================================================================
// Bank Reconciliation — three-way rec workflow
// ----------------------------------------------------------------------------
// Mounted at /api/bank-rec.
//
// Flow:
//   1. POST /reconciliations               — create rec shell (community, account, period)
//   2. POST /reconciliations/:id/bank-statement — upload bank statement PDF
//   3. POST /reconciliations/:id/check-register — link existing vantaca_import OR upload
//   4. POST /reconciliations/:id/gl              — link existing vantaca_import OR upload
//   5. POST /reconciliations/:id/run-match      — run matcher, persist items
//   6. PATCH /reconciliations/:id/items/:itemId — operator override
//   7. PATCH /reconciliations/:id               — notes, status transitions
//   8. GET   /reconciliations/:id/cheat-sheet   — printable HTML for Vantaca entry
//
// HONEST FRAMING (per Ed 2026-06-06):
// Today this is a cheat sheet for faster Vantaca data entry. Tomorrow when
// trustEd holds the full GL mirror, the Vantaca step drops out and this
// becomes the canonical rec.
// ============================================================================

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extract: extractBankStatement } = require('../lib/banking/extractors/bank_statement');
const { parseDepositRegister, depositsToGlEntries } = require('../lib/banking/extractors/deposit_register');
const { parseVantacaPayPayouts } = require('../lib/banking/extractors/vantaca_pay_payouts');
const { parseCheckRegister, checksToMatcherShape } = require('../lib/banking/extractors/check_register');
const { parseGlTrialBalance } = require('../lib/banking/extractors/gl_cash');
const { reconcile } = require('../lib/banking/matcher');
const { boundaryReconcile } = require('../lib/banking/boundary_rec');
const { buildWorksheet, worksheetFromMatcher } = require('../lib/banking/clearing_worksheet');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// YYYY-MM-DD minus N days (UTC). Used to widen the deposit window so a late
// prior-month deposit that clears early this month is still a candidate.
function isoMinusDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Bank accounts (config)
// ---------------------------------------------------------------------------
router.get('/accounts', async (req, res) => {
  try {
    const { community_id } = req.query;
    let q = supabase.from('bank_accounts')
      .select('*, communities(name)')
      .eq('is_active', true)
      .order('account_nickname')
      .limit(200);
    if (community_id) q = q.eq('community_id', community_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    console.error('[bank-rec] list accounts failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/accounts', express.json(), async (req, res) => {
  try {
    const { community_id, account_nickname, bank_name, account_last4, account_type, gl_account_number } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!account_nickname) return res.status(400).json({ error: 'account_nickname_required' });
    const { data, error } = await supabase
      .from('bank_accounts')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id,
        account_nickname,
        bank_name: bank_name || null,
        account_last4: account_last4 || null,
        account_type: account_type || 'operating',
        gl_account_number: gl_account_number || null,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ account: data });
  } catch (err) {
    console.error('[bank-rec] create account failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Reconciliations
// ---------------------------------------------------------------------------
router.post('/reconciliations', express.json(), async (req, res) => {
  try {
    const { community_id, bank_account_id, period_end, period_start, notes } = req.body || {};
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    if (!period_end) return res.status(400).json({ error: 'period_end_required' });
    const { data, error } = await supabase
      .from('bank_reconciliations')
      .insert({
        management_company_id: BEDROCK_MGMT_CO_ID,
        community_id,
        bank_account_id: bank_account_id || null,
        period_end,
        period_start: period_start || null,
        status: 'in_progress',
        notes: notes || null,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ reconciliation: data });
  } catch (err) {
    console.error('[bank-rec] create rec failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/reconciliations', async (req, res) => {
  try {
    const { community_id, status, limit = '50' } = req.query;
    let q = supabase.from('bank_reconciliations')
      .select('*, communities(name, slug), bank_accounts(account_nickname, bank_name, account_last4)')
      .order('period_end', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 50, 200));
    if (community_id) q = q.eq('community_id', community_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ reconciliations: data || [] });
  } catch (err) {
    console.error('[bank-rec] list recs failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/reconciliations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: rec, error: recErr }, { data: items }] = await Promise.all([
      supabase.from('bank_reconciliations')
        .select('*, communities(name, slug), bank_accounts(account_nickname, bank_name, account_last4)')
        .eq('id', id).maybeSingle(),
      supabase.from('bank_reconciliation_items')
        .select('*')
        .eq('reconciliation_id', id)
        .order('category')
        .order('date_ref', { ascending: true, nullsFirst: false })
        .limit(2000),
    ]);
    if (recErr) throw recErr;
    if (!rec) return res.status(404).json({ error: 'not_found' });

    // Pull source extractions so the UI can show what was matched
    let bankStatement = null;
    let checkRegister = null;
    let glExport = null;
    if (rec.bank_statement_import_id) {
      const { data } = await supabase.from('bank_statement_imports')
        .select('*').eq('id', rec.bank_statement_import_id).maybeSingle();
      bankStatement = data;
    }
    if (rec.check_register_import_id) {
      const { data } = await supabase.from('vantaca_imports')
        .select('*').eq('id', rec.check_register_import_id).maybeSingle();
      checkRegister = data;
    }
    if (rec.gl_import_id) {
      const { data } = await supabase.from('vantaca_imports')
        .select('*').eq('id', rec.gl_import_id).maybeSingle();
      glExport = data;
    }

    res.json({
      reconciliation: rec,
      items: items || [],
      sources: { bank_statement: bankStatement, check_register: checkRegister, gl_export: glExport },
    });
  } catch (err) {
    console.error('[bank-rec] get rec failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.patch('/reconciliations/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['notes', 'status', 'period_start', 'bank_account_id'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if (patch.status === 'exported_to_vantaca') patch.exported_at = new Date().toISOString();
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no_fields' });
    const { data, error } = await supabase
      .from('bank_reconciliations').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    res.json({ reconciliation: data });
  } catch (err) {
    console.error('[bank-rec] update rec failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Attach bank statement (upload + extract)
// ---------------------------------------------------------------------------
router.post('/reconciliations/:id/bank-statement', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file_required' });

    const { data: rec } = await supabase.from('bank_reconciliations')
      .select('*').eq('id', id).maybeSingle();
    if (!rec) return res.status(404).json({ error: 'rec_not_found' });

    const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const safeName = (req.file.originalname || 'bank-statement.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `bank-statements/${rec.community_id}/${sha.slice(0, 12)}-${safeName}`;
    try {
      await supabase.storage.from('documents').upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype, upsert: false,
      });
    } catch (e) { /* non-fatal */ }

    // Extract via Claude binary read
    let extracted = null;
    let warnings = [];
    try {
      extracted = await extractBankStatement(req.file.buffer, req.file.mimetype, req.file.originalname);
      warnings = extracted.warnings || [];
    } catch (e) {
      console.error('[bank-rec] bank statement extraction failed:', e.message);
      return res.status(500).json({ error: 'extraction_failed', detail: e.message });
    }

    // Insert bank_statement_imports row
    const { data: bsi, error: bsiErr } = await supabase.from('bank_statement_imports').insert({
      management_company_id: BEDROCK_MGMT_CO_ID,
      community_id: rec.community_id,
      bank_account_id: rec.bank_account_id || null,
      statement_period_start: extracted.period_start || null,
      statement_period_end: extracted.period_end || null,
      beginning_balance_cents: extracted.beginning_balance_cents ?? null,
      ending_balance_cents: extracted.ending_balance_cents ?? null,
      total_deposits_cents: extracted.total_deposits_cents ?? null,
      total_withdrawals_cents: extracted.total_withdrawals_cents ?? null,
      total_fees_cents: extracted.total_fees_cents ?? null,
      total_interest_cents: extracted.total_interest_cents ?? null,
      source_filename: req.file.originalname || null,
      source_storage_path: storagePath,
      source_sha256: sha,
      source_file_size_bytes: req.file.size,
      source_file_mime: req.file.mimetype,
      extraction_raw: extracted,
      extraction_warnings: warnings,
      status: 'completed',
    }).select('*').single();
    if (bsiErr) throw bsiErr;

    // Insert transaction rows
    const txRows = (extracted.transactions || []).filter((t) => t.posting_date && t.amount_cents != null).map((t) => ({
      bank_statement_import_id: bsi.id,
      posting_date: t.posting_date,
      amount_cents: t.amount_cents,
      description: t.description || null,
      check_number: t.check_number || null,
      transaction_type: t.transaction_type || 'other',
      raw_extracted_text: null,
    }));
    if (txRows.length > 0) {
      const { error: txErr } = await supabase.from('bank_statement_transactions').insert(txRows);
      if (txErr) console.warn('[bank-rec] tx insert failed:', txErr.message);
    }

    // Link to rec
    await supabase.from('bank_reconciliations').update({
      bank_statement_import_id: bsi.id,
      bank_ending_balance_cents: extracted.ending_balance_cents ?? null,
    }).eq('id', id);

    res.json({ bank_statement_import: bsi, transaction_count: txRows.length, warnings });
  } catch (err) {
    console.error('[bank-rec] attach bank statement failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Attach check register or GL — uses existing vantaca_imports row by ID,
// OR uploads a new one through that flow (operator can do either)
// ---------------------------------------------------------------------------
async function linkVantacaImport(recId, importId, fieldName, supabase) {
  // Verify the import exists and is the right report type for the field
  const expectedType = fieldName === 'check_register_import_id' ? 'check_register' : 'gl_export';
  const { data: imp } = await supabase.from('vantaca_imports')
    .select('*').eq('id', importId).maybeSingle();
  if (!imp) return { error: 'import_not_found' };
  if (imp.report_type !== expectedType) {
    return { error: `wrong_report_type — expected ${expectedType}, got ${imp.report_type}` };
  }
  const patch = { [fieldName]: importId };
  // If GL, also capture ending balance into the rec summary
  if (fieldName === 'gl_import_id' && imp.extraction_raw?.ending_balance_cents != null) {
    patch.gl_ending_balance_cents = imp.extraction_raw.ending_balance_cents;
  }
  const { error } = await supabase.from('bank_reconciliations').update(patch).eq('id', recId);
  if (error) return { error: error.message };
  return { ok: true, import: imp };
}

router.post('/reconciliations/:id/check-register', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { vantaca_import_id } = req.body || {};
    if (!vantaca_import_id) return res.status(400).json({ error: 'vantaca_import_id_required' });
    const result = await linkVantacaImport(id, vantaca_import_id, 'check_register_import_id', supabase);
    if (result.error) return res.status(400).json(result);
    res.json({ check_register_import: result.import });
  } catch (err) {
    console.error('[bank-rec] attach check register failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/reconciliations/:id/gl', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { vantaca_import_id } = req.body || {};
    if (!vantaca_import_id) return res.status(400).json({ error: 'vantaca_import_id_required' });
    const result = await linkVantacaImport(id, vantaca_import_id, 'gl_import_id', supabase);
    if (result.error) return res.status(400).json(result);
    res.json({ gl_import: result.import });
  } catch (err) {
    console.error('[bank-rec] attach gl failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Source-report uploads (.xls): deposit register, payout contents, check
// register. Each is parsed, the source file retained (documents bucket +
// library_documents), and the parsed structure stored on the rec as jsonb.
// ---------------------------------------------------------------------------
async function retainBankRecSource(file, rec, category, title) {
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const safeName = (file.originalname || 'report.xls').replace(/[^\w.\-]+/g, '_');
  const storage_path = `bank-rec/${rec.community_id}/${sha.slice(0, 12)}-${safeName}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(storage_path, file.buffer, {
    contentType: file.mimetype || 'application/vnd.ms-excel', upsert: true,
  });
  if (upErr) console.warn('[bank-rec] source file upload failed:', upErr.message);
  let source_document_id = null;
  const { data: libDoc, error: libErr } = await supabase.from('library_documents').insert({
    management_company_id: rec.management_company_id || BEDROCK_MGMT_CO_ID,
    community_id: rec.community_id,
    category,
    title,
    file_name_original: file.originalname || null,
    file_path: storage_path,
    file_hash: sha,
    file_size_bytes: file.size,
    created_by_mgmt_company: 'Bedrock',
  }).select('id').single();
  if (libErr) console.warn('[bank-rec] source retention insert failed:', libErr.message);
  else source_document_id = libDoc.id;
  return { storage_path, source_document_id };
}

// Continuous register: uploads append into community-wide tables (replacing any
// existing rows in the same account + date range, so a re-upload is idempotent).
// run-match reads the relevant date range — this is what makes the books
// continuous and lets cross-month deposits match (Dec deposit clearing in Jan).
async function _replaceRange(table, community_id, account_last4, dateCol, lo, hi) {
  let q = supabase.from(table).delete().eq('community_id', community_id).gte(dateCol, lo).lte(dateCol, hi);
  if (account_last4 != null) q = q.eq('account_last4', account_last4);
  await q;
}
async function _insertChunks(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 500));
    if (error) console.warn(`[bank-rec] ${table} insert failed:`, error.message);
  }
}
async function ingestDeposits(community_id, parsed, filename) {
  for (const acct of (parsed.accounts || [])) {
    const deposits = (acct.deposits || []).filter((d) => d.date && d.amount_cents != null);
    if (!deposits.length) continue;
    const dates = deposits.map((d) => d.date).sort();
    await _replaceRange('bank_rec_deposits', community_id, acct.account_last4, 'deposit_date', dates[0], dates[dates.length - 1]);
    await _insertChunks('bank_rec_deposits', deposits.map((d) => ({
      community_id, account_last4: acct.account_last4, deposit_date: d.date,
      description: d.description, check_number: d.check_number, amount_cents: d.amount_cents, source_filename: filename,
    })));
  }
}
async function ingestChecks(community_id, parsed, filename) {
  for (const acct of (parsed.accounts || [])) {
    const checks = (acct.checks || []).filter((c) => c.amount_cents != null);
    if (!checks.length) continue;
    const dates = checks.map((c) => c.date).filter(Boolean).sort();
    if (dates.length) await _replaceRange('bank_rec_checks', community_id, acct.account_last4, 'check_date', dates[0], dates[dates.length - 1]);
    await _insertChunks('bank_rec_checks', checks.map((c) => ({
      community_id, account_last4: acct.account_last4, check_date: c.date || null,
      payee: c.payee, check_number: c.check_number, amount_cents: c.amount_cents, source_filename: filename,
    })));
  }
}
async function ingestPayouts(community_id, parsed, filename) {
  const pays = (parsed.payments || []).filter((p) => p.amount_cents != null);
  if (!pays.length) return;
  const dates = pays.map((p) => p.trxn_date).filter(Boolean).sort();
  if (dates.length) await _replaceRange('bank_rec_payouts', community_id, null, 'trxn_date', dates[0], dates[dates.length - 1]);
  await _insertChunks('bank_rec_payouts', pays.map((p) => ({
    community_id, trxn_date: p.trxn_date, payout_date: p.payout_date, account_ref: p.account_ref,
    kind: p.kind, txn_type: p.type, amount_cents: p.amount_cents, source_filename: filename,
  })));
}

async function handleSourceUpload(req, res, { parse, column, category, label, ingest }) {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const { data: rec } = await supabase.from('bank_reconciliations').select('*').eq('id', id).maybeSingle();
  if (!rec) return res.status(404).json({ error: 'rec_not_found' });
  let parsed;
  try { parsed = parse(req.file.buffer); }
  catch (e) { return res.status(400).json({ error: `could_not_parse_${label}`, detail: e.message }); }
  // Continuous register (community-wide) + per-rec retention snapshot.
  try { if (ingest) await ingest(rec.community_id, parsed, req.file.originalname || null); }
  catch (e) { console.warn('[bank-rec] continuous ingest failed:', e.message); }
  const retain = await retainBankRecSource(req.file, rec, category, `${label} — ${rec.period_end || ''}`.trim());
  const payload = { storage_path: retain.storage_path, source_document_id: retain.source_document_id, uploaded_filename: req.file.originalname || null, parsed };
  const { error } = await supabase.from('bank_reconciliations').update({ [column]: payload }).eq('id', id);
  if (error) return res.status(500).json({ error: safeErrorMessage(error) });
  return res.json({ ok: true, [label]: { accounts: parsed.accounts ? parsed.accounts.length : undefined, count: parsed.payments ? parsed.payments.length : undefined, retained: !!retain.source_document_id } });
}

router.post('/reconciliations/:id/deposit-register', upload.single('file'), async (req, res) => {
  try { await handleSourceUpload(req, res, { parse: parseDepositRegister, column: 'deposit_register_data', category: 'bank_rec_source', label: 'deposit_register', ingest: ingestDeposits }); }
  catch (err) { console.error('[bank-rec] deposit register upload failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/reconciliations/:id/payout-contents', upload.single('file'), async (req, res) => {
  try { await handleSourceUpload(req, res, { parse: parseVantacaPayPayouts, column: 'vantaca_payout_data', category: 'bank_rec_source', label: 'payout_contents', ingest: ingestPayouts }); }
  catch (err) { console.error('[bank-rec] payout contents upload failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/reconciliations/:id/check-register-xls', upload.single('file'), async (req, res) => {
  try { await handleSourceUpload(req, res, { parse: parseCheckRegister, column: 'check_register_data', category: 'bank_rec_source', label: 'check_register', ingest: ingestChecks }); }
  catch (err) { console.error('[bank-rec] check register upload failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GL Trial Balance detail (.xls) — the COMPLETE book for pre-cutover periods.
// Ingests the cash account's transactions into the continuous bank_rec_gl_cash
// ledger and records the opening anchor (the cash account's beginning balance
// at the earliest period seen) on the bank account, so run-match can compute
// the period-end GL cash balance automatically (anchor + cumulative).
async function ingestGlCash(community_id, parsed, filename, glAccountNumber, acctLast4) {
  const acct = (parsed.accounts || []).find((a) => a.account_number === glAccountNumber)
    || (parsed.accounts || []).find((a) => a.account_number === '1000');
  if (!acct) return { ingested: 0, beginning_cents: null };
  const txns = (acct.transactions || []).filter((t) => t.date && t.amount_cents != null);
  if (txns.length) {
    const dates = txns.map((t) => t.date).sort();
    await _replaceRange('bank_rec_gl_cash', community_id, acctLast4, 'posting_date', dates[0], dates[dates.length - 1]);
    await _insertChunks('bank_rec_gl_cash', txns.map((t) => ({
      community_id, account_last4: acctLast4, gl_account: acct.account_number,
      posting_date: t.date, ledger_id: t.ledger_id || null, description: t.description || null,
      amount_cents: t.amount_cents,
      check_number: (String(t.description || '').match(/check\s*#?\s*(\d+)/i) || [])[1] || null,
      source_filename: filename,
    })));
  }
  return { ingested: txns.length, beginning_cents: acct.beginning_cents };
}

router.post('/reconciliations/:id/gl-trial-balance', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const { data: rec } = await supabase.from('bank_reconciliations').select('*').eq('id', id).maybeSingle();
    if (!rec) return res.status(404).json({ error: 'rec_not_found' });
    let parsed;
    try { parsed = parseGlTrialBalance(req.file.buffer); }
    catch (e) { return res.status(400).json({ error: 'could_not_parse_gl_trial_balance', detail: e.message }); }

    // Map this rec's bank account → GL cash account number + last4.
    let glNum = '1000', last4 = null;
    if (rec.bank_account_id) {
      const { data: ba } = await supabase.from('bank_accounts')
        .select('gl_account_number, account_last4, opening_position').eq('id', rec.bank_account_id).maybeSingle();
      if (ba) { glNum = ba.gl_account_number || '1000'; last4 = ba.account_last4 || null; }
      // Set / extend the GL anchor to the EARLIEST beginning balance seen.
      const acct = (parsed.accounts || []).find((a) => a.account_number === glNum)
        || (parsed.accounts || []).find((a) => a.account_number === '1000');
      if (acct && parsed.period_start) {
        const op = (ba && ba.opening_position) || {};
        if (!op.gl_anchor || parsed.period_start < op.gl_anchor.date) {
          op.gl_anchor = { date: parsed.period_start, balance_cents: acct.beginning_cents };
          await supabase.from('bank_accounts').update({ opening_position: op }).eq('id', rec.bank_account_id);
        }
      }
    }

    const out = await ingestGlCash(rec.community_id, parsed, req.file.originalname || null, glNum, last4);
    await retainBankRecSource(req.file, rec, 'bank_rec_source', `gl_trial_balance — ${parsed.period_start || ''}..${parsed.period_end || ''}`.trim());
    return res.json({ ok: true, gl_trial_balance: { period: [parsed.period_start, parsed.period_end], cash_account: glNum, ingested: out.ingested } });
  } catch (err) { console.error('[bank-rec] gl trial balance upload failed:', err); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Opening reconciled position ("stake in the ground") for a bank account.
// { as_of_date, outstanding_checks:[{check_number, amount_cents, issue_date, payee}],
//   deposits_in_transit:[{amount_cents, date, description}], gl_anchor:{date, balance_cents} }
// Merges with any existing position so the GL-upload-set anchor isn't clobbered.
router.put('/accounts/:id/opening-position', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { as_of_date, outstanding_checks, deposits_in_transit, gl_anchor } = req.body || {};
    const { data: ba } = await supabase.from('bank_accounts').select('opening_position').eq('id', id).maybeSingle();
    const op = (ba && ba.opening_position) || {};
    if (as_of_date !== undefined) op.as_of_date = as_of_date;
    if (Array.isArray(outstanding_checks)) op.outstanding_checks = outstanding_checks;
    if (Array.isArray(deposits_in_transit)) op.deposits_in_transit = deposits_in_transit;
    if (gl_anchor !== undefined) op.gl_anchor = gl_anchor;
    const { error } = await supabase.from('bank_accounts').update({ opening_position: op }).eq('id', id);
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    return res.json({ ok: true, opening_position: op });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---------------------------------------------------------------------------
// Boundary reconciliation summary — book vs bank = deposits in transit, by month.
// The accountant's view: each month-end's GL cash balance vs the bank statement,
// with the online deposits-in-transit (from the payout settlement key) explained
// and the rest surfaced as a review residual. Reads live, no persistence.
//   GET /boundary-summary?community_id=...&account_last4=...
// ---------------------------------------------------------------------------
router.get('/boundary-summary', async (req, res) => {
  try {
    const community_id = req.query.community_id;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    const account_last4 = req.query.account_last4 || null;

    // bank account + its GL cash account
    // A community can have several bank accounts — pick the requested one, else
    // default to the operating-cash account (don't error on multiple rows).
    const { data: bas } = await supabase.from('bank_accounts')
      .select('id, account_last4, gl_account_number').eq('community_id', community_id);
    const ba = account_last4
      ? (bas || []).find((a) => a.account_last4 === account_last4)
      : ((bas || []).find((a) => ['1000', '1005', '10100'].includes(String(a.gl_account_number))) || (bas || [])[0]);
    if (!ba) return res.status(404).json({ error: 'bank_account_not_found' });

    const tryNums = [ba.gl_account_number, '1000', '1005', '10100'].filter(Boolean);
    let cashAcctId = null;
    for (const n of tryNums) {
      const { data: a } = await supabase.from('chart_of_accounts').select('id').eq('community_id', community_id).eq('account_number', n).maybeSingle();
      if (a) { cashAcctId = a.id; break; }
    }
    if (!cashAcctId) return res.status(404).json({ error: 'cash_account_not_found' });

    // statements (one row per month-end) + all GL cash lines + all payouts
    const { data: stmts } = await supabase.from('bank_statement_imports')
      .select('statement_period_end, ending_balance_cents')
      .eq('bank_account_id', ba.id).order('statement_period_end', { ascending: true });
    const { data: glLines } = await supabase.from('journal_entry_lines')
      .select('debit_cents, credit_cents, journal_entries!inner(posting_date, community_id, status)')
      .eq('account_id', cashAcctId).eq('journal_entries.community_id', community_id).limit(100000);
    const liveLines = (glLines || []).filter((l) => (l.journal_entries.status || 'posted') !== 'voided');

    // Pre-cutover months have no live GL — the book lives in the INGESTED Vantaca
    // GL cash (bank_rec_gl_cash) on top of the opening anchor. Use live when it
    // exists for the month, else fall back to anchor + ingested (so 2025 months
    // show their real book balance instead of $0).
    const { data: glcash } = await supabase.from('bank_rec_gl_cash')
      .select('posting_date, amount_cents').eq('community_id', community_id).eq('account_last4', ba.account_last4);
    const { data: baOpen } = await supabase.from('bank_accounts').select('opening_position').eq('id', ba.id).maybeSingle();
    const anchor = baOpen && baOpen.opening_position && baOpen.opening_position.gl_anchor;
    const anchorBalance = anchor ? Number(anchor.balance_cents || 0) : 0;
    const bookAt = (ME) => {
      const hasLive = liveLines.some((l) => l.journal_entries.posting_date <= ME);
      if (hasLive) {
        return liveLines.filter((l) => l.journal_entries.posting_date <= ME)
          .reduce((a, l) => a + Number(l.debit_cents) - Number(l.credit_cents), 0);
      }
      const ing = (glcash || []).filter((g) => g.posting_date <= ME).reduce((a, g) => a + Number(g.amount_cents), 0);
      return anchorBalance + ing;
    };

    const { data: payouts } = await supabase.from('bank_rec_payouts')
      .select('trxn_date, payout_date, account_ref, txn_type, amount_cents')
      .eq('community_id', community_id).limit(50000);

    const months = (stmts || [])
      .filter((st) => st.ending_balance_cents != null)
      .map((st) => boundaryReconcile({
        periodEnd: st.statement_period_end,
        bookCents: bookAt(st.statement_period_end),
        bankCents: st.ending_balance_cents,
        payouts: payouts || [],
      }));

    return res.json({ account_last4: ba.account_last4, months });
  } catch (err) {
    console.error('[bank-rec] boundary-summary failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Clearing worksheet — the traditional bank-rec register (GL | Bank columns).
// Every live GL cash line and bank line through period-end; matches pre-populated,
// each Accept/Reopen decision persisted (bank_rec_clearing) and carried forward.
//   GET  /worksheet?community_id=&account_last4=&period_end=
//   POST /worksheet/clear  { community_id, bank_account_id, side, source_id, status, match_group? }
// ---------------------------------------------------------------------------
const WASH_RE = /credit distribution/i;

router.get('/worksheet', async (req, res) => {
  try {
    const community_id = req.query.community_id;
    const period_end = req.query.period_end;
    if (!community_id || !period_end) return res.status(400).json({ error: 'community_id_and_period_end_required' });
    const account_last4 = req.query.account_last4 || null;

    // A community can have several bank accounts — pick the requested one, else
    // default to the operating-cash account (don't error on multiple rows).
    const { data: bas } = await supabase.from('bank_accounts')
      .select('id, account_last4, gl_account_number').eq('community_id', community_id);
    const ba = account_last4
      ? (bas || []).find((a) => a.account_last4 === account_last4)
      : ((bas || []).find((a) => ['1000', '1005', '10100'].includes(String(a.gl_account_number))) || (bas || [])[0]);
    if (!ba) return res.status(404).json({ error: 'bank_account_not_found' });

    const tryNums = [ba.gl_account_number, '1000', '1005', '10100'].filter(Boolean);
    let cashAcctId = null;
    for (const n of tryNums) {
      const { data: a } = await supabase.from('chart_of_accounts').select('id').eq('community_id', community_id).eq('account_number', n).maybeSingle();
      if (a) { cashAcctId = a.id; break; }
    }
    if (!cashAcctId) return res.status(404).json({ error: 'cash_account_not_found' });

    // Live GL cash lines through period-end. The live era starts at the earliest
    // live posting date; the worksheet covers that era (open items carry forward
    // within it). Opening-balance + credit-distribution-wash lines are excluded.
    const { data: glRaw } = await supabase.from('journal_entry_lines')
      .select('id, debit_cents, credit_cents, memo, journal_entries!inner(posting_date, source_module, community_id, status)')
      .eq('account_id', cashAcctId).lte('journal_entries.posting_date', period_end)
      .eq('journal_entries.community_id', community_id).limit(100000);
    const glLive = (glRaw || []).filter((l) => (l.journal_entries.status || 'posted') !== 'voided');

    // Opening anchor + cutover (for the pre-cutover ingested-GL era).
    const { data: baOpen } = await supabase.from('bank_accounts').select('opening_position').eq('id', ba.id).maybeSingle();
    const openPos = (baOpen && baOpen.opening_position) || {};
    const anchor = openPos.gl_anchor || null;
    const anchorBalance = anchor ? Number(anchor.balance_cents || 0) : 0;
    const cutover = openPos.as_of_date || null;

    // Book side by era: live trustEd GL when it exists, else the ingested Vantaca
    // GL cash (bank_rec_gl_cash) on top of the opening anchor — so 2025 months
    // show real book detail to reconcile against instead of "not in GL".
    let glItems, glBalance, eraStart, glBeginAt;
    if (glLive.length) {
      glBalance = glLive.reduce((a, l) => a + Number(l.debit_cents) - Number(l.credit_cents), 0);
      const operational = glLive.filter((l) => l.journal_entries.source_module !== 'opening_entry' && !WASH_RE.test(l.memo || ''));
      eraStart = operational.length ? operational.map((l) => l.journal_entries.posting_date).sort()[0] : period_end.slice(0, 8) + '01';
      glItems = operational.map((l) => {
        const amt = Number(l.debit_cents) - Number(l.credit_cents);
        return { id: l.id, date: l.journal_entries.posting_date, amount_cents: amt,
          description: l.memo || l.journal_entries.description || '',
          check_number: ((l.memo || '').match(/check\s*#?\s*(\d+)/i) || [])[1] || null };
      }).filter((g) => g.amount_cents !== 0);
      glBeginAt = (d) => glLive.filter((l) => l.journal_entries.posting_date < d).reduce((a, l) => a + Number(l.debit_cents) - Number(l.credit_cents), 0);
    } else {
      const { data: glcash } = await supabase.from('bank_rec_gl_cash')
        .select('id, posting_date, description, amount_cents, check_number')
        .eq('community_id', community_id).eq('account_last4', ba.account_last4)
        .lte('posting_date', period_end).order('posting_date').limit(50000);
      glBalance = anchorBalance + (glcash || []).reduce((a, g) => a + Number(g.amount_cents), 0);
      eraStart = cutover || (anchor && anchor.date) || (period_end.slice(0, 8) + '01');
      glItems = (glcash || []).filter((g) => !cutover || g.posting_date > cutover).map((g) => ({
        id: g.id, date: g.posting_date, amount_cents: Number(g.amount_cents),
        description: g.description || '', check_number: g.check_number || ((g.description || '').match(/check\s*#?\s*(\d+)/i) || [])[1] || null,
      })).filter((g) => g.amount_cents !== 0);
      glBeginAt = (d) => anchorBalance + (glcash || []).filter((g) => g.posting_date < d).reduce((a, g) => a + Number(g.amount_cents), 0);
    }

    // Bank lines from era start through period-end. For the ingested (pre-cutover)
    // era the baseline is the cutover (book=bank that day), so start the bank the
    // month AFTER it — exclude the cutover's own statement, whose items are part
    // of the settled opening. The live era starts at its first posting date.
    let stmtQ = supabase.from('bank_statement_imports')
      .select('id, statement_period_end, beginning_balance_cents, ending_balance_cents')
      .eq('bank_account_id', ba.id).lte('statement_period_end', period_end)
      .order('statement_period_end', { ascending: true });
    stmtQ = (glLive.length || !cutover) ? stmtQ.gte('statement_period_end', eraStart) : stmtQ.gt('statement_period_end', cutover);
    const { data: stmts } = await stmtQ;
    const thisStmt = (stmts || []).slice().reverse().find((st) => st.ending_balance_cents != null) || null;
    const bankEnding = thisStmt ? thisStmt.ending_balance_cents : 0;
    const { data: bankRaw } = await supabase.from('bank_statement_transactions')
      .select('id, posting_date, amount_cents, description, check_number, transaction_type')
      .in('bank_statement_import_id', (stmts || []).map((x) => x.id)).limit(20000);
    const bankItems = (bankRaw || []).map((b) => ({ id: b.id, date: b.posting_date,
      amount_cents: Number(b.amount_cents), description: b.description || '', check_number: b.check_number || null,
      transaction_type: b.transaction_type || (b.check_number ? 'check' : (Number(b.amount_cents) >= 0 ? 'deposit' : 'debit')) }));

    // Operator Accept/Reopen overrides (defensive: works before migration 242).
    const overrides = {};
    try {
      const { data: ov } = await supabase.from('bank_rec_clearing')
        .select('side, source_id, status, match_group').eq('community_id', community_id).eq('bank_account_id', ba.id);
      (ov || []).forEach((o) => { overrides[o.side + ':' + o.source_id] = { status: o.status, match_group: o.match_group }; });
    } catch (e) { /* bank_rec_clearing not migrated yet — no overrides */ }

    // Build over the whole era (so carried-forward items match across months),
    // then present THIS month: beginning balances = prior month-end, and only
    // the lines that cleared this month + the still-open carry-forward items.
    const periodStart = period_end.slice(0, 8) + '01';
    const bankBeginning = thisStmt && thisStmt.beginning_balance_cents != null ? thisStmt.beginning_balance_cents : null;
    const glBeginning = glBeginAt(periodStart);

    // Reconcile with the MAIN matcher (the one that ties to $0), then shape it
    // into the worksheet. The lockbox date-batch handles deposits for both eras;
    // we do NOT feed the Vantaca payout key here — on gross 2026 data it fights
    // the date-batching and blows the difference up. Ingested (2025) months carry
    // the opening stake; live (2026) months don't.
    const isLive = glLive.length > 0;
    const glEntries = glItems.map((g) => ({ ref: String(g.id), posting_date: g.date,
      entry_type: g.amount_cents >= 0 ? 'deposit' : 'payment', amount_signed_cents: g.amount_cents,
      description: g.description, check_number: g.check_number }));
    const bankTransactions = bankItems.map((b) => ({ id: b.id, posting_date: b.date,
      amount_cents: b.amount_cents, transaction_type: b.transaction_type, check_number: b.check_number, description: b.description }));
    const result = reconcile({ bankTransactions, checkRegisterChecks: [], glEntries, vantacaPayouts: [],
      openingPosition: isLive ? {} : openPos, bankEndingCents: bankEnding, glEndingCents: glBalance, bookIsComplete: true });
    const full = worksheetFromMatcher(result, { glItems, bankItems, overrides, bankEndingCents: bankEnding, glBalanceCents: glBalance, periodEnd: period_end });
    const inMonth = (d) => d && d >= periodStart && d <= period_end;
    const worksheet = {
      ...full,
      bank_beginning_cents: bankBeginning,
      gl_beginning_cents: glBeginning,
      period_start: periodStart,
      // matched lines that CLEARED this month (a bank line dated in the month)
      matched: full.matched.filter((g) => g.bank.some((b) => inMonth(b.date))),
      // open bank items are only relevant when they hit the bank this month
      open_bank_unrecorded: full.open_bank_unrecorded.filter((b) => inMonth(b.date)),
      // open GL deposits/checks carry forward — keep the cumulative outstanding set
    };
    return res.json({ bank_account_id: ba.id, account_last4: ba.account_last4, era_start: eraStart, worksheet });
  } catch (err) {
    console.error('[bank-rec] worksheet failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/worksheet/clear', express.json(), async (req, res) => {
  try {
    const { community_id, bank_account_id, side, source_id, status, match_group, note } = req.body || {};
    if (!community_id || !bank_account_id || !side || !source_id || !status) return res.status(400).json({ error: 'missing_fields' });
    if (!['gl', 'bank'].includes(side) || !['cleared', 'open'].includes(status)) return res.status(400).json({ error: 'bad_value' });
    const { error } = await supabase.from('bank_rec_clearing')
      .upsert({ community_id, bank_account_id, side, source_id: String(source_id), status, match_group: match_group || null, note: note || null, updated_at: new Date().toISOString() },
        { onConflict: 'bank_account_id,side,source_id' });
    if (error) return res.status(500).json({ error: safeErrorMessage(error) });
    return res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---------------------------------------------------------------------------
// Run the matcher
// ---------------------------------------------------------------------------
router.post('/reconciliations/:id/run-match', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: rec } = await supabase.from('bank_reconciliations')
      .select('*').eq('id', id).maybeSingle();
    if (!rec) return res.status(404).json({ error: 'rec_not_found' });
    if (!rec.bank_statement_import_id) return res.status(400).json({ error: 'bank_statement_required' });

    // Book sources — check register + GL fallback from linked vantaca_imports.
    let checkRegisterChecks = [];
    if (rec.check_register_import_id) {
      const { data: cr } = await supabase.from('vantaca_imports')
        .select('extraction_raw').eq('id', rec.check_register_import_id).maybeSingle();
      checkRegisterChecks = (cr && cr.extraction_raw && cr.extraction_raw.checks) || [];
    }
    let glEntries = [];
    let glEndingCents = rec.gl_ending_balance_cents;
    if (rec.gl_import_id) {
      const { data: gl } = await supabase.from('vantaca_imports')
        .select('extraction_raw').eq('id', rec.gl_import_id).maybeSingle();
      glEntries = (gl && gl.extraction_raw && gl.extraction_raw.entries) || [];
      if (glEndingCents == null) glEndingCents = gl && gl.extraction_raw && gl.extraction_raw.ending_balance_cents;
    }

    const periodEnd = rec.period_end || null;
    const periodStart = rec.period_start || (periodEnd ? periodEnd.slice(0, 8) + '01' : null);

    // Pick the matching account section from each multi-account report by last4.
    let acctLast4 = null;
    if (rec.bank_account_id) {
      const { data: ba } = await supabase.from('bank_accounts').select('account_last4').eq('id', rec.bank_account_id).maybeSingle();
      acctLast4 = ba && ba.account_last4 ? ba.account_last4 : null;
    }
    const pickAccount = (accounts) => {
      if (!accounts || !accounts.length) return null;
      if (acctLast4) { const m = accounts.find((a) => a.account_last4 === acctLast4); if (m) return m; }
      return accounts[0];
    };

    // ------------------------------------------------------------------
    // BOOK SIDE = the GL cash account (Ed: reconcile to the GL, the COMPLETE
    // book — not the registers — "it is the foundation of accounting to
    // reconcile cash"). Two sources, chosen by period:
    //   • post-cutover: trustEd's live journal_entry_lines for the cash account
    //   • pre-cutover : the ingested Vantaca GL cash detail (bank_rec_gl_cash)
    // Operational transactions feed the matcher; the opening / balance-forward
    // entry is kept in the ending balance but not offered as a matchable item.
    // The opening reconciled position ("stake in the ground") clears forward so
    // a community with a decade of history still ties to $0 without a fictional
    // clean baseline. Registers are only the fallback when no GL cash exists.
    // ------------------------------------------------------------------
    let vantacaPayouts = [];
    let coverageStart = null;
    let openingPosition = {};
    let openingForMatch = {};   // stake actually passed to the matcher for THIS period
    let usingGlCash = false;
    let glDepositsAreGross = false; // live GL books owner payments individually (gross)

    // Vantaca's "Credit Distribution" lines hit the cash account on BOTH sides
    // (Dr 1000 / Cr 1000, same property, same day) — an internal credit reclass
    // mis-booked to cash that nets to zero. Not a real cash movement, so it's
    // excluded from the matchable items (keeps the audit trail clean and stops
    // phantom +X/−X pairs from stealing real deposit/payment batches). It nets
    // to zero, so the GL ending balance is unaffected.
    const isCashWash = (memo) => /credit distribution/i.test(String(memo || ''));

    let cashAcctId = null, openingAnchor = null;
    {
      const { data: ba2 } = await supabase.from('bank_accounts')
        .select('gl_account_number, opening_position').eq('id', rec.bank_account_id).maybeSingle();
      openingPosition = (ba2 && ba2.opening_position) || {};
      openingAnchor = openingPosition.gl_anchor || null;
      const tryNums = [ba2 && ba2.gl_account_number, '1000', '1005', '10100'].filter(Boolean);
      for (const n of tryNums) {
        const { data: a } = await supabase.from('chart_of_accounts').select('id')
          .eq('community_id', rec.community_id).eq('account_number', n).maybeSingle();
        if (a) { cashAcctId = a.id; break; }
      }
    }

    // Live trustEd GL cash lines through period end (empty for pre-cutover periods).
    let liveLines = [];
    if (cashAcctId && periodEnd) {
      const { data: ll } = await supabase.from('journal_entry_lines')
        .select('debit_cents, credit_cents, memo, journal_entries!inner(posting_date, description, source_module, community_id, status)')
        .eq('account_id', cashAcctId)
        .lte('journal_entries.posting_date', periodEnd)
        .eq('journal_entries.community_id', rec.community_id)
        .limit(50000);
      liveLines = (ll || []).filter((l) => (l.journal_entries.status || 'posted') !== 'voided');
    }

    if (liveLines.length) {
      usingGlCash = true;
      glEndingCents = liveLines.reduce((s, l) => s + Number(l.debit_cents) - Number(l.credit_cents), 0);
      glEntries = liveLines
        .filter((l) => l.journal_entries.source_module !== 'opening_entry')
        .filter((l) => !isCashWash(l.memo))
        .map((l, i) => {
          const signed = Number(l.debit_cents) - Number(l.credit_cents);
          return {
            ref: 'GLL-' + i,
            posting_date: l.journal_entries.posting_date,
            entry_type: signed > 0 ? 'deposit' : 'payment',
            amount_signed_cents: signed,
            description: l.memo || l.journal_entries.description || '',
            check_number: ((l.memo || '').match(/check\s*#?\s*(\d+)/i) || [])[1] || null,
          };
        })
        .filter((g) => g.amount_signed_cents !== 0);
      // Live era starts at the earliest live posting date. The pre-cutover 2025
      // stake (anchored in Vantaca history) does NOT apply to live-era periods;
      // a live-era opening stake can be set separately when needed.
      const liveDates = liveLines.map((l) => l.journal_entries.posting_date).filter(Boolean).sort();
      coverageStart = liveDates.length ? liveDates[0] : null;
      openingForMatch = {};
      glDepositsAreGross = true;
    } else {
      const { data: glcash } = await supabase.from('bank_rec_gl_cash')
        .select('id, posting_date, ledger_id, description, amount_cents, check_number')
        .eq('community_id', rec.community_id).eq('account_last4', acctLast4)
        .lte('posting_date', periodEnd).order('posting_date').limit(50000);
      if (glcash && glcash.length) {
        usingGlCash = true;
        // Matchable items start at the cutover (stake date); pre-cutover txns are
        // already captured in the anchor balance + opening position, so feeding
        // them here would surface phantom unmatched items whose bank clearings
        // predate our statement coverage.
        const cutover = openingPosition.as_of_date || null;
        glEntries = glcash
          .filter((g) => !cutover || g.posting_date > cutover)
          .filter((g) => !isCashWash(g.description))
          .map((g) => ({
            ref: 'GLC-' + g.id,
            posting_date: g.posting_date,
            entry_type: Number(g.amount_cents) > 0 ? 'deposit' : 'payment',
            amount_signed_cents: Number(g.amount_cents),
            description: g.description || '',
            check_number: g.check_number || ((g.description || '').match(/check\s*#?\s*(\d+)/i) || [])[1] || null,
          }));
        // Ending balance is the FULL cumulative GL cash balance (anchor + every
        // ingested transaction through period end), so it ties to the books.
        const anchorBal = openingAnchor ? Number(openingAnchor.balance_cents || 0) : 0;
        glEndingCents = anchorBal + glcash.reduce((s, g) => s + Number(g.amount_cents), 0);
        coverageStart = cutover || (openingAnchor && openingAnchor.date) || null;
        openingForMatch = openingPosition;
      }
    }

    // Legacy fallback — no GL cash for this community/account yet: reconcile
    // against the registers (deposit register + check register + payouts).
    if (!usingGlCash) {
      const { data: depRows } = await supabase.from('bank_rec_deposits')
        .select('id, deposit_date, description, check_number, amount_cents')
        .eq('community_id', rec.community_id).eq('account_last4', acctLast4)
        .lte('deposit_date', periodEnd).order('deposit_date').limit(20000);
      if (depRows && depRows.length) {
        glEntries = depRows.map((d) => ({ ref: 'DEP-' + d.id, posting_date: d.deposit_date, entry_type: 'deposit', amount_signed_cents: Number(d.amount_cents), description: d.description, check_number: d.check_number }));
        coverageStart = depRows[0].deposit_date;
      }
      const { data: chkRows } = await supabase.from('bank_rec_checks')
        .select('check_number, amount_cents, check_date, payee')
        .eq('community_id', rec.community_id).eq('account_last4', acctLast4)
        .or(`check_date.lte.${periodEnd},check_date.is.null`).limit(20000);
      if (chkRows && chkRows.length) {
        checkRegisterChecks = chkRows.map((c) => ({ check_number: c.check_number, amount_cents: Number(c.amount_cents), issue_date: c.check_date, payee: c.payee, status: 'issued' }));
      }
    }

    // Vantaca Pay payout contents bridge GROSS GL owner-payments to the NET ACH
    // payout the bank receives (payments minus fees/refunds for a payout date).
    // Feed them ONLY when the GL books deposits gross (live trustEd GL) or in the
    // legacy register path. The pre-cutover INGESTED GL already records deposits
    // net (one cash line per Vantaca payout), so they match the bank directly via
    // the lockbox pass — adding payouts there double-claims and breaks the tie.
    if (glDepositsAreGross || !usingGlCash) {
      const { data: payRows } = await supabase.from('bank_rec_payouts')
        .select('trxn_date, payout_date, account_ref, kind, txn_type, amount_cents')
        .eq('community_id', rec.community_id).lte('trxn_date', periodEnd).limit(20000);
      if (payRows && payRows.length) {
        vantacaPayouts = payRows.map((p) => ({ trxn_date: p.trxn_date, payout_date: p.payout_date, account_ref: p.account_ref, kind: p.kind, type: p.txn_type, amount_cents: Number(p.amount_cents) }));
      }
    }

    // Bank side — load ALL of this account's statements from the reports' coverage
    // start through period end, so a deposit/check that cleared on a PRIOR month's
    // statement matches instead of showing as in transit / outstanding. Period-end
    // balance is the latest statement's ending balance.
    let bankEndingCents = rec.bank_ending_balance_cents;
    let bankImportIds = [rec.bank_statement_import_id].filter(Boolean);
    {
      const covStart = coverageStart || periodStart || '1900-01-01';
      if (rec.bank_account_id && periodEnd) {
        const { data: stmts } = await supabase.from('bank_statement_imports')
          .select('id, statement_period_end, ending_balance_cents')
          .eq('bank_account_id', rec.bank_account_id)
          .lte('statement_period_end', periodEnd)
          .gte('statement_period_end', covStart)
          .order('statement_period_end', { ascending: true });
        if (stmts && stmts.length) {
          bankImportIds = stmts.map((st) => st.id);
          const last = stmts[stmts.length - 1];
          if (last && last.ending_balance_cents != null) bankEndingCents = last.ending_balance_cents;
        }
      }
    }
    const { data: bankTx } = await supabase.from('bank_statement_transactions')
      .select('*').in('bank_statement_import_id', bankImportIds).limit(20000);

    const result = reconcile({
      bankTransactions: bankTx || [],
      checkRegisterChecks,
      glEntries,
      vantacaPayouts,
      openingPosition: openingForMatch,
      bankEndingCents,
      glEndingCents,
      // GL cash IS the complete book (live or ingested) → bank items are already
      // booked; don't re-add them to the book side. Same for a trustEd ledger
      // with no legacy Vantaca GL export linked.
      bookIsComplete: usingGlCash || !rec.gl_import_id,
    });

    // Wipe previous items for idempotency
    await supabase.from('bank_reconciliation_items').delete().eq('reconciliation_id', id);

    // Persist items — resolve bank_transaction_idx to real IDs
    const bankTxById = (bankTx || []);
    const rowsToInsert = result.items.map((it, idx) => {
      let bank_transaction_id = null;
      if (it.bank_transaction_idx) {
        const i = parseInt(String(it.bank_transaction_idx).slice(1), 10);
        if (bankTxById[i]) bank_transaction_id = bankTxById[i].id;
      }
      return {
        reconciliation_id: id,
        category: it.category,
        amount_cents: it.amount_cents,
        date_ref: it.date_ref || null,
        description: it.description || null,
        check_number: it.check_number || null,
        bank_transaction_id,
        check_register_ref: it.check_register_ref || null,
        gl_ref: it.gl_ref || null,
        match_confidence: it.match_confidence || null,
        match_method: it.match_method || null,
      };
    });
    if (rowsToInsert.length > 0) {
      const { error: itemsErr } = await supabase.from('bank_reconciliation_items').insert(rowsToInsert);
      if (itemsErr) console.warn('[bank-rec] items insert failed:', itemsErr.message);
    }

    // Update the rec summary
    const { error: upErr } = await supabase.from('bank_reconciliations').update({
      bank_ending_balance_cents: result.summary.bank_ending_balance_cents,
      gl_ending_balance_cents: result.summary.gl_ending_balance_cents,
      outstanding_checks_total_cents: result.summary.outstanding_checks_total_cents,
      deposits_in_transit_total_cents: result.summary.deposits_in_transit_total_cents,
      bank_only_adjustments_cents: result.summary.bank_only_adjustments_cents,
      gl_only_adjustments_cents: result.summary.gl_only_adjustments_cents,
      reconciled_balance_cents: result.summary.reconciled_balance_cents,
      difference_cents: result.summary.difference_cents,
      status: result.summary.balanced ? 'reconciled' : 'unbalanced',
      prepared_at: new Date().toISOString(),
    }).eq('id', id);
    if (upErr) throw upErr;

    res.json({ summary: result.summary, items_count: rowsToInsert.length });
  } catch (err) {
    console.error('[bank-rec] run-match failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Recompute a rec's summary from its current items (after an operator clears /
// adjusts one). Mirrors the matcher's summary formula so a manual change updates
// the difference + status without re-running the whole match.
async function recomputeRecSummary(recId) {
  const { data: rec } = await supabase.from('bank_reconciliations')
    .select('bank_ending_balance_cents, gl_ending_balance_cents, gl_import_id').eq('id', recId).maybeSingle();
  if (!rec) return null;
  const { data: items } = await supabase.from('bank_reconciliation_items')
    .select('category, amount_cents').eq('reconciliation_id', recId).limit(5000);
  const sum = (cat) => (items || []).filter((i) => i.category === cat).reduce((a, i) => a + Number(i.amount_cents || 0), 0);
  const outstanding = sum('outstanding_check');
  const dit = sum('deposit_in_transit');
  const bankOnly = sum('bank_only');
  const glOnly = sum('gl_only');
  const bookIsComplete = !rec.gl_import_id;
  const reconciled = Number(rec.bank_ending_balance_cents || 0) + outstanding + dit;
  const adjustedGl = Number(rec.gl_ending_balance_cents || 0) + (bookIsComplete ? 0 : bankOnly);
  const difference = reconciled - adjustedGl;
  const balanced = Math.abs(difference) <= 1;
  await supabase.from('bank_reconciliations').update({
    outstanding_checks_total_cents: outstanding,
    deposits_in_transit_total_cents: dit,
    bank_only_adjustments_cents: bankOnly,
    gl_only_adjustments_cents: glOnly,
    reconciled_balance_cents: reconciled,
    difference_cents: difference,
    status: balanced ? 'reconciled' : 'unbalanced',
  }).eq('id', recId);
  return { difference_cents: difference, balanced };
}

router.patch('/reconciliations/:id/items/:itemId', express.json(), async (req, res) => {
  try {
    const { id, itemId } = req.params;
    // action:'clear' marks an exception item reconciled (category → matched);
    // otherwise an explicit field patch (category / amount_cents / notes).
    const patch = {};
    if ((req.body || {}).action === 'clear') {
      patch.category = 'matched';
    } else {
      const allowed = ['category', 'operator_notes', 'amount_cents'];
      for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    }
    patch.match_confidence = 'manual';
    patch.match_method = 'manual';
    patch.reviewed_at = new Date().toISOString();
    const { data, error } = await supabase.from('bank_reconciliation_items')
      .update(patch).eq('id', itemId).select('*').single();
    if (error) throw error;
    const summary = await recomputeRecSummary(data.reconciliation_id || id);
    res.json({ item: data, summary });
  } catch (err) {
    console.error('[bank-rec] update item failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ---------------------------------------------------------------------------
// Cheat sheet — printable HTML for fast Vantaca data entry
// ---------------------------------------------------------------------------
router.get('/reconciliations/:id/cheat-sheet', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: rec }, { data: items }] = await Promise.all([
      supabase.from('bank_reconciliations')
        .select('*, communities(name), bank_accounts(account_nickname, bank_name, account_last4)')
        .eq('id', id).maybeSingle(),
      supabase.from('bank_reconciliation_items')
        .select('*').eq('reconciliation_id', id)
        .order('category').order('check_number', { nullsFirst: false }).order('date_ref'),
    ]);
    if (!rec) return res.status(404).send('Not found');
    res.json({ reconciliation: rec, items: items || [] });
  } catch (err) {
    console.error('[bank-rec] cheat sheet failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = { router };
