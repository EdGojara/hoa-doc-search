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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
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
