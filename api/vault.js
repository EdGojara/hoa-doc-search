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
const crypto = require('crypto');
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

// ---- Receipts: photo -> extract -> support a card charge ------------------
// Suggest the card charges a receipt most likely supports: same entity, amount
// matches (a card charge is stored NEGATIVE, the receipt total is POSITIVE),
// dated near the receipt. Never auto-links; it only ranks candidates.
async function suggestMatches(receipt) {
  if (!receipt || receipt.total_cents == null) return [];
  const total = Math.abs(Number(receipt.total_cents));
  const base = receipt.receipt_date ? new Date(receipt.receipt_date + 'T00:00:00Z').getTime() : Date.now();
  const lo = new Date(base - 21 * 86400000).toISOString().slice(0, 10);
  const hi = new Date(base + 21 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('vault_transactions')
    .select('id, txn_date, description, amount_cents, source, reconciled, bank_account_id')
    .eq('entity_id', receipt.entity_id)
    .gte('txn_date', lo).lte('txn_date', hi)
    .limit(500);
  return (data || [])
    .map((t) => {
      const amtDiff = Math.abs(Math.abs(Number(t.amount_cents)) - total);
      const dayDiff = receipt.receipt_date ? Math.abs((new Date(t.txn_date).getTime() - base) / 86400000) : 0;
      return { ...t, amt_diff_cents: amtDiff, day_diff: Math.round(dayDiff) };
    })
    .filter((t) => t.amt_diff_cents <= 200)          // within $2
    .sort((a, b) => (a.amt_diff_cents - b.amt_diff_cents) || (a.day_diff - b.day_diff))
    .slice(0, 6);
}

// POST /entities/:id/receipts — upload a receipt photo, extract, store as support.
router.post('/entities/:id/receipts', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file_required' });
    const entity_id = req.params.id;
    const bank_account_id = (req.body && req.body.bank_account_id) || null;
    const { extractReceipt } = require('../lib/vault/receipt_extract');
    const ex = await extractReceipt(req.file.buffer, req.file.mimetype);

    const safe = (req.file.originalname || 'receipt.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const path = `owner-vault/${entity_id}/receipts/${Date.now()}-${safe}`;
    let stored = null;
    try {
      const { error: upErr } = await supabase.storage.from('documents')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype || 'image/jpeg', upsert: false });
      if (upErr) throw upErr;
      stored = path;
    } catch (e) { console.warn('[vault] receipt store failed:', e.message); }
    if (!stored) return res.status(500).json({ error: 'could_not_store_image' });

    const e = ex.extracted || {};
    const { data: row, error } = await supabase.from('vault_receipts').insert({
      entity_id, bank_account_id, storage_path: stored, content_type: req.file.mimetype || 'image/jpeg',
      vendor_name: e.vendor_name || null, receipt_date: e.receipt_date || null,
      total_cents: e.total_cents == null ? null : e.total_cents, tax_cents: e.tax_cents == null ? null : e.tax_cents,
      currency: e.currency || 'USD', card_last4: e.card_last4 || null,
      notes: e.category_guess ? ('Category guess: ' + e.category_guess) : null,
      status: 'unmatched', raw_extracted: ex.raw ? { raw: ex.raw, extracted: e } : null,
      created_by: req.owner.email,
    }).select('*').single();
    if (error) throw error;

    const suggestions = await suggestMatches(row).catch(() => []);
    res.json({ ok: true, receipt: row, extract_ok: ex.ok, extract_error: ex.error || null, suggestions });
  } catch (err) { console.error('[vault] receipt upload failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /entities/:id/receipts — list, newest first, with a short-lived image URL.
router.get('/entities/:id/receipts', async (req, res) => {
  try {
    let q = supabase.from('vault_receipts').select('*').eq('entity_id', req.params.id).order('created_at', { ascending: false }).limit(1000);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    const rows = await Promise.all((data || []).map(async (r) => {
      let image_url = null;
      try { const { data: s } = await supabase.storage.from('documents').createSignedUrl(r.storage_path, 3600); image_url = s && s.signedUrl; } catch (_) {}
      return { ...r, image_url };
    }));
    res.json({ receipts: rows });
  } catch (err) { console.error('[vault] receipts list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /receipts/:receiptId/suggest — candidate card charges to match.
router.get('/receipts/:receiptId/suggest', async (req, res) => {
  try {
    const { data: r } = await supabase.from('vault_receipts').select('*').eq('id', req.params.receiptId).maybeSingle();
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ suggestions: await suggestMatches(r) });
  } catch (err) { console.error('[vault] suggest failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /receipts/:receiptId — correct the extracted fields.
router.patch('/receipts/:receiptId', async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = ['vendor_name', 'receipt_date', 'total_cents', 'tax_cents', 'currency', 'category_account_id', 'card_last4', 'notes', 'bank_account_id', 'status'];
    const patch = {};
    for (const f of allowed) if (b[f] !== undefined) patch[f] = b[f] === '' ? null : b[f];
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('vault_receipts').update(patch).eq('id', req.params.receiptId).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, receipt: data });
  } catch (err) { console.error('[vault] receipt patch failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /receipts/:receiptId/match — tie a receipt to its card charge, and
// reconcile that charge (and inherit the receipt's GL category if the charge
// has none).
router.post('/receipts/:receiptId/match', async (req, res) => {
  try {
    const transaction_id = req.body && req.body.transaction_id;
    if (!transaction_id) return res.status(400).json({ error: 'transaction_id_required' });
    const { data: r } = await supabase.from('vault_receipts').select('*').eq('id', req.params.receiptId).maybeSingle();
    if (!r) return res.status(404).json({ error: 'receipt_not_found' });
    const { data: t } = await supabase.from('vault_transactions').select('id, category_account_id').eq('id', transaction_id).maybeSingle();
    if (!t) return res.status(404).json({ error: 'transaction_not_found' });

    const { error: rErr } = await supabase.from('vault_receipts')
      .update({ matched_transaction_id: transaction_id, status: 'matched' }).eq('id', r.id);
    if (rErr) throw rErr;
    const txnPatch = { reconciled: true, needs_review: false };
    if (!t.category_account_id && r.category_account_id) txnPatch.category_account_id = r.category_account_id;
    await supabase.from('vault_transactions').update(txnPatch).eq('id', transaction_id);
    res.json({ ok: true });
  } catch (err) { console.error('[vault] receipt match failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /receipts/:receiptId/unmatch — undo the link (leaves the charge as-is).
router.post('/receipts/:receiptId/unmatch', async (req, res) => {
  try {
    const { error } = await supabase.from('vault_receipts')
      .update({ matched_transaction_id: null, status: 'unmatched' }).eq('id', req.params.receiptId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { console.error('[vault] receipt unmatch failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// DELETE /receipts/:receiptId — remove the image + row.
router.delete('/receipts/:receiptId', async (req, res) => {
  try {
    const { data: r } = await supabase.from('vault_receipts').select('storage_path').eq('id', req.params.receiptId).maybeSingle();
    if (r && r.storage_path) { try { await supabase.storage.from('documents').remove([r.storage_path]); } catch (_) {} }
    await supabase.from('vault_receipts').delete().eq('id', req.params.receiptId);
    res.json({ ok: true });
  } catch (err) { console.error('[vault] receipt delete failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ---- Documents: each company's own records (migration 550) ----------------
// Leases, city letters, tax and IRS notices, insurance, contracts. Stored with
// their exact bytes in the private bucket under owner-vault/<entity>/documents/,
// never in library_documents, never indexed. Archived, never deleted.
const DOCS = require('../lib/vault/documents');

// GET /document-categories — the list the page shows.
router.get('/document-categories', (req, res) => res.json({ categories: DOCS.CATEGORIES }));

// GET /entities/:id/documents — newest first. ?archived=1 lists the archive.
router.get('/entities/:id/documents', async (req, res) => {
  try {
    let q = supabase.from('vault_documents')
      .select('id, entity_id, category, title, filename, original_filename, document_date, tax_year, notes, content_type, size_bytes, sha256, archived_at, created_by, created_at, updated_at')
      .eq('entity_id', req.params.id);
    q = req.query.archived === '1' ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
    const { data, error } = await q.order('document_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(2000);
    if (error) throw error;
    res.json({ documents: data || [], capped: (data || []).length === 2000 });
  } catch (err) { console.error('[vault] documents list failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// POST /entities/:id/documents — file one document. Fields: file, title,
// category, document_date, tax_year, notes, filename (the filed name; suggested
// from the convention when blank). The same file twice for a company -> 409
// with the copy already filed.
router.post('/entities/:id/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'file_required' });
    const entity_id = req.params.id;
    const { data: ent, error: entErr } = await supabase.from('vault_entities').select('id, name').eq('id', entity_id).maybeSingle();
    if (entErr) throw entErr;
    if (!ent) return res.status(404).json({ error: 'entity_not_found' });

    const b = req.body || {};
    const original = String(req.file.originalname || 'document').slice(0, 200);
    const v = DOCS.validateFields({ ...b, title: b.title || original.replace(/\.[A-Za-z0-9]{1,8}$/, '') });
    if (v.error) return res.status(400).json({ error: v.error });
    const f = v.fields;
    const filename = DOCS.cleanFiledName(b.filename, original)
      || DOCS.suggestFiledName({ entityName: ent.name, title: f.title, documentDate: f.document_date, taxYear: f.tax_year, originalFilename: original });

    const sha256 = DOCS.sha256Hex(req.file.buffer);
    const { data: dup, error: dupErr } = await supabase.from('vault_documents')
      .select('id, title, filename, archived_at, created_at').eq('entity_id', entity_id).eq('sha256', sha256).maybeSingle();
    if (dupErr) throw dupErr;
    if (dup) return res.status(409).json({ error: 'already_filed', document: dup });

    const path = `owner-vault/${entity_id}/documents/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)}`;
    const content_type = req.file.mimetype || 'application/octet-stream';
    const { error: upErr } = await supabase.storage.from('documents').upload(path, req.file.buffer, { contentType: content_type, upsert: false });
    if (upErr) { console.error('[vault] document store failed:', upErr.message, { entity_id, filename }); return res.status(500).json({ error: 'could_not_store_file' }); }

    const { data: row, error } = await supabase.from('vault_documents').insert({
      entity_id, ...f, filename, original_filename: original, storage_path: path, content_type,
      size_bytes: req.file.buffer.length, sha256, created_by: req.owner.email,
    }).select('*').single();
    if (error) {
      // The file landed but the record did not: take the file back out so
      // storage never holds a document the Vault cannot see.
      console.error('[vault] document record failed, removing stored file:', error.message, { entity_id, path });
      try { await supabase.storage.from('documents').remove([path]); } catch (e) { console.warn('[vault] orphan document file left at', path, e.message); }
      if (/duplicate|unique/i.test(error.message)) return res.status(409).json({ error: 'already_filed' });
      throw error;
    }
    res.json({ ok: true, document: row });
  } catch (err) { console.error('[vault] document upload failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// GET /documents/:docId/open — a five-minute link to the exact stored bytes,
// downloading under the filed name.
router.get('/documents/:docId/open', async (req, res) => {
  try {
    const { data: d, error } = await supabase.from('vault_documents').select('storage_path, filename').eq('id', req.params.docId).maybeSingle();
    if (error) throw error;
    if (!d) return res.status(404).json({ error: 'not_found' });
    const download = req.query.download === '1' ? { download: d.filename } : {};
    const { data: s, error: sErr } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 300, download);
    if (sErr || !s || !s.signedUrl) { console.error('[vault] document link failed:', sErr && sErr.message, { id: req.params.docId }); return res.status(500).json({ error: 'could_not_open_file' }); }
    res.json({ url: s.signedUrl });
  } catch (err) { console.error('[vault] document open failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

// PATCH /documents/:docId — correct the details, rename, archive / restore.
// The stored bytes never change.
router.patch('/documents/:docId', async (req, res) => {
  try {
    const b = req.body || {};
    const v = DOCS.validateFields(b, { partial: true });
    if (v.error) return res.status(400).json({ error: v.error });
    const patch = { ...v.fields };
    if (b.filename !== undefined) {
      const { data: cur, error: cErr } = await supabase.from('vault_documents').select('original_filename').eq('id', req.params.docId).maybeSingle();
      if (cErr) throw cErr;
      if (!cur) return res.status(404).json({ error: 'not_found' });
      const n = DOCS.cleanFiledName(b.filename, cur.original_filename);
      if (!n) return res.status(400).json({ error: 'filename_required' });
      patch.filename = n;
    }
    if (b.archived !== undefined) patch.archived_at = b.archived ? new Date().toISOString() : null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabase.from('vault_documents').update(patch).eq('id', req.params.docId).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, document: data });
  } catch (err) { console.error('[vault] document update failed:', err.message); res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = { router };
