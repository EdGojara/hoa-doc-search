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
const { reconcile } = require('../lib/banking/matcher');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

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
      .select('*, communities(name, slug), bank_accounts(account_nickname, bank_name)')
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
// Run the matcher
// ---------------------------------------------------------------------------
router.post('/reconciliations/:id/run-match', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: rec } = await supabase.from('bank_reconciliations')
      .select('*').eq('id', id).maybeSingle();
    if (!rec) return res.status(404).json({ error: 'rec_not_found' });
    if (!rec.bank_statement_import_id) return res.status(400).json({ error: 'bank_statement_required' });

    // Load bank transactions
    const { data: bankTx } = await supabase.from('bank_statement_transactions')
      .select('*')
      .eq('bank_statement_import_id', rec.bank_statement_import_id)
      .limit(5000);

    // Load check register checks from vantaca_imports.extraction_raw
    let checkRegisterChecks = [];
    if (rec.check_register_import_id) {
      const { data: cr } = await supabase.from('vantaca_imports')
        .select('extraction_raw').eq('id', rec.check_register_import_id).maybeSingle();
      checkRegisterChecks = cr?.extraction_raw?.checks || [];
    }

    // Load GL entries
    let glEntries = [];
    let glEndingCents = rec.gl_ending_balance_cents;
    if (rec.gl_import_id) {
      const { data: gl } = await supabase.from('vantaca_imports')
        .select('extraction_raw').eq('id', rec.gl_import_id).maybeSingle();
      glEntries = gl?.extraction_raw?.entries || [];
      if (glEndingCents == null) glEndingCents = gl?.extraction_raw?.ending_balance_cents;
    }

    const result = reconcile({
      bankTransactions: bankTx || [],
      checkRegisterChecks,
      glEntries,
      bankEndingCents: rec.bank_ending_balance_cents,
      glEndingCents,
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

router.patch('/reconciliations/:id/items/:itemId', express.json(), async (req, res) => {
  try {
    const { itemId } = req.params;
    const allowed = ['category', 'operator_notes', 'amount_cents'];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    patch.match_confidence = 'manual';
    patch.match_method = 'manual';
    patch.reviewed_at = new Date().toISOString();
    const { data, error } = await supabase.from('bank_reconciliation_items')
      .update(patch).eq('id', itemId).select('*').single();
    if (error) throw error;
    res.json({ item: data });
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
