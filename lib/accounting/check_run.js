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
const { voidJournalEntry } = require('./posting');
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

// Payee mailing block for the check. Prefers the structured remit fields; if
// those are unstructured (the whole address — often WITH the vendor name — was
// dumped into remit_address_line1, city/state/zip null), strip the leading
// vendor name and parse "City, ST ZIP" off the end into clean lines. The
// renderer prints payee_name separately, so the name must NOT repeat here.
// (Ed 2026-08-14 — Canyon Gate checks.)
// Collapse a multi-line address so everything above the final City/ST/ZIP line
// sits on ONE street line (e.g. ["12808 W Airport Blvd","Ste 253","Sugar Land, TX
// 77478"] -> ["12808 W Airport Blvd, Ste 253","Sugar Land, TX 77478"]).
function _oneLineStreet(lines) {
  if (!Array.isArray(lines) || lines.length <= 2) return lines;
  return [lines.slice(0, -1).join(', '), lines[lines.length - 1]];
}

function formatVendorAddress(v) {
  if (!v) return [];
  // Standard 3-line block (the renderer prints the payee name above these):
  //   street (+ suite, comma-joined) / City, ST ZIP.  (Ed 2026-08-14.)
  if (v.remit_city || v.remit_state || v.remit_zip) {
    const street = [v.remit_address_line1, v.remit_address_line2].map((x) => (x || '').trim()).filter(Boolean).join(', ');
    const csz = [[v.remit_city, v.remit_state].filter(Boolean).join(', '), v.remit_zip].filter(Boolean).join(' ').trim();
    return [street, csz].filter(Boolean);
  }
  let raw = String(v.remit_address_line1 || v.address || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  for (const nm of [v.payee_name, v.name].filter(Boolean)) {
    const n = String(nm).replace(/\s+/g, ' ').trim();
    if (n && raw.toLowerCase().startsWith(n.toLowerCase())) { raw = raw.slice(n.length).replace(/^[\s,]+/, ''); break; }
  }
  // Greedy street so the city is the token right before the state (handles a
  // missing comma before the city, e.g. "8810 Madie Drive Houston, Texas 77022").
  // Street + suite stay on ONE line.
  const m = raw.match(/^(.*\S)\s+([A-Za-z.][A-Za-z. ]*?),?\s+(TX|Texas|[A-Z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/i);
  if (m) {
    const st = /^texas$/i.test(m[3]) ? 'TX' : m[3].toUpperCase();
    const street = m[1].replace(/[,\s]+$/, '').replace(/\s+/g, ' ').trim();
    return [street, `${m[2].trim()}, ${st} ${m[4]}`];
  }
  // Fallback: comma-split, but keep everything except the final City + ST/ZIP on
  // one street line (never one comma-part per line).
  const parts = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (parts.length <= 2) return parts;
  return [parts.slice(0, -2).join(', '), parts.slice(-2).join(', ')];
}

// The service description for a check stub — the primary invoice LINE, never the
// AP `notes` (which hold Emma's internal processing chatter: "ACH auto-pay — do
// NOT cut a check", "possible duplicate", "loaded from email"). Skips tax/
// subtotal/discount/payment noise lines. (Ed 2026-08-14.)
const _NOISE_LINE = /^(sub-?total|totals?|sales?\s*tax|tax(\s|$)|tax standard|customer\s+disc|discount|payment\b|amount\s+due|balance\b|shipping|handling)/i;
function primaryServiceDesc(lines) {
  const arr = (lines || []).filter((l) => l && l.description && String(l.description).trim());
  const pick = arr.filter((l) => !_NOISE_LINE.test(String(l.description).trim()))[0] || arr[0];
  if (!pick) return '';
  let d = String(pick.description).trim().replace(/\s+/g, ' ');
  if (d.length > 70) d = d.slice(0, 69).trimEnd() + '…';
  return d;
}
function balanceOf(inv) { return Number(inv.total_cents) - Number(inv.amount_paid_cents || 0); }

// Emma's intake stamps "ACH auto-pay — do NOT cut a check" into notes when it
// classifies a bill as ACH. If the vendor is later corrected to check-pay, that
// note goes stale — and this queue ONLY holds check-payable bills, so such a
// note is definitionally contradictory here (it tells the operator not to do
// the exact thing this screen is for). Drop those sentences; keep any real
// remainder (e.g. "loaded from email"). The is_ach_autopay flag is the single
// source of truth for routing — the note must never contradict it. (Ed 2026-07-16.)
function payableNoteFor(inv) {
  if (inv.is_ach_autopay === true) return inv.notes || null; // shouldn't be in this list, but don't rewrite if so
  if (!inv.notes) return null;
  const kept = String(inv.notes)
    .split(/(?<=\.)\s+/)
    .filter((s) => !/auto.?pay|do not cut a check|record only|confirms ach|mention(?:s|ing)? ach/i.test(s))
    .join(' ')
    .trim();
  return kept || null;
}

// ---------------------------------------------------------------------------
async function listPayableInvoices({ community_id }) {
  if (!community_id) throw Object.assign(new Error('community_id_required'), { code: 'invalid_input' });
  const { data, error } = await supabase.from('ap_invoices')
    .select('id, vendor_id, vendor_invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, status, notes, source_document_id, source_storage_path, is_ach_autopay, ap_invoice_lines(description, amount_cents), vendors(id, name, payee_name, remit_address_line1, remit_address_line2, remit_city, remit_state, remit_zip)')
    .eq('community_id', community_id)
    .in('status', PAYABLE_STATUSES)
    .order('invoice_date', { ascending: true })
    .limit(2000);
  if (error) throw error;
  // Exclude auto-draft (bank draft / do-not-pay) bills — they're paid by the
  // bank, never by a check (Ed 2026-07-11); cutting a check would double-pay.
  return (data || []).filter((i) => balanceOf(i) > 0 && i.is_ach_autopay !== true).map((i) => ({
    id: i.id, vendor_id: i.vendor_id,
    vendor_name: (i.vendors && (i.vendors.payee_name || i.vendors.name)) || 'Vendor',
    vendor_invoice_number: i.vendor_invoice_number, invoice_date: i.invoice_date, due_date: i.due_date,
    total_cents: Number(i.total_cents), balance_cents: balanceOf(i),
    // WHAT THE BILL IS FOR, from the invoice's own words — never Emma's
    // processing note. (Ed 2026-08-18: "seems description in LOPF checks still
    // saying emma loaded from email, i thought we fixed that to represent what
    // its actually for.")
    //
    // The check STUB was fixed to read the invoice line back on 2026-08-14
    // (primaryServiceDesc). This queue was not, and still rendered
    // payableNoteFor — which strips the ACH chatter but happily passes through
    // "Emma: loaded from email." So the operator approving a payment was shown
    // how the bill ARRIVED instead of what it BOUGHT. Same fix, same source of
    // truth, both surfaces.
    //
    // payableNoteFor stays as the fallback for a bill with no extracted lines,
    // where a staff note is better than nothing.
    description: primaryServiceDesc(i.ap_invoice_lines) || payableNoteFor(i),
    // The supporting invoice PDF, one click from check approval (Ed 2026-07-11).
    // Served by the CHECK module (staff-cookie auth) so the link works as a plain
    // navigation; the ap-intake endpoint is Bearer-admin-gated and 403'd on click.
    // (Ed 2026-07-16.)
    has_document: !!i.source_storage_path,
    support_doc_url: i.source_storage_path ? `/api/checks/payable/${i.id}/document` : null,
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
    .select('id, community_id, vendor_id, vendor_invoice_number, invoice_date, total_cents, amount_paid_cents, status, notes, is_ach_autopay, vendors(id, name, payee_name)')
    .in('id', invoice_ids);
  // Never cut a check for an auto-draft bill — the bank already pays it.
  const valid = (invs || []).filter((i) => i.community_id === community_id && PAYABLE_STATUSES.includes(i.status) && balanceOf(i) > 0 && i.is_ach_autopay !== true);
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

// Reconstruct one register row into the renderer's per-check input shape.
async function _reconstructCheck(r) {
  let invoices = [], payeeLines = [];
  if (r.ap_payment_id) {
    const { data: apps } = await supabase.from('ap_payment_applications').select('invoice_id, applied_cents').eq('payment_id', r.ap_payment_id);
    const invIds = (apps || []).map((a) => a.invoice_id);
    if (invIds.length) {
      const { data: invs } = await supabase.from('ap_invoices')
        .select('id, vendor_invoice_number, invoice_date, vendors(name, payee_name, remit_address_line1, remit_address_line2, remit_city, remit_state, remit_zip, address)')
        .in('id', invIds);
      const byId = new Map((invs || []).map((i) => [i.id, i]));
      // Line items carry the actual service description for the stub.
      const { data: allLines } = await supabase.from('ap_invoice_lines')
        .select('invoice_id, description, line_number').in('invoice_id', invIds).order('line_number');
      const linesByInv = new Map();
      for (const l of (allLines || [])) { if (!linesByInv.has(l.invoice_id)) linesByInv.set(l.invoice_id, []); linesByInv.get(l.invoice_id).push(l); }
      if (invs && invs[0]) payeeLines = formatVendorAddress(invs[0].vendors);
      invoices = (apps || []).map((a) => {
        const iv = byId.get(a.invoice_id) || {};
        return { invoice_number: iv.vendor_invoice_number || '', invoice_date: iv.invoice_date || null, description: primaryServiceDesc(linesByInv.get(a.invoice_id)), amount_cents: a.applied_cents };
      });
    }
  }
  return { check_number: r.check_number, issue_date: r.issue_date, amount_cents: r.amount_cents, memo: r.memo, payee_name: r.payee_name, payee_address_lines: payeeLines, invoices, voided: r.status === 'voided' };
}

// "Today" in Central time as YYYY-MM-DD — the reprint lock compares against this.
function _centralToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}
// The date a check was actually printed (run created), Central, YYYY-MM-DD.
function _printedDate(r) {
  return new Date(r.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
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
  for (const r of regs) checks.push(await _reconstructCheck(r));
  return { checks: checks.filter((c) => !c.voided), bankConfig };
}

// ---------------------------------------------------------------------------
// Reprint a hand-picked set of checks into ONE combined PDF. Guarded against
// double-issue: a check can only be reprinted on the SAME DAY it was printed
// (Ed 2026-08-14). After that date the reprint is locked — reprinting a check
// that already went out risks a duplicate physical payment.
async function getChecksForReprint({ community_id, check_register_ids, allowLockedOverride = false }) {
  if (!Array.isArray(check_register_ids) || !check_register_ids.length) {
    throw Object.assign(new Error('no_checks_selected'), { code: 'invalid_state' });
  }
  const { data: regs, error } = await supabase.from('check_register')
    .select('id, bank_account_id, community_id, check_number, issue_date, payee_name, amount_cents, memo, ap_payment_id, status, created_at')
    .in('id', check_register_ids)
    .order('check_number', { ascending: true });
  if (error) throw error;
  if (!regs || !regs.length) throw Object.assign(new Error('checks_not_found'), { code: 'invalid_state' });

  const today = _centralToday();
  const locked = [];
  for (const r of regs) {
    // Voided/cleared/wrong-community are ALWAYS blocked — the admin override only
    // waives the same-day time lock, never these integrity checks.
    if (r.community_id !== community_id) locked.push(`#${r.check_number} (different community)`);
    else if (r.status === 'voided') locked.push(`#${r.check_number} (voided)`);
    else if (r.status === 'cleared') locked.push(`#${r.check_number} (already cleared the bank)`);
    else if (!allowLockedOverride && _printedDate(r) !== today) locked.push(`#${r.check_number} printed ${_printedDate(r)}`);
  }
  if (locked.length) {
    throw Object.assign(new Error(`Reprint locked (printed on a prior day, to prevent double-issue): ${locked.join(', ')}. Void and re-issue if a check must be re-cut.`), { code: 'reprint_locked' });
  }
  const bankIds = [...new Set(regs.map((r) => r.bank_account_id))];
  if (bankIds.length > 1) throw Object.assign(new Error('selected checks span multiple bank accounts — reprint one account at a time'), { code: 'invalid_state' });

  const bankConfig = await getBankCheckConfig(regs[0].bank_account_id, { forRender: true });
  const checks = [];
  for (const r of regs) checks.push(await _reconstructCheck(r));
  return { checks: checks.filter((c) => !c.voided), bankConfig };
}

// ---------------------------------------------------------------------------
// A printed check that posted created FOUR things (see ap_engine.recordPayment):
// a JE (Dr AP / Cr Cash), an ap_payments row, application rows, and a paid-down
// invoice. Marking only the register row voided — which is all this used to do —
// left the books saying cash left the account and the bill was settled while the
// register said the check was dead. The bank rec could never tie, and the vendor
// never got re-paid. The void now reverses all of it, append-only:
//
//   - the JE is reversed via voidJournalEntry (offsetting entry + reverses_je_id;
//     the original entry is never edited or deleted)
//   - ap_payments -> 'voided'
//   - each affected invoice's amount_paid_cents is RECOMPUTED from its surviving
//     (non-voided) payments, so the bill reopens and can be re-cut
//   - the register row keeps its check number forever (no sequence gaps at audit)
//
// The reversal posts into TODAY's open period, not the check's original month.
// Closed books are immutable; you do not reopen a closed month to kill a check.
// If today has no open period, postJournalEntry throws period_closed and nothing
// is written — the operator is told rather than left with a half-void.
//
// RETRY-SAFE, because these are four separate writes with no enclosing
// transaction (the same pattern recordPayment already uses). Recomputing each
// invoice from its surviving payments — rather than decrementing it — means a
// retry after a partial failure lands on the same number instead of
// double-counting, and an already-reversed JE is treated as done, not fatal.
//
// disposition:
//   'reissue' (default) — bill still owed; invoice reopens so a new check cuts
//   'cancel'            — bill not owed; the invoice still reopens, because
//                         voiding the BILL is a separate deliberate action
//   'stop_payment'      — the check already left the building; the register
//                         records stop_payment (not voided) so the bank-side
//                         request stays visible. Accounting unwinds identically.
async function voidCheck({ check_register_id, reason, user, disposition = 'reissue' }) {
  if (!reason || !String(reason).trim()) {
    throw Object.assign(new Error('void_reason_required'), { code: 'invalid_input' });
  }
  const DISPOSITIONS = ['reissue', 'cancel', 'stop_payment'];
  if (!DISPOSITIONS.includes(disposition)) {
    throw Object.assign(new Error('disposition_must_be_reissue_cancel_or_stop_payment'), { code: 'invalid_input' });
  }
  const why = String(reason).trim();

  const { data: chk, error: chkErr } = await supabase.from('check_register')
    .select('id, status, ap_payment_id, check_number, amount_cents, community_id, notes')
    .eq('id', check_register_id).maybeSingle();
  if (chkErr) throw chkErr;
  if (!chk) throw Object.assign(new Error('check_not_found'), { code: 'invalid_input' });
  if (chk.status === 'cleared') {
    throw Object.assign(new Error('cannot_void_a_cleared_check'), { code: 'invalid_state' });
  }
  // Idempotency guard. Without this, a double-click posts a SECOND reversing
  // entry and overstates cash by the full check amount.
  if (chk.status === 'voided' || chk.status === 'stop_payment') {
    throw Object.assign(new Error('check_already_voided'), { code: 'invalid_state' });
  }

  let reversalJeId = null;
  let reversed = false;
  const invoicesReopened = [];

  if (chk.ap_payment_id) {
    const { data: pay, error: payErr } = await supabase.from('ap_payments')
      .select('id, status, posting_journal_entry_id').eq('id', chk.ap_payment_id).maybeSingle();
    if (payErr) throw payErr;

    if (pay) {
      // 1) Reverse the GL entry.
      if (pay.posting_journal_entry_id) {
        try {
          const r = await voidJournalEntry({
            journal_entry_id: pay.posting_journal_entry_id,
            void_reason: 'Check #' + chk.check_number + ' voided: ' + why,
            posted_by_user_id: user || null,
          });
          reversalJeId = r.reversal_entry.id;
          reversed = true;
        } catch (e) {
          // A prior partial run already reversed it — finish the rest of the
          // unwind rather than failing and leaving the void half-applied.
          if (e && e.message === 'already_voided') { reversed = true; }
          else { throw e; }
        }
      }

      // 2) Kill the payment. Application rows are KEPT — they are the audit
      //    trail of what this check once settled.
      const { error: pvErr } = await supabase.from('ap_payments').update({
        status: 'voided', voided_at: new Date().toISOString(), voided_reason: why,
      }).eq('id', pay.id);
      if (pvErr) throw pvErr;

      // 3) Reopen every bill this check settled, recomputing each from the
      //    payments that SURVIVE. Idempotent by construction.
      const { data: apps, error: appErr } = await supabase.from('ap_payment_applications')
        .select('invoice_id').eq('payment_id', pay.id);
      if (appErr) throw appErr;

      const invoiceIds = [...new Set((apps || []).map((a) => a.invoice_id).filter(Boolean))];
      for (const invoiceId of invoiceIds) {
        const { data: inv, error: invErr } = await supabase.from('ap_invoices')
          .select('id, total_cents, amount_paid_cents, status, posting_journal_entry_id').eq('id', invoiceId).maybeSingle();
        if (invErr) throw invErr;
        if (!inv) continue;

        // All applications against this bill, then the status of each paying
        // payment. Two queries rather than one nested select — a nested SELECT
        // through a relationship can come back silently EMPTY when PostgREST's
        // schema cache is stale, and an empty read here would zero a live bill.
        const { data: invApps, error: iaErr } = await supabase.from('ap_payment_applications')
          .select('payment_id, applied_cents').eq('invoice_id', invoiceId);
        if (iaErr) throw iaErr;
        const payIds = [...new Set((invApps || []).map((a) => a.payment_id).filter(Boolean))];
        let liveIds = new Set();
        if (payIds.length) {
          const { data: pays, error: psErr } = await supabase.from('ap_payments')
            .select('id, status').in('id', payIds);
          if (psErr) throw psErr;
          liveIds = new Set((pays || []).filter((p) => p.status !== 'voided').map((p) => p.id));
        }
        const newPaid = (invApps || [])
          .filter((a) => liveIds.has(a.payment_id))
          .reduce((s, a) => s + Number(a.applied_cents || 0), 0);

        // 'cancel' means the bill itself was wrong, which in practice means the
        // vendor sends a corrected one as a NEW invoice. (Ed 2026-08-18: "when
        // we void a check for incorrect invoice that should not remain pending,
        // we will just get a new one." Confirmed live the same day — the
        // corrected Texas Access Works bill arrived at a different amount while
        // the original sat held.) So a cancel finishes the job: the accrual is
        // reversed and the invoice is voided, exactly as api/ap.js
        // /invoices/:id/void does. Leaving it 'on_hold' only creates a wrong
        // bill sitting in the ledger waiting for someone to release it by
        // mistake.
        //
        // Guard: only void a bill nothing else is paying. If another live
        // payment still covers part of it, this check was not the whole story
        // and the bill stays.
        const cancelling = disposition === 'cancel' && newPaid <= 0 && inv.status !== 'voided';

        if (cancelling && inv.posting_journal_entry_id) {
          // Reverse the ACCRUAL (Dr expense / Cr AP) so the books do not carry
          // an expense and a payable for a bill that no longer exists. Append
          // only — the original entry is never edited or deleted.
          try {
            await voidJournalEntry({
              journal_entry_id: inv.posting_journal_entry_id,
              void_reason: 'Bill cancelled with check #' + chk.check_number + ': ' + why,
              posted_by_user_id: user || null,
            });
          } catch (e) {
            if (e && e.message !== 'already_voided') throw e;
          }
        }

        const newStatus = inv.status === 'voided' ? 'voided'
          : cancelling ? 'voided'
          : newPaid <= 0 ? 'approved'
          : newPaid >= inv.total_cents ? 'paid' : 'partially_paid';
        const patch = { amount_paid_cents: newPaid, status: newStatus };
        if (newStatus !== 'paid') patch.paid_at = null;
        if (cancelling) {
          patch.voided_at = new Date().toISOString();
          patch.voided_reason = 'Cancelled with check #' + chk.check_number + ': ' + why;
        }
        const { error: updErr } = await supabase.from('ap_invoices').update(patch).eq('id', inv.id);
        if (updErr) throw updErr;
        invoicesReopened.push({ invoice_id: inv.id, status: newStatus, amount_paid_cents: newPaid });
      }
    }
  }

  // 4) The register row goes LAST, so a failure anywhere above leaves the check
  //    visibly still live rather than showing "voided" over books that never
  //    unwound. Re-running the void then completes it.
  const now = new Date().toISOString();
  // Record WHICH disposition was chosen. 'reissue' and 'cancel' both land on
  // status='voided', so without this the register cannot tell "cut it again" from
  // "don't pay this" after the fact — and they have opposite consequences for the
  // bill.
  const dispNote = 'Void disposition: ' + disposition + ' — ' + why;
  const patch = {
    voided_at: now, voided_by_user_id: user || null, voided_reason: why,
    notes: chk.notes ? (chk.notes + '\n' + dispNote) : dispNote,
  };
  if (disposition === 'stop_payment') {
    patch.status = 'stop_payment';
    patch.stop_payment_at = now;
    patch.stop_payment_reason = why;
  } else {
    patch.status = 'voided';
  }
  const { error } = await supabase.from('check_register').update(patch).eq('id', check_register_id);
  if (error) throw error;

  const verb = disposition === 'stop_payment' ? 'stop-paid' : 'voided';
  return {
    ok: true,
    check_register_id,
    check_number: chk.check_number,
    disposition,
    status: patch.status,
    accounting_reversed: reversed,
    reversal_journal_entry_id: reversalJeId,
    invoices_reopened: invoicesReopened,
    note: reversed
      ? 'Check #' + chk.check_number + ' ' + verb + '. The AP payment and its GL entry were reversed; ' + invoicesReopened.length + ' bill(s) reopened for payment.'
      : 'Check #' + chk.check_number + ' ' + verb + '. Nothing had been posted for it, so there was no GL entry to reverse.',
  };
}

// Does this GL account number exist in the community's chart of accounts?
// Guards against linking a bank account to a phantom GL number (the cash-on-hand
// display silently blanks when the link points at a non-existent account —
// Ed 2026-08-14, Canyon Gate/Quail Ridge). Empty link is allowed (null = unset).
async function glAccountExists(community_id, account_number) {
  const num = String(account_number == null ? '' : account_number).trim();
  if (!num) return { ok: true, empty: true };
  const { data, error } = await supabase.from('chart_of_accounts')
    .select('account_number, account_name').eq('community_id', community_id).eq('account_number', num).maybeSingle();
  if (error) throw error;
  return { ok: !!data, account_number: num, account_name: data ? data.account_name : null };
}

// The community's cash/asset GL accounts (for the check-setup GL dropdown).
async function listCommunityCashAccounts(community_id) {
  const { data } = await supabase.from('chart_of_accounts')
    .select('account_number, account_name, account_type')
    .eq('community_id', community_id).eq('account_type', 'asset')
    .order('account_number');
  return (data || []).map((a) => ({ account_number: a.account_number, account_name: a.account_name }));
}

// ---------------------------------------------------------------------------
// Setup config — read (masked for display, full for render) and write.
async function getBankCheckConfig(bank_account_id, { forRender = false } = {}) {
  const { data: ba } = await supabase.from('bank_accounts')
    // check_stock_micr_pre_encoded: stock bought from the bank with the MICR
    // line already magnetically printed on it. It was missing from this select,
    // so the renderer never saw it and printed a SECOND MICR line on top of the
    // bank's. Wells Fargo refused the result. See the scar note in
    // check_renderer.js renderOneCheck. (Ed 2026-08-21.)
    .select('id, community_id, management_company_id, account_nickname, bank_name, account_last4, bank_id, next_check_number, check_stock_format, check_stock_micr_pre_encoded, dual_sig_threshold_cents, signature_image_path, signature_image_path_secondary, account_number_encrypted, gl_account_number, communities(name, legal_name)')
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
  let masterSignature = null;
  if (ba.management_company_id) {
    // Company row carries both the payer address AND the master authorized
    // signature (Ed signs for every community, so it lives once here). The
    // signature column may be absent pre-migration; select it separately so its
    // absence doesn't fail the whole query.
    const { data: mc } = await supabase.from('management_companies').select('address').eq('id', ba.management_company_id).maybeSingle();
    if (mc && mc.address) {
      // Keep street + suite on ONE line (matches the payee block: name / street,
      // suite / City, ST ZIP) so the return address doesn't drop "Ste" to its own
      // line. (Ed 2026-08-14.)
      try { const { addressLinesFromString } = require('../mail/address_block'); company_address_lines = _oneLineStreet(addressLinesFromString(mc.address)); }
      catch (_) { company_address_lines = [mc.address]; }
    }
    try { const { data: sig } = await supabase.from('management_companies').select('check_signature_image').eq('id', ba.management_company_id).maybeSingle(); if (sig) masterSignature = sig.check_signature_image || null; }
    catch (_) { /* column not applied yet — fall back to per-account only */ }
  }
  // Per-account signature wins (a community can override with a different signer);
  // otherwise the company master applies. (Ed 2026-07-16.)
  const effectiveSignature = ba.signature_image_path || masterSignature;

  const base = {
    bank_account_id: ba.id,
    account_name: (ba.communities && (ba.communities.legal_name || ba.communities.name)) || ba.account_nickname || '',
    account_nickname: ba.account_nickname,
    bank_name: bankName,
    routing,
    account_last4: account_full ? last4(account_full) : ba.account_last4,
    next_check_number: ba.next_check_number,
    check_stock_format: ba.check_stock_format,
    // TRUE = the stock already carries a magnetic MICR line, so the renderer
    // must NOT print one. Defaults to false: printing a MICR line onto blank
    // stock that turns out to be pre-encoded is a rejected check, but omitting
    // one from stock that is genuinely blank produces a check with no MICR at
    // all, which is obvious on sight. Fail toward the visible mistake.
    check_stock_micr_pre_encoded: ba.check_stock_micr_pre_encoded === true,
    dual_sig_threshold_cents: ba.dual_sig_threshold_cents,
    has_signature: !!effectiveSignature,
    signature_source: ba.signature_image_path ? 'account' : (masterSignature ? 'master' : 'none'),
    ready_for_print: ready,
    company_address_lines,
    gl_account_number: ba.gl_account_number || null,
    gl_accounts: await listCommunityCashAccounts(ba.community_id),
    gl_link_valid: (await glAccountExists(ba.community_id, ba.gl_account_number)).ok,
  };
  if (forRender) {
    base.account_number = account_full;
    base.signature_image_data_url = effectiveSignature || null; // path or data URL; renderer just <img src>'s it
    base.signature_image_data_url_secondary = ba.signature_image_path_secondary || null;
  }
  return base;
}

async function updateBankCheckConfig(bank_account_id, patch) {
  const { data: ba } = await supabase.from('bank_accounts').select('id, bank_id, management_company_id, community_id').eq('id', bank_account_id).maybeSingle();
  if (!ba) throw Object.assign(new Error('bank_account_not_found'), { code: 'invalid_input' });

  const baPatch = {};
  // GL cash-account link — validated against the community's chart so a phantom
  // number can't be saved (that silently blanks cash-on-hand). '' clears it.
  if (patch.gl_account_number !== undefined) {
    const num = String(patch.gl_account_number == null ? '' : patch.gl_account_number).trim();
    if (num) {
      const chk = await glAccountExists(ba.community_id, num);
      if (!chk.ok) throw Object.assign(new Error(`GL account ${num} isn't in this community's chart of accounts — pick an existing cash account (e.g. 1000 Operating Cash).`), { code: 'invalid_input' });
      baPatch.gl_account_number = num;
    } else {
      baPatch.gl_account_number = null;
    }
  }
  if (patch.account_number != null) {
    baPatch.account_number_encrypted = encryptField(String(patch.account_number).replace(/\s/g, ''));
    baPatch.account_last4 = last4(patch.account_number);
  }
  if (patch.next_check_number != null) baPatch.next_check_number = Number(patch.next_check_number);
  if (patch.dual_sig_threshold_cents !== undefined) baPatch.dual_sig_threshold_cents = patch.dual_sig_threshold_cents;
  if (patch.check_stock_format != null) baPatch.check_stock_format = patch.check_stock_format;
  // Signature: by default a new upload becomes the MASTER (one signer for all
  // communities — Ed's setup). Pass signature_as_master:false to set it only on
  // THIS account (a per-community override). (Ed 2026-07-16.)
  if (patch.signature_image_data_url != null) {
    if (patch.signature_as_master === false) {
      baPatch.signature_image_path = patch.signature_image_data_url;
    } else if (ba.management_company_id) {
      const { error: mErr } = await supabase.from('management_companies').update({ check_signature_image: patch.signature_image_data_url }).eq('id', ba.management_company_id);
      if (mErr) {
        // Column not applied yet, or write failed — fall back to per-account so
        // the upload is never silently lost.
        console.warn('[check_run] master signature save failed, storing per-account:', mErr.message);
        baPatch.signature_image_path = patch.signature_image_data_url;
      }
    } else {
      baPatch.signature_image_path = patch.signature_image_data_url;
    }
  }
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

module.exports = { listPayableInvoices, createCheckRun, getRunForRender, getChecksForReprint, voidCheck, getBankCheckConfig, updateBankCheckConfig, glAccountExists, listCommunityCashAccounts };
