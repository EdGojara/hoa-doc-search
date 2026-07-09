// ============================================================================
// Check printing API — mounted at /api/checks (staff-only).
//   GET  /payable?community_id
//   GET  /accounts/:bankAccountId/config          setup read (account masked)
//   PUT  /accounts/:bankAccountId/config          setup write
//   POST /run                                      create a check run
//   GET  /run/:printRunId/pdf                      rendered checks PDF
//   GET  /register?community_id&bank_account_id    the check register
//   POST /void                                     void a check (append-only)
// ============================================================================
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { safeErrorMessage } = require('./_safe_error');
const {
  listPayableInvoices, createCheckRun, getRunForRender, voidCheck,
  getBankCheckConfig, updateBankCheckConfig,
} = require('../lib/accounting/check_run');
const { renderChecksPDF, micrFontInstalled } = require('../lib/accounting/check_renderer');
const { requireAdmin } = require('./_require_admin');
const { encryptField, last4 } = require('../lib/crypto_field');
const multer = require('multer');
const crypto = require('crypto');
const { extract: extractBankStatement } = require('../lib/banking/extractors/bank_statement');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const stmtUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

function handleErr(res, feature, err) {
  if (err.code === 'invalid_input' || err.code === 'invalid_state') {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  console.error(`[checks] ${feature} failed:`, err.message);
  return res.status(500).json({ error: safeErrorMessage(err) });
}

router.get('/payable', async (req, res) => {
  try {
    const invoices = await listPayableInvoices({ community_id: req.query.community_id });
    res.json({ invoices });
  } catch (err) { handleErr(res, 'payable', err); }
});

// GET /statement-tracker — live "which monthly bank statements are still needed"
// across every account, straight from bank_statement_imports. Staff-accessible
// (behind the global staff cookie, like the rest of /api/checks). Updates itself
// as statements are imported. Month range = earliest statement (or Sep 2025)
// through the last fully-closed month.
router.get('/statement-tracker', async (req, res) => {
  try {
    const { data: accts, error: aErr } = await supabase.from('bank_accounts')
      .select('id, account_nickname, account_type, is_check_disbursement, community_id, community:community_id(name), bank:bank_id(name)')
      .order('community_id');
    if (aErr) throw aErr;
    const { data: imps, error: iErr } = await supabase.from('bank_statement_imports')
      .select('bank_account_id, statement_period_end, status').neq('status', 'voided');
    if (iErr) throw iErr;

    const ym = (d) => (d ? String(d).slice(0, 7) : null); // 'YYYY-MM'
    const uploadedBy = {};
    let minMonth = '2025-09';
    for (const im of imps || []) {
      if (!im.bank_account_id || im.status !== 'completed') continue;
      const m = ym(im.statement_period_end);
      if (!m) continue;
      (uploadedBy[im.bank_account_id] = uploadedBy[im.bank_account_id] || new Set()).add(m);
      if (m < minMonth) minMonth = m;
    }

    // Month list: minMonth .. the last fully-closed month (previous calendar
    // month). getUTCMonth() is 0-based, which conveniently equals the 1-based
    // number of the *previous* month (July=6 -> June=6); wrap January to Dec.
    const now = new Date();
    let ey = now.getUTCFullYear();
    let em = now.getUTCMonth();
    if (em === 0) { em = 12; ey -= 1; }
    const MN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const months = [];
    let [sy, sm] = minMonth.split('-').map(Number);
    while (sy < ey || (sy === ey && sm <= em)) {
      months.push({ key: `${sy}-${String(sm).padStart(2, '0')}`, label: MN[sm], yr: `'${String(sy).slice(2)}` });
      sm += 1; if (sm > 12) { sm = 1; sy += 1; }
    }

    const commMap = {};
    for (const a of accts || []) {
      const cn = a.community ? a.community.name : '—';
      (commMap[cn] = commMap[cn] || []).push({
        id: a.id, nickname: a.account_nickname, bank: a.bank ? a.bank.name : null,
        type: a.account_type, is_check: !!a.is_check_disbursement,
        uploaded: [...(uploadedBy[a.id] || [])],
      });
    }
    const communities = Object.entries(commMap).map(([name, accounts]) => ({ name, accounts }));

    res.json({ months, communities });
  } catch (err) { handleErr(res, 'statement-tracker', err); }
});

// POST /statement-tracker/upload — one-click statement upload straight from the
// tracker grid. Staff pick the account's cell and drop a PDF; the statement's own
// dates place it in the right month. No back-and-forth to the rec screen.
// Body: multipart 'file' + bank_account_id (+ optional month YYYY-MM hint).
router.post('/statement-tracker/upload', stmtUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Pick a PDF to upload.' });
    const bankAccountId = req.body && req.body.bank_account_id;
    if (!bankAccountId) return res.status(400).json({ error: 'bank_account_id required.' });
    const { data: ba } = await supabase.from('bank_accounts').select('id, community_id, account_nickname').eq('id', bankAccountId).maybeSingle();
    if (!ba) return res.status(404).json({ error: 'account_not_found' });

    // Read the statement (period + balances + transactions).
    let ex;
    try { ex = await extractBankStatement(req.file.buffer, req.file.mimetype, req.file.originalname); }
    catch (e) { return res.status(500).json({ error: `Could not read that statement: ${e.message}` }); }

    // Place it: the statement's own period_end wins; fall back to the clicked
    // month if the reader couldn't find dates.
    let periodEnd = ex.period_end || null, periodStart = ex.period_start || null;
    if (!periodEnd && req.body.month && /^\d{4}-\d{2}$/.test(req.body.month)) {
      const [y, m] = req.body.month.split('-').map(Number);
      periodEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // last day of month
      periodStart = `${req.body.month}-01`;
    }
    const monthKey = periodEnd ? String(periodEnd).slice(0, 7) : null;

    // Don't create a duplicate for a month already imported on this account.
    if (monthKey) {
      const { data: existing } = await supabase.from('bank_statement_imports')
        .select('id').eq('bank_account_id', bankAccountId).eq('status', 'completed')
        .gte('statement_period_end', `${monthKey}-01`).lte('statement_period_end', periodEnd).limit(1);
      if (existing && existing.length) return res.json({ ok: true, already: true, month: monthKey, account: ba.account_nickname });
    }

    const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const safeName = (req.file.originalname || 'bank-statement.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `bank-statements/${ba.community_id}/${sha.slice(0, 12)}-${safeName}`;
    try { await supabase.storage.from('documents').upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true }); } catch (_) {}

    const { data: bsi, error: bsiErr } = await supabase.from('bank_statement_imports').insert({
      management_company_id: BEDROCK_MGMT_CO_ID, community_id: ba.community_id, bank_account_id: bankAccountId,
      statement_period_start: periodStart, statement_period_end: periodEnd,
      beginning_balance_cents: ex.beginning_balance_cents ?? null, ending_balance_cents: ex.ending_balance_cents ?? null,
      total_deposits_cents: ex.total_deposits_cents ?? null, total_withdrawals_cents: ex.total_withdrawals_cents ?? null,
      total_fees_cents: ex.total_fees_cents ?? null, total_interest_cents: ex.total_interest_cents ?? null,
      source_filename: req.file.originalname || null, source_storage_path: storagePath, source_sha256: sha,
      source_file_size_bytes: req.file.size, source_file_mime: req.file.mimetype,
      extraction_raw: ex, extraction_warnings: ex.warnings || [], status: 'completed',
    }).select('id').single();
    if (bsiErr) throw bsiErr;

    const txRows = (ex.transactions || []).filter((t) => t.posting_date && t.amount_cents != null).map((t) => ({
      bank_statement_import_id: bsi.id, posting_date: t.posting_date, amount_cents: t.amount_cents,
      description: t.description || null, check_number: t.check_number || null, transaction_type: t.transaction_type || 'other',
    }));
    if (txRows.length) { try { await supabase.from('bank_statement_transactions').insert(txRows); } catch (_) {} }

    res.json({ ok: true, month: monthKey, account: ba.account_nickname, warnings: ex.warnings || [] });
  } catch (err) { handleErr(res, 'statement-tracker-upload', err); }
});

router.get('/accounts/:bankAccountId/config', async (req, res) => {
  try { res.json({ config: await getBankCheckConfig(req.params.bankAccountId) }); }
  catch (err) { handleErr(res, 'config-get', err); }
});

router.put('/accounts/:bankAccountId/config', express.json({ limit: '8mb' }), async (req, res) => {
  try { res.json({ config: await updateBankCheckConfig(req.params.bankAccountId, req.body || {}) }); }
  catch (err) { handleErr(res, 'config-put', err); }
});

// GET /banks — bank master list (for the account-setup picker).
router.get('/banks', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('banks').select('id, name, aba_check').order('name');
    if (error) throw error;
    res.json({ banks: data || [] });
  } catch (err) { handleErr(res, 'banks', err); }
});

// GET /accounts — which communities have a bank account set up, and are they
// ready to print (routing + account number both present).
router.get('/accounts', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data, error } = await supabase.from('bank_accounts')
      .select('id, community_id, account_nickname, account_last4, account_number_encrypted, account_type, next_check_number, check_stock_format, check_stock_micr_pre_encoded, is_check_disbursement, community:community_id(name), bank:bank_id(name, aba_check)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    // "ready to print" needs BOTH a routing number (via bank) AND the FULL
    // account number (encrypted) — last-4 alone can't build a MICR line.
    res.json({
      micr_font_installed: micrFontInstalled(), // blank-stock checks need a real E-13B font bundled
      accounts: (data || []).map(({ account_number_encrypted, ...a }) => ({
        ...a, has_full_number: !!account_number_encrypted,
        is_check_account: !!a.is_check_disbursement,
        ready: !!(a.bank && a.bank.aba_check && account_number_encrypted),
      })),
    });
  } catch (err) { handleErr(res, 'accounts-list', err); }
});

// POST /accounts — create a community's bank account. The account number is
// encrypted at rest (lib/crypto_field); only the last 4 are kept in the clear.
// ADMIN ONLY — this is bank credentials.
router.post('/accounts', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const acct = String(b.account_number || '').replace(/[^0-9]/g, '');
    if (!b.community_id || !b.bank_id || !acct || !b.next_check_number) {
      return res.status(400).json({ error: 'community_id, bank_id, account_number and next_check_number are required.' });
    }
    const STOCK = ['std_top', 'std_middle', 'std_bottom', 'voucher_top', 'three_per_page'];
    const stock = STOCK.includes(b.check_stock_format) ? b.check_stock_format : 'std_top';
    const row = {
      community_id: b.community_id, management_company_id: BEDROCK_MGMT_CO_ID, bank_id: b.bank_id,
      account_nickname: b.account_nickname || null,
      account_number_encrypted: encryptField(acct), account_last4: last4(acct),
      next_check_number: parseInt(b.next_check_number, 10) || 1000,
      check_stock_format: stock,
      check_stock_micr_pre_encoded: b.pre_encoded !== false,
      dual_sig_threshold_cents: b.dual_sig_threshold_cents ? parseInt(b.dual_sig_threshold_cents, 10) : null,
    };
    const { data, error } = await supabase.from('bank_accounts').insert(row).select('id').single();
    if (error) throw error;
    res.json({ ok: true, bank_account_id: data.id, account_last4: row.account_last4 });
  } catch (err) { handleErr(res, 'accounts-create', err); }
});

// PATCH /accounts/:id — complete/fix an EXISTING account (most communities
// already have their account rows from the fund-accounting setup; they just
// need the bank + the full account number filled in). Only sets what's provided.
router.patch('/accounts/:id', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const b = req.body || {};
    const patch = {};
    if (b.bank_id) patch.bank_id = b.bank_id;
    if (b.next_check_number != null) patch.next_check_number = parseInt(b.next_check_number, 10) || 1000;
    if (b.account_nickname != null) patch.account_nickname = b.account_nickname || null;
    if (b.check_stock_format) {
      const STOCK = ['std_top', 'std_middle', 'std_bottom', 'voucher_top', 'three_per_page'];
      if (STOCK.includes(b.check_stock_format)) patch.check_stock_format = b.check_stock_format;
    }
    if (b.pre_encoded != null) patch.check_stock_micr_pre_encoded = b.pre_encoded !== false;
    if (b.dual_sig_threshold_cents != null) patch.dual_sig_threshold_cents = b.dual_sig_threshold_cents ? parseInt(b.dual_sig_threshold_cents, 10) : null;
    if (b.account_number) {
      const acct = String(b.account_number).replace(/[^0-9]/g, '');
      if (acct) { patch.account_number_encrypted = encryptField(acct); patch.account_last4 = last4(acct); }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
    const { error } = await supabase.from('bank_accounts').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { handleErr(res, 'accounts-patch', err); }
});

// POST /accounts/:id/designate-check — make THIS the community's sole check-
// disbursement account (checks can only ever be cut from it). Clears any other
// in the same community first (the DB also enforces one-per-community).
router.post('/accounts/:id/designate-check', express.json(), async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const { data: acct } = await supabase.from('bank_accounts').select('id, community_id, bank_id').eq('id', req.params.id).maybeSingle();
    if (!acct) return res.status(404).json({ error: 'account_not_found' });
    if (!acct.bank_id) return res.status(400).json({ error: 'Link this account to a bank first — a check account needs a routing number.' });
    await supabase.from('bank_accounts').update({ is_check_disbursement: false }).eq('community_id', acct.community_id).eq('is_check_disbursement', true);
    const { error } = await supabase.from('bank_accounts').update({ is_check_disbursement: true }).eq('id', acct.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { handleErr(res, 'designate-check', err); }
});

// GET /accounts/:id/test-print — a SAFE alignment print. Renders one sample
// check using the account's real bank config (routing + MICR) but FORCES the
// NON-NEGOTIABLE DRAFT watermark and consumes NO check number and posts NOTHING.
// For loading your check stock and checking that everything lands in the right
// spot before a live run.
router.get('/accounts/:id/test-print', async (req, res) => {
  const admin = await requireAdmin(req, res); if (!admin) return;
  try {
    const cfg = await getBankCheckConfig(req.params.id, { forRender: true });
    if (!cfg.routing || !cfg.account_number) {
      return res.status(400).json({ error: 'This account is not ready to print — it needs a routing number (bank) and the full account number.' });
    }
    cfg.ready_for_print = false; // ALWAYS watermark a test print, even if the account is live-ready
    const sample = [{
      check_number: cfg.next_check_number || 1001,
      issue_date: new Date().toISOString().slice(0, 10),
      payee_name: 'VOID — ALIGNMENT TEST — NOT A VALID CHECK',
      amount_cents: 123456,
      memo: 'Alignment test print',
      invoices: [{ invoice_number: 'TEST', invoice_date: new Date().toISOString().slice(0, 10), description: 'Alignment test — not a real payment', amount_cents: 123456 }],
    }];
    const pdf = await renderChecksPDF(sample, cfg);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="check-alignment-test.pdf"');
    res.send(pdf);
  } catch (err) { handleErr(res, 'test-print', err); }
});

router.post('/run', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const run = await createCheckRun({
      community_id: b.community_id, bank_account_id: b.bank_account_id,
      payment_date: b.payment_date, invoice_ids: b.invoice_ids, memo: b.memo, user: b.user || null,
    });
    res.json(run);
  } catch (err) { handleErr(res, 'run', err); }
});

router.get('/run/:printRunId/pdf', async (req, res) => {
  try {
    const data = await getRunForRender(req.params.printRunId);
    if (!data || !data.checks.length) return res.status(404).json({ error: 'run_not_found_or_empty' });
    const pdf = await renderChecksPDF(data.checks, data.bankConfig);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="checks-${req.params.printRunId.slice(0, 8)}.pdf"`);
    res.send(pdf);
  } catch (err) { handleErr(res, 'run-pdf', err); }
});

router.get('/register', async (req, res) => {
  try {
    const { community_id, bank_account_id, limit = '500' } = req.query;
    if (!community_id) return res.status(400).json({ error: 'community_id_required' });
    let q = supabase.from('check_register')
      .select('id, bank_account_id, check_number, issue_date, payee_name, amount_cents, status, memo, voided_reason, cleared_date, print_run_id')
      .eq('community_id', community_id)
      .order('issue_date', { ascending: false })
      .order('check_number', { ascending: false })
      .limit(Math.min(parseInt(limit, 10) || 500, 2000));
    if (bank_account_id) q = q.eq('bank_account_id', bank_account_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ checks: data || [] });
  } catch (err) { handleErr(res, 'register', err); }
});

router.post('/void', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.check_register_id) return res.status(400).json({ error: 'check_register_id_required' });
    res.json(await voidCheck({ check_register_id: b.check_register_id, reason: b.reason, user: b.user || null }));
  } catch (err) { handleErr(res, 'void', err); }
});

module.exports = router;
