// ============================================================================
// check_run.js — AP check printing flow on top of the migration-176 substrate.
//
//   listPayableInvoices  — approved invoices with a remaining balance
//   createCheckRun       — one check per vendor: reserve#, recordPayment (posts
//                          Dr A/P / Cr Cash, marks invoices paid), write the
//                          check_register row, group under a print_run_id
//   getRunForRender      — reconstruct the run's checks (+ invoice stubs + bank
//                          config) into the shape check_renderer wants
//   voidCheck            — append-only void (number stays in the register)
//   getBankCheckConfig / updateBankCheckConfig — the setup screen's read/write
//
// recordPayment is the accounting source of truth; the check_register is the
// document/control layer (UNIQUE(bank_account, check#), void history).
// ============================================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { recordPayment } = require('./ap_engine');
const { amountToWords } = require('./check_renderer');
const { encryptField, decryptField, last4 } = require('../crypto_field');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PAYABLE_STATUSES = ['approved', 'partially_paid'];

function vendorAddressLines(v) {
  if (!v) return [];
  return [
    v.remit_address_line1 || null,
    v.remit_address_line2 || null,
    [[v.remit_city, v.remit_state].filter(Boolean).join(', '), v.remit_zip].filter(Boolean).join(' ') || null,
  ].filter(Boolean);
}
function balanceOf(inv) { return Number(inv.total_cents) - Number(inv.amount_paid_cents || 0); }

// ---------------------------------------------------------------------------
async function listPayableInvoices({ community_id }) {
  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  const { data, error } = await supabase.from('ap_invoices')
    .select('id, vendor_id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status, notes, source_document_id, source_storage_path, vendors(id, name, payee_name, remit_address_line1, remit_address_line2, remit_city, remit_state, remit_zip)')
    .eq('community_id', community_id)
    .in('status', PAYABLE_STATUSES)
    .order('invoice_date', { ascending: true })
    .limit(2000);
  if (error) throw error;
  return (data || []).filter((i) => balanceOf(i) > 0).map((i) => ({
    id: i.id, vendor_id: i.vendor_id,
    vendor_name: (i.vendors && (i.vendors.payee_name || i.vendors.name)) || 'Vendor',
    vendor_invoice_number: i.vendor_invoice_number, invoice_date: i.invoice_date, due_date: i.due_date,
    total_cents: Number(i.total_cents), balance_cents: balanceOf(i), description: i.notes || null,
    // The supporting invoice PDF, one click from check approval (Ed 2026-07-11).
    has_document: !!(i.source_document_id || i.source_storage_path),
    support_doc_url: (i.source_document_id || i.source_storage_path) ? `/api/ap-intake/${i.id}/invoice-file` : null,
  }));
}

// ---------------------------------------------------------------------------
async function createCheckRun({ community_id, bank_account_id, payment_date, invoice_ids, memo, user }) {
  if (!community_id || !bank_account_id || !payment_date) throw Object.assign(new Error('community_id_bank_account_id_payment_date_required'), { code: 'invalid_input' });
  if (!Array.isArray(invoice_ids) || !invoice_ids.length) throw Object.assign(new Error('invoice_ids_required'), { code: 'invalid_input' });

  // Airtight check-source lock: checks may ONLY be cut from the account a human
  // explicitly designated as the disbursement account (mig 268) — never a legacy
  // / closing account at another bank. `=== false` so this is inert before mig
  // 268 adds the column (undefined), and enforces once it's live.
  const { data: ba } = await supabase.from('bank_accounts').select('*').eq('id', bank_account_id).maybeSingle();
  if (!ba) throw Object.assign(new Error('bank_account_not_found'), { code: 'invalid_input' });
  if (ba.is_check_disbursement === false) {
    throw Object.assign(new Error('not_the_designated_check_account'), { code: 'invalid_state' });
  }

  const { data: invs } = await supabase.from('ap_invoices')
    .select('id, community_id, vendor_id, vendor_invoice_number, invoice_date, total_cents, amount_paid_cents, status, notes, vendors(id, name, payee_name)')
    .in('id', invoice_ids);
  const valid = (invs || []).filter((i) => i.community_id === community_id && PAYABLE_STATUSES.includes(i.status) && balanceOf(i) > 0);
  if (!valid.length) throw Object.assign(new Error('no_payable_invoices_selected'), { code: 'invalid_state' });

  const byVendor = new Map();
  for (const i of valid) { if (!byVendor.has(i.vendor_id)) byVendor.set(i.vendor_id, []); byVendor.get(i.vendor_id).push(i); }

  const print_run_id = crypto.randomUUID();
  const checks = [];
  for (const [vendor_id, invoices] of byVendor) {
    const v = invoices[0].vendors || {};
    const amount_cents = invoices.reduce((s, i) => s + balanceOf(i), 0);
    const payee_name = v.payee_name || v.name || 'Vendor';

    // Reserve the check number (race-safe). Consumed here, before the postings.
    const { data: cn, error: cnErr } = await supabase.rpc('reserve_next_check_number', { p_bank_account_id: bank_account_id });
    if (cnErr) throw cnErr;
    const check_number = String(cn);

    // Post the payment (Dr A/P / Cr Cash, mark invoices paid).
    const applications = invoices.map((i) => ({ invoice_id: i.id, applied_cents: balanceOf(i) }));
    const pay = await recordPayment({ community_id, vendor_id, amount_cents, payment_date, payment_method: 'check', check_number, bank_account_id, applications, notes: memo, posted_by_user_id: user || null });

    const { data: reg, error: regErr } = await supabase.from('check_register').insert({
      community_id, bank_account_id, check_number, issue_date: payment_date,
      payee_name, amount_cents, amount_in_words: amountToWords(amount_cents),
      memo: memo || null, status: 'issued',
      ap_payment_id: pay.payment.id, posting_journal_entry_id: pay.payment.posting_journal_entry_id || null,
      print_run_id,
    }).select('id, check_number').single();
    if (regErr) throw regErr;

    checks.push({ check_register_id: reg.id, check_number, payee_name, amount_cents, vendor_id, invoice_count: invoices.length });
  }
  return { print_run_id, check_count: checks.length, total_cents: checks.reduce((s, c) => s + c.amount_cents, 0), checks };
}

// ---------------------------------------------------------------------------
// Reconstruct a run's checks (+ invoice stubs) into the renderer's input shape.
async function getRunForRender(print_run_id) {
  const { data: regs, error } = await supabase.from('check_register')
    .select('id, bank_account_id, community_id, check_number, issue_date, payee_name, amount_cents, memo, ap_payment_id, status')
    .eq('print_run_id', print_run_id)
    .order('check_number', { ascending: true });
  if (error) throw error;
  if (!regs || !regs.length) return null;

  const bankConfig = await getBankCheckConfig(regs[0].bank_account_id, { forRender: true });

  const checks = [];
  for (const r of regs) {
    let invoices = [], payeeLines = [];
    if (r.ap_payment_id) {
      const { data: apps } = await supabase.from('ap_payment_applications').select('invoice_id, applied_cents').eq('payment_id', r.ap_payment_id);
      const invIds = (apps || []).map((a) => a.invoice_id);
      if (invIds.length) {
        const { data: invs } = await supabase.from('ap_invoices')
          .select('id, vendor_invoice_number, invoice_date, notes, vendors(remit_address_line1, remit_address_line2, remit_city, remit_state, remit_zip)')
          .in('id', invIds);
        const byId = new Map((invs || []).map((i) => [i.id, i]));
        if (invs && invs[0]) payeeLines = vendorAddressLines(invs[0].vendors);
        invoices = (apps || []).map((a) => {
          const iv = byId.get(a.invoice_id) || {};
          return { invoice_number: iv.vendor_invoice_number || '', invoice_date: iv.invoice_date || null, description: iv.notes || '', amount_cents: a.applied_cents };
        });
      }
    }
    checks.push({ check_number: r.check_number, issue_date: r.issue_date, amount_cents: r.amount_cents, memo: r.memo, payee_name: r.payee_name, payee_address_lines: payeeLines, invoices, voided: r.status === 'voided' });
  }
  return { checks: checks.filter((c) => !c.voided), bankConfig };
}

// ---------------------------------------------------------------------------
async function voidCheck({ check_register_id, reason, user }) {
  const { data: chk } = await supabase.from('check_register').select('id, status, ap_payment_id').eq('id', check_register_id).maybeSingle();
  if (!chk) throw Object.assign(new Error('check_not_found'), { code: 'invalid_input' });
  if (['cleared'].includes(chk.status)) throw Object.assign(new Error('cannot_void_a_cleared_check'), { code: 'invalid_state' });
  const { error } = await supabase.from('check_register').update({
    status: 'voided', voided_at: new Date().toISOString(), voided_by_user_id: user || null, voided_reason: reason || null,
  }).eq('id', check_register_id);
  if (error) throw error;
  // NOTE: the AP payment + its GL entry are NOT auto-reversed here — voiding a
  // printed check that was already posted is an accounting decision (reissue vs
  // cancel the bill). Surfaced to the operator rather than guessed.
  return { ok: true, check_register_id, note: chk.ap_payment_id ? 'check voided; the AP payment/GL entry was left intact — reverse it separately if the bill is being cancelled' : 'check voided' };
}

// ---------------------------------------------------------------------------
// Setup config — read (masked for display, full for render) and write.
async function getBankCheckConfig(bank_account_id, { forRender = false } = {}) {
  const { data: ba } = await supabase.from('bank_accounts')
    .select('id, community_id, management_company_id, account_nickname, bank_name, account_last4, bank_id, next_check_number, check_stock_format, dual_sig_threshold_cents, signature_image_path, signature_image_path_secondary, account_number_encrypted, communities(name, legal_name)')
    .eq('id', bank_account_id).maybeSingle();
  if (!ba) throw Object.assign(new Error('bank_account_not_found'), { code: 'invalid_input' });

  let routing = null, bankName = ba.bank_name || null;
  if (ba.bank_id) {
    const { data: bank } = await supabase.from('banks').select('name, aba_check').eq('id', ba.bank_id).maybeSingle();
    if (bank) { routing = bank.aba_check || null; bankName = bank.name || bankName; }
  }
  const account_full = decryptField(ba.account_number_encrypted);
  const ready = !!(routing && account_full);

  // Payer address block (top-left, under the association name). Checks are
  // issued c/o the managing agent, so the address is the management company's
  // — same on every community's checks. Pulled here so it actually prints
  // (it was hardcoded empty before — Ed 2026-06-30, LOPF check setup).
  let company_address_lines = [];
  if (ba.management_company_id) {
    const { data: mc } = await supabase.from('management_companies').select('address').eq('id', ba.management_company_id).maybeSingle();
    if (mc && mc.address) {
      try { const { addressLinesFromString } = require('../mail/address_block'); company_address_lines = addressLinesFromString(mc.address); }
      catch (_) { company_address_lines = [mc.address]; }
    }
  }

  const base = {
    bank_account_id: ba.id,
    account_name: (ba.communities && (ba.communities.legal_name || ba.communities.name)) || ba.account_nickname || '',
    account_nickname: ba.account_nickname,
    bank_name: bankName,
    routing,
    account_last4: account_full ? last4(account_full) : ba.account_last4,
    next_check_number: ba.next_check_number,
    check_stock_format: ba.check_stock_format,
    dual_sig_threshold_cents: ba.dual_sig_threshold_cents,
    has_signature: !!ba.signature_image_path,
    ready_for_print: ready,
    company_address_lines,
  };
  if (forRender) {
    base.account_number = account_full;
    base.signature_image_data_url = ba.signature_image_path || null; // path or data URL; renderer just <img src>'s it
    base.signature_image_data_url_secondary = ba.signature_image_path_secondary || null;
  }
  return base;
}

async function updateBankCheckConfig(bank_account_id, patch) {
  const { data: ba } = await supabase.from('bank_accounts').select('id, bank_id').eq('id', bank_account_id).maybeSingle();
  if (!ba) throw Object.assign(new Error('bank_account_not_found'), { code: 'invalid_input' });

  const baPatch = {};
  if (patch.account_number != null) {
    baPatch.account_number_encrypted = encryptField(String(patch.account_number).replace(/\s/g, ''));
    baPatch.account_last4 = last4(patch.account_number);
  }
  if (patch.next_check_number != null) baPatch.next_check_number = Number(patch.next_check_number);
  if (patch.dual_sig_threshold_cents !== undefined) baPatch.dual_sig_threshold_cents = patch.dual_sig_threshold_cents;
  if (patch.check_stock_format != null) baPatch.check_stock_format = patch.check_stock_format;
  if (patch.signature_image_data_url != null) baPatch.signature_image_path = patch.signature_image_data_url;
  if (Object.keys(baPatch).length) {
    const { error } = await supabase.from('bank_accounts').update(baPatch).eq('id', bank_account_id);
    if (error) throw error;
  }
  // Routing lives on the bank record (per-bank, public).
  if (patch.routing != null && ba.bank_id) {
    await supabase.from('banks').update({ aba_check: String(patch.routing).replace(/\D/g, '') }).eq('id', ba.bank_id);
  }
  return getBankCheckConfig(bank_account_id);
}

module.exports = { listPayableInvoices, createCheckRun, getRunForRender, voidCheck, getBankCheckConfig, updateBankCheckConfig };
