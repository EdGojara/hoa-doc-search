// ============================================================================
// api/vault.js  (Ed 2026-08-14)
// ----------------------------------------------------------------------------
// The OWNER'S PRIVATE accounting vault — Bedrock (S-corp) + Ed's other
// companies, reconstructed for the audit and kept going forward.
//
// LOCK: every route is gated by requireOwner (Ed's login specifically — not
// merely "an admin"). A router-level gate runs FIRST so no endpoint can ever
// ship ungated by accident. Nothing here is exposed to staff, portals, or any
// AI/search index. See migration 365.
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireOwner } = require('./_require_admin');
const { safeErrorMessage } = require('./_safe_error');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const router = express.Router();

router.use(express.json({ limit: '512kb' }));

// The seal: EVERY vault request must be the owner. requireOwner sends a 403 for
// anyone else (including a future second admin). We also log every entry.
router.use(async (req, res, next) => {
  const owner = await requireOwner(req, res); // sends 403 if not Ed
  if (!owner) return;
  req.owner = owner;
  try { await supabase.from('vault_access_log').insert({ user_email: owner.email, action: `${req.method} ${req.path}` }); } catch (_) { /* log is best-effort */ }
  next();
});

// GET /whoami — proves the lock. Returns the owner; everyone else already got 403.
router.get('/whoami', (req, res) => res.json({ ok: true, owner: { email: req.owner.email, name: req.owner.full_name } }));

// ---- Entities (the companies) ---------------------------------------------
router.get('/entities', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vault_entities').select('*').order('name');
    if (error) throw error;
    res.json({ entities: data || [] });
  } catch (err) { console.error('[vault] entities list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

const ENTITY_TYPES = ['s_corp', 'c_corp', 'llc', 'partnership', 'sole_prop', 'individual'];
router.post('/entities', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const entity_type = ENTITY_TYPES.includes(b.entity_type) ? b.entity_type : 's_corp';
    const row = {
      name, entity_type,
      ein: (b.ein || '').trim() || null,
      fiscal_year_end: /^\d{2}-\d{2}$/.test(b.fiscal_year_end || '') ? b.fiscal_year_end : '12-31',
      notes: (b.notes || '').trim() || null,
    };
    const { data, error } = await supabase.from('vault_entities').insert(row).select('*').single();
    if (error) throw error;
    res.json({ entity: data });
  } catch (err) { console.error('[vault] entity create failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch('/entities/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.name != null) patch.name = String(b.name).trim();
    if (b.entity_type && ENTITY_TYPES.includes(b.entity_type)) patch.entity_type = b.entity_type;
    if (b.ein != null) patch.ein = String(b.ein).trim() || null;
    if (b.fiscal_year_end && /^\d{2}-\d{2}$/.test(b.fiscal_year_end)) patch.fiscal_year_end = b.fiscal_year_end;
    if (b.notes != null) patch.notes = String(b.notes).trim() || null;
    if (b.is_active != null) patch.is_active = b.is_active !== false;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from('vault_entities').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { console.error('[vault] entity update failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Chart of accounts (per entity) ---------------------------------------
router.get('/entities/:id/accounts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vault_accounts').select('*').eq('entity_id', req.params.id).order('account_number');
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) { console.error('[vault] accounts list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
router.post('/entities/:id/accounts', async (req, res) => {
  try {
    const b = req.body || {};
    const account_number = String(b.account_number || '').trim();
    const account_name = String(b.account_name || '').trim();
    if (!account_number || !account_name) return res.status(400).json({ error: 'account_number_and_name_required' });
    if (!ACCOUNT_TYPES.includes(b.account_type)) return res.status(400).json({ error: 'invalid_account_type', allowed: ACCOUNT_TYPES });
    const normal_balance = ['asset', 'expense'].includes(b.account_type) ? 'debit' : 'credit';
    const row = { entity_id: req.params.id, account_number, account_name, account_type: b.account_type, normal_balance };
    const { data, error } = await supabase.from('vault_accounts').insert(row).select('*').single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return res.status(409).json({ error: 'account_number_exists' });
      throw error;
    }
    res.json({ account: data });
  } catch (err) { console.error('[vault] account create failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// ---- Bank + credit-card accounts (per entity) -----------------------------
router.get('/entities/:id/bank-accounts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('vault_bank_accounts').select('*').eq('entity_id', req.params.id).order('name');
    if (error) throw error;
    res.json({ bank_accounts: data || [] });
  } catch (err) { console.error('[vault] bank accts failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});
const BANK_KINDS = ['checking', 'savings', 'credit_card', 'loan', 'other'];
router.post('/entities/:id/bank-accounts', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const row = {
      entity_id: req.params.id, name,
      kind: BANK_KINDS.includes(b.kind) ? b.kind : 'checking',
      institution: (b.institution || '').trim() || null,
      last4: (b.last4 || '').replace(/\D/g, '').slice(-4) || null,
    };
    const { data, error } = await supabase.from('vault_bank_accounts').insert(row).select('*').single();
    if (error) throw error;
    res.json({ bank_account: data });
  } catch (err) { console.error('[vault] bank acct create failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Standard chart of accounts (one-click seed for a service S-corp) ------
const STANDARD_COA = [
  ['1000', 'Operating Cash', 'asset'], ['1010', 'Savings', 'asset'], ['1200', 'Accounts Receivable', 'asset'], ['1500', 'Fixed Assets', 'asset'], ['1510', 'Accumulated Depreciation', 'asset'],
  ['2000', 'Accounts Payable', 'liability'], ['2100', 'Credit Card Payable', 'liability'], ['2200', 'Payroll Liabilities', 'liability'], ['2400', 'Loans Payable', 'liability'],
  ['3000', 'Capital Stock', 'equity'], ['3100', 'Retained Earnings', 'equity'], ['3200', 'Shareholder Distributions', 'equity'], ['3300', 'Shareholder Contributions', 'equity'],
  ['4000', 'Management Fee Revenue', 'revenue'], ['4100', 'Other Income', 'revenue'],
  ['5000', 'Wages & Salaries', 'expense'], ['5010', 'Payroll Taxes', 'expense'], ['5020', 'Employee Benefits', 'expense'],
  ['5100', 'Rent', 'expense'], ['5200', 'Software & Subscriptions', 'expense'], ['5300', 'Office & Supplies', 'expense'],
  ['5400', 'Legal & Professional Fees', 'expense'], ['5410', 'Accounting Fees', 'expense'], ['5500', 'Insurance', 'expense'],
  ['5600', 'Meals', 'expense'], ['5700', 'Travel', 'expense'], ['5800', 'Bank & Merchant Fees', 'expense'],
  ['5900', 'Utilities & Telephone', 'expense'], ['6000', 'Advertising & Marketing', 'expense'], ['6100', 'Contract Labor', 'expense'],
  ['6200', 'Dues & Licenses', 'expense'], ['6300', 'Repairs & Maintenance', 'expense'], ['6900', 'Other Expense', 'expense'],
];
router.post('/entities/:id/seed-accounts', async (req, res) => {
  try {
    const { data: existing } = await supabase.from('vault_accounts').select('account_number').eq('entity_id', req.params.id);
    const have = new Set((existing || []).map((a) => a.account_number));
    const rows = STANDARD_COA.filter(([num]) => !have.has(num)).map(([account_number, account_name, account_type]) => ({
      entity_id: req.params.id, account_number, account_name, account_type,
      normal_balance: ['asset', 'expense'].includes(account_type) ? 'debit' : 'credit',
    }));
    if (rows.length) { const { error } = await supabase.from('vault_accounts').insert(rows); if (error) throw error; }
    res.json({ ok: true, added: rows.length });
  } catch (err) { console.error('[vault] seed accounts failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Statement import: PDF → extracted transactions (the engine) ----------
router.post('/entities/:id/import-statement', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const entity_id = req.params.id;
    const bank_account_id = req.body && req.body.bank_account_id ? req.body.bank_account_id : null;
    const { extractStatement } = require('../lib/vault/statement_extract');
    const ex = await extractStatement(req.file.buffer);

    // Store the source PDF in a PRIVATE owner-vault path (never the shared docs
    // surface, never indexed). Retrieved only via owner-gated signed URLs.
    const path = `owner-vault/${entity_id}/statements/${Date.now()}-${(req.file.originalname || 'statement.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}`;
    // If the source PDF didn't land, record NO path rather than one that points
    // at nothing — an audit workspace must never claim it kept the source.
    let stored = null;
    try {
      const { error: upErr } = await supabase.storage.from('documents')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype || 'application/pdf', upsert: false });
      if (upErr) throw upErr;
      stored = path;
    } catch (e) { console.warn('[vault] statement store failed:', e.message); }

    const { data: imp, error: impErr } = await supabase.from('vault_statement_imports').insert({
      entity_id, bank_account_id, filename: req.file.originalname || null, storage_path: stored,
      period_start: ex.period_start, period_end: ex.period_end,
      opening_balance_cents: ex.opening_balance_cents, closing_balance_cents: ex.closing_balance_cents,
      extracted_count: ex.transactions.length, status: 'extracted',
    }).select('id').single();
    if (impErr) throw impErr;

    const source = ex.statement_kind === 'credit_card' ? 'credit_card' : 'bank';
    const txnRows = ex.transactions.map((t) => ({
      entity_id, bank_account_id, statement_import_id: imp.id,
      txn_date: t.date, description: t.description, amount_cents: t.amount_cents,
      source, needs_review: true,
    }));
    if (txnRows.length) { const { error: tErr } = await supabase.from('vault_transactions').insert(txnRows); if (tErr) throw tErr; }

    res.json({
      ok: true, import_id: imp.id, count: txnRows.length,
      period: [ex.period_start, ex.period_end], institution: ex.institution, account_last4: ex.account_last4,
      reconciles: ex.reconciles, off_by_cents: ex.off_by_cents,
      opening_balance_cents: ex.opening_balance_cents, closing_balance_cents: ex.closing_balance_cents,
    });
  } catch (err) { console.error('[vault] import failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Ledger: list + categorize transactions -------------------------------
router.get('/entities/:id/transactions', async (req, res) => {
  try {
    const { fetchAllQuery } = require('../lib/db/fetch_all');
    let rows = await fetchAllQuery(() => {
      let q = supabase.from('vault_transactions').select('*').eq('entity_id', req.params.id);
      if (req.query.needs_review === '1') q = q.eq('needs_review', true);
      if (req.query.bank_account_id) q = q.eq('bank_account_id', req.query.bank_account_id);
      return q;
    }, { orderBy: 'txn_date' });
    res.json({ transactions: rows || [] });
  } catch (err) { console.error('[vault] txns failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});
router.patch('/transactions/:txnId', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.category_account_id !== undefined) { patch.category_account_id = b.category_account_id || null; patch.needs_review = false; }
    if (b.memo !== undefined) patch.memo = (b.memo || '').trim() || null;
    if (b.description !== undefined) patch.description = (b.description || '').trim() || null;
    if (b.needs_review !== undefined) patch.needs_review = !!b.needs_review;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { error } = await supabase.from('vault_transactions').update(patch).eq('id', req.params.txnId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { console.error('[vault] txn update failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
