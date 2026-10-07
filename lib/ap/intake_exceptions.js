// ============================================================================
// lib/ap/intake_exceptions.js  (Ed 2026-08-01)
// ----------------------------------------------------------------------------
// The holding pen for emailed bills Emma captured but couldn't auto-file (no
// community / no vendor / no total / no date). They leave her inbox and wait
// here so Payables has ONE list of stragglers to clear. recordException is
// idempotent per (source email, PDF). promoteException supplies the missing
// piece and loads it through the SAME commitInvoice path as every other bill.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const { emitWake } = require('../manager/wake');

const REASONS = new Set(['no_community', 'no_vendor', 'vendor_ambiguous', 'no_total', 'no_date', 'unreadable_attachment', 'other']);

// autoIntake reports needs_review with a human phrase ("association not matched",
// "no invoice total"); normalize to our reason enum.
function mapReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (REASONS.has(r)) return r;
  // Reimbursement / payment-request holds carry their full reason in notes; only
  // a missing community maps to a specific enum value.
  // An attachment the reader could not take (Issue #14): its own reason so Payables
  // sees "attachment not readable" plus the specific instruction in notes.
  if (/unsupported attachment|could not be (read|downloaded|opened)|heic|word file|old word|spreadsheet attachment|zip|invoice reader failed|has no readable text|larger than|too large/.test(r)) return 'unreadable_attachment';
  if (/^reimburs|payment requested/.test(r)) return /which community/.test(r) ? 'no_community' : 'other';
  if (/ambig/.test(r)) return 'vendor_ambiguous';
  if (/associat|communit/.test(r)) return 'no_community';
  if (/vendor/.test(r)) return 'no_vendor';
  if (/total|amount/.test(r)) return 'no_total';
  if (/date/.test(r)) return 'no_date';
  return 'other';
}

// Write (or no-op) an exception for a bill we couldn't place. Best-effort — never
// throws into ingest. Returns { ok, id? } or { ok:false, reason }.
async function recordException({ emailMessageId, sourceRef, reason, extracted, storagePath, sha256, communityId, suggestedVendorId } = {}) {
  try {
    const ex = extracted || {};
    // A reimbursement's amount is what staff REQUESTED, never the receipt total;
    // the person being paid is the payee, the store is only the source.
    const rb = ex.reimbursement || null;
    const row = {
      email_message_id: emailMessageId || null,
      intake_source_ref: sourceRef || null,
      reason: mapReason(reason),
      status: 'pending',
      vendor_name: rb ? (rb.reimbursee ? `Reimbursement: ${rb.reimbursee}` : 'Reimbursement') + (ex.vendor_name ? ` (receipt: ${ex.vendor_name})` : '') : (ex.vendor_name || null),
      community_hint: ex.community_hint || null,
      invoice_number: ex.invoice_number || null,
      account_number: ex.account_number || null,
      total_cents: rb ? (rb.requested_cents || null) : ((ex.total_cents && ex.total_cents > 0) ? ex.total_cents : null),
      invoice_date: ex.invoice_date || null,
      community_id: communityId || null,
      suggested_vendor_id: suggestedVendorId || null,
      storage_path: storagePath || null,
      file_sha256: sha256 || null,
      extracted: ex,
      notes: reason ? String(reason).slice(0, 1000) : null,
    };
    // Idempotent: a re-pull of the same email + bill must not stack duplicates.
    if (sourceRef && sha256) {
      const { data: dup } = await supabase.from('ap_intake_exceptions')
        .select('id, status').eq('intake_source_ref', sourceRef).eq('file_sha256', sha256).limit(1);
      if (dup && dup.length) return { ok: true, id: dup[0].id, existing: true };
      // The same bill forwarded again in a DIFFERENT email (Issue #14: the
      // petting-zoo .docx came in on 9/17 and again on 9/21) is the same
      // exception while the first is still pending, not a second card.
      if (communityId) {
        const { data: same } = await supabase.from('ap_intake_exceptions')
          .select('id').eq('file_sha256', sha256).eq('community_id', communityId).eq('status', 'pending').limit(1);
        if (same && same.length) return { ok: true, id: same[0].id, existing: true, same_file_other_email: true };
      }
    } else if (sourceRef) {
      // No file (a payment request with no readable PDF): one exception per email.
      const { data: dup } = await supabase.from('ap_intake_exceptions')
        .select('id, status').eq('intake_source_ref', sourceRef).is('file_sha256', null).limit(1);
      if (dup && dup.length) return { ok: true, id: dup[0].id, existing: true };
    }
    let { data, error } = await supabase.from('ap_intake_exceptions').insert(row).select('id').single();
    if (error) {
      // Lost the race to the unique index — return the winner.
      if (String(error.code) === '23505' && sourceRef && sha256) {
        const { data: w } = await supabase.from('ap_intake_exceptions').select('id').eq('intake_source_ref', sourceRef).eq('file_sha256', sha256).limit(1);
        if (w && w.length) return { ok: true, id: w[0].id, existing: true };
      }
      return { ok: false, reason: error.message };
    }
    // Amanda manager wake (Issue #27 Phase 1): only for a NEW exception, after it
    // is recorded. Never throws and never changes this result.
    await emitWake(supabase, { kind: 'ap_exception', sourceTable: 'ap_intake_exceptions', sourceId: data.id, communityId: row.community_id, wakeReason: `ap_exception:${row.reason}`,
      state: { reason: row.reason, status: 'pending' } });
    return { ok: true, id: data.id };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Pending exceptions for the Payables "needs attention" list, newest first.
async function listExceptions({ limit = 200 } = {}) {
  const { data, error } = await supabase.from('ap_intake_exceptions')
    .select('id, email_message_id, reason, notes, vendor_name, community_hint, invoice_number, account_number, total_cents, invoice_date, community_id, suggested_vendor_id, storage_path, created_at, reimbursement:extracted->reimbursement, community:community_id(name), suggested_vendor:suggested_vendor_id(name), service_period_start:extracted->>service_period_start, service_period_end:extracted->>service_period_end, staff_entered:extracted->staff_entered')
    .eq('status', 'pending').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  // The date offered on a no-date card: the bill's service date (suggestedInvoiceDate).
  return (data || []).map((x) => ({ ...x, suggested_invoice_date: suggestedInvoiceDate(x) }));
}

// The date staff are offered for a bill that prints none: the service date it
// does print (end of the period, else its start). A suggestion only; staff
// confirm or change it on the card.
function suggestedInvoiceDate(extracted) {
  const ex = extracted || {};
  const ok = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
  return ok(ex.service_period_end) || ok(ex.service_period_start) || null;
}

// A staff-typed invoice date: a real YYYY-MM-DD, not before 2000 (a typo like
// 0202) and not more than FUTURE_DAYS past today (Central). Returns { date } or
// { error, detail }.
const FUTURE_DAYS = 30;
function validateInvoiceDate(v, now = new Date()) {
  const s = String(v == null ? '' : v).trim();
  const bad = { error: 'bad_date', detail: 'Enter the invoice date as a real date (YYYY-MM-DD).' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return bad;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return bad;
  if (s < '2000-01-01') return { error: 'bad_date', detail: `${s} is too far in the past; check the year.` };
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const limit = new Date(Date.parse(today + 'T00:00:00Z') + FUTURE_DAYS * 86400000).toISOString().slice(0, 10);
  if (s > limit) return { error: 'bad_date', detail: `${s} is more than ${FUTURE_DAYS} days in the future; check the date.` };
  return { date: s };
}

// Sum of the bill's own lines in cents (extractor lines are dollars; others cents).
function lineSumCents(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  let t = 0;
  for (const l of lines) {
    const c = l.amount_cents != null ? Math.round(Number(l.amount_cents)) : Math.round(Number(l.amount) * 100);
    if (!Number.isFinite(c)) return null;
    t += c;
  }
  return t;
}

// Supply the missing piece and load it through commitInvoice. Returns the commit
// outcome; on a successful load, marks the exception resolved + links the invoice
// and marks the source email handled (it's off the inbox for good).
//
// A bill that printed no date (or no total) is finished HERE, from the stored
// file and extraction: staff type the date (prefilled from the service date)
// and, for a no-total bill, the amount; optionally the expense account on THIS
// community's chart. Who typed it and when is kept on the exception and in the
// payable's notes. It still loads through the same commitInvoice (duplicate
// checks, approval routing): nothing is bypassed. resolvedBy comes from the
// signed-in session, never the request body. (Ed 2026-10-07: Sweetie Pies
// Petting Zoo sat pending 10/2 to 10/7; the card had no way to enter a date.)
async function promoteException(id, { communityId, vendorId, vendorName, resolvedBy, invoiceDate, totalCents, accountId } = {}, deps = {}) {
  const db = deps.supabase || supabase;
  const intake = deps.intake || require('./intake');
  const now = deps.now || new Date();
  const { data: exc, error } = await db.from('ap_intake_exceptions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!exc) return { ok: false, error: 'not_found' };
  if (exc.status !== 'pending') return { ok: false, error: 'not_pending' };
  const cid = communityId || exc.community_id;
  if (!cid) return { ok: false, error: 'need_community', detail: 'Pick the community this bill belongs to.' };
  // A reimbursement must never be promoted as a bill from the store on the receipt.
  if (exc.extracted && exc.extracted.reimbursement) return { ok: false, error: 'use_reimbursement', detail: 'This is a reimbursement: create it with the reimbursement fields on this card.' };

  const ex = { ...(exc.extracted || {}) };
  const suggested = suggestedInvoiceDate(ex);
  const entered = {};

  // Invoice date: only when the bill printed none. A date the bill DOES print is
  // the bill's; correct it on the payable, not by typing over it here.
  const hasDateInput = invoiceDate != null && String(invoiceDate).trim() !== '';
  if (hasDateInput) {
    if (ex.invoice_date) return { ok: false, error: 'date_already_read', detail: `The bill prints its own date (${ex.invoice_date}); it can't be replaced here.` };
    const v = validateInvoiceDate(invoiceDate, now);
    if (v.error) return { ok: false, error: v.error, detail: v.detail, suggested_invoice_date: suggested };
    ex.invoice_date = v.date; entered.invoice_date = v.date;
  }
  if (!ex.invoice_date) {
    return { ok: false, error: 'need_date', suggested_invoice_date: suggested,
      detail: suggested ? `The bill prints no invoice date. Enter it (its service date is ${suggested}).` : 'The bill prints no invoice date. Enter it from the bill.' };
  }

  // Total: only when the bill read none. If the bill's own lines don't add up to
  // the typed total they are replaced by ONE line for the typed amount (the
  // accrual must equal what we owe) and the bill is held for review.
  const hasTotalInput = totalCents != null && String(totalCents).trim() !== '';
  let linesReplaced = false;
  if (hasTotalInput) {
    if (ex.total_cents && ex.total_cents > 0) return { ok: false, error: 'total_already_read', detail: 'The bill already shows a total; it can\'t be replaced here.' };
    const t = Number(totalCents);
    if (!Number.isInteger(t) || t <= 0 || t > 100000000) return { ok: false, error: 'bad_total', detail: 'Enter the amount due as a positive dollar amount.' };
    ex.total_cents = t; entered.total_cents = t;
    if (lineSumCents(ex.line_items) !== t) {
      const first = Array.isArray(ex.line_items) && ex.line_items[0] && ex.line_items[0].description;
      ex.line_items = [{ description: String(first || ex.vendor_name || 'Per invoice').slice(0, 200), quantity: 1, amount: t / 100 }];
      ex.subtotal_cents = t; ex.tax_cents = 0;
      linesReplaced = true;
    }
  }
  if (!ex.total_cents || ex.total_cents <= 0) return { ok: false, error: 'need_total', detail: 'The bill shows no amount. Enter the amount due from the bill.' };

  // GL override: resolved to THIS community's chart only (the same shape as a
  // staff email directive), so a pick can never land on another community's account.
  let staffGl = null;
  if (accountId) {
    const { data: acct, error: aErr } = await db.from('chart_of_accounts').select('id, account_number, account_name').eq('id', accountId).eq('community_id', cid).eq('is_active', true).maybeSingle();
    if (aErr) throw aErr;
    if (!acct) return { ok: false, error: 'bad_account', detail: "That account isn't on this community's chart." };
    staffGl = { account_id: acct.id, account_number: acct.account_number, account_name: acct.account_name };
    entered.account = `${acct.account_number} ${acct.account_name}`;
  }

  // Vendor: an explicit id, else the one we suggested, else resolve/create from a
  // name the operator typed or the bill's own printed vendor (an AP clerk sets up
  // a new vendor from the invoice — creating it isn't paying; approval still gates).
  let vid = vendorId || exc.suggested_vendor_id;
  if (!vid) {
    const nm = (vendorName && vendorName.trim()) || exc.vendor_name || ex.vendor_name;
    if (nm) {
      try {
        const rv = await intake.resolveVendor({ name: nm });
        if (rv.vendor) vid = rv.vendor.id;
        else {
          const { ensureVendorForInvoice } = require('./vendor_master');
          const e = await ensureVendorForInvoice({ extracted: { ...ex, vendor_name: nm }, actor: resolvedBy || 'Emma (AP)' });
          if (e.vendor) vid = e.vendor.id;
        }
      } catch (_) { /* fall through to the need_vendor prompt */ }
    }
  }
  if (!vid) return { ok: false, error: 'need_vendor', detail: 'Pick (or type) the vendor for this bill.' };

  // Who entered what, and when: kept on the exception (even if the load below
  // still fails) and written into the payable's notes.
  const by = resolvedBy || 'staff';
  const at = new Date(now).toISOString();
  let extraNotes = null;
  if (Object.keys(entered).length) {
    const parts = [];
    if (entered.invoice_date) parts.push(`invoice date ${entered.invoice_date} (the bill prints none${suggested ? `; service date ${suggested}` : ''})`);
    if (entered.total_cents) parts.push(`amount $${(entered.total_cents / 100).toFixed(2)} (the bill showed none${linesReplaced ? '; entered as one line' : ''})`);
    if (entered.account) parts.push(`account ${entered.account}`);
    extraNotes = `Entered from the intake exception by ${by} on ${at}: ${parts.join('; ')}.`;
    const upd = { extracted: { ...(exc.extracted || {}), staff_entered: { ...entered, by, at } } };
    if (entered.invoice_date) upd.invoice_date = entered.invoice_date;
    if (entered.total_cents) upd.total_cents = entered.total_cents;
    const { error: uErr } = await db.from('ap_intake_exceptions').update(upd).eq('id', id);
    if (uErr) return { ok: false, error: 'save_failed', detail: `Could not save what you entered (${uErr.message}). Nothing was loaded; try again.` };
  }

  const result = await intake.commitInvoice({
    extracted: ex, vendorId: vid, communityId: cid,
    sha256: exc.file_sha256 || null, storagePath: exc.storage_path || null,
    intakeMethod: 'email', sourceRef: exc.intake_source_ref || null,
    staffGl, extraNotes, forceReview: linesReplaced || undefined,
  });
  if (result.outcome === 'loaded' || result.outcome === 'held_suspected_duplicate' || result.outcome === 'blocked_duplicate') {
    const invId = result.invoice_id || result.duplicate_of || null;
    await db.from('ap_intake_exceptions').update({
      status: 'resolved', resolved_invoice_id: invId, resolved_by: by, resolved_at: new Date().toISOString(),
    }).eq('id', id);
    if (exc.email_message_id) { try { await db.from('email_messages').update({ triage_status: 'handled' }).eq('id', exc.email_message_id); } catch (_) {} }
    return { ok: true, outcome: result.outcome, invoice_id: invId };
  }
  // Still can't commit: report why. It stays pending, with what was entered kept.
  return { ok: false, error: result.outcome || 'not_loaded', detail: result.reason || 'Could not load this bill. Check the date, amount, vendor and community on the card and try again.' };
}

// A held REIMBURSEMENT: staff confirm who, how much and which account; it loads
// through the same commitInvoice path (awaiting_approval, needs_review), to a
// reimbursement payee, with the original receipt PDF + hash kept on the payable.
async function promoteReimbursementException(id, { communityId, reimburseeName, amountCents, accountId, resolvedBy } = {}, deps = {}) {
  const db = deps.supabase || supabase;
  const { data: exc, error } = await db.from('ap_intake_exceptions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!exc) return { ok: false, error: 'not_found' };
  if (exc.status !== 'pending') return { ok: false, error: 'not_pending' };
  const ex = exc.extracted || {};
  const rb = ex.reimbursement || {};
  const cid = communityId || exc.community_id || rb.community_id;
  const name = String(reimburseeName || rb.reimbursee || '').trim();
  const amt = Number(amountCents);
  if (!cid) return { ok: false, error: 'need_community', detail: 'Pick the community.' };
  if (!name) return { ok: false, error: 'need_reimbursee', detail: 'Enter who is being reimbursed.' };
  if (!Number.isInteger(amt) || amt <= 0) return { ok: false, error: 'need_amount', detail: 'Enter the amount to reimburse.' };
  if (!accountId) return { ok: false, error: 'need_account', detail: 'Pick the expense account.' };
  const { data: acct, error: aErr } = await db.from('chart_of_accounts').select('id, account_number, account_name').eq('id', accountId).eq('community_id', cid).eq('is_active', true).maybeSingle();
  if (aErr) throw aErr;
  if (!acct) return { ok: false, error: 'bad_account', detail: "That account isn't on this community's chart." };
  const intake = deps.intake || require('./intake');
  const payeeRes = await intake.findOrCreateReimbursementPayee({ name });
  if (!payeeRes || !payeeRes.payee) return { ok: false, error: 'payee_failed', detail: 'Could not set up the reimbursement payee.' };
  const date = ex.invoice_date || exc.invoice_date || new Date().toISOString().slice(0, 10);
  const store = (ex.vendor_name) || null;
  const extracted = {
    ...ex, invoice_date: date, total_cents: amt, subtotal_cents: amt, tax_cents: 0,
    line_items: [{ description: store ? `${store}: reimbursed purchase` : 'Reimbursed purchase', quantity: 1, unit_price_cents: amt, amount_cents: amt }],
  };
  const $ = (c) => (c == null ? 'n/a' : '$' + (c / 100).toFixed(2));
  const result = await intake.commitInvoice({
    extracted, vendorId: payeeRes.payee.id, communityId: cid,
    sha256: exc.file_sha256 || null, storagePath: exc.storage_path || null,
    intakeMethod: 'email', sourceRef: exc.intake_source_ref || null,
    reimbursementSource: store, forceReview: true,
    staffGl: { account_id: acct.id, account_number: acct.account_number, account_name: acct.account_name },
    extraNotes: `Reimbursement to ${name}: ${$(amt)} confirmed by ${resolvedBy || 'staff'}. Evidence: requested ${$(rb.requested_cents)}; receipt total ${$(rb.receipt_total_cents)}; receipt allocation ${$(rb.allocation_cents)}. Coded ${acct.account_number} ${acct.account_name}.${payeeRes.created ? ` New reimbursement payee created for ${name} (confirm the mailing address before the check run).` : ''}`,
  });
  if (result.outcome === 'loaded' || result.outcome === 'held_suspected_duplicate' || result.outcome === 'blocked_duplicate') {
    const invId = result.invoice_id || result.duplicate_of || null;
    await db.from('ap_intake_exceptions').update({ status: 'resolved', resolved_invoice_id: invId, resolved_by: resolvedBy || 'staff', resolved_at: new Date().toISOString() }).eq('id', id);
    if (exc.email_message_id) { try { await db.from('email_messages').update({ triage_status: 'handled' }).eq('id', exc.email_message_id); } catch (_) {} }
    return { ok: true, outcome: result.outcome, invoice_id: invId };
  }
  return { ok: false, error: result.outcome || 'not_loaded', detail: result.reason || 'Could not load the reimbursement.' };
}

async function dismissException(id, { by, notes } = {}) {
  const { data: exc } = await supabase.from('ap_intake_exceptions').select('email_message_id, status').eq('id', id).maybeSingle();
  if (!exc) return { ok: false, error: 'not_found' };
  await supabase.from('ap_intake_exceptions').update({
    status: 'dismissed', resolved_by: by || 'staff', resolved_at: new Date().toISOString(), notes: notes || null,
  }).eq('id', id);
  if (exc.email_message_id) { try { await supabase.from('email_messages').update({ triage_status: 'handled' }).eq('id', exc.email_message_id); } catch (_) {} }
  return { ok: true };
}

module.exports = { recordException, listExceptions, promoteException, suggestedInvoiceDate, validateInvoiceDate, promoteReimbursementException, dismissException, mapReason };
