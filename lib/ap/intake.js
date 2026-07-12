// ============================================================================
// lib/ap/intake.js  (Ed 2026-07-08)
// ----------------------------------------------------------------------------
// THE single door into ap_invoices. Email (emma@), manual upload, and Mail Scan
// all come through here, so a bill can't be entered twice by arriving on two
// channels. Flow:
//
//   stageInvoice(buffer)  -> extract fields + sha256 + stash the PDF (no DB write)
//   resolveVendor/Community -> match to masters (never auto-creates junk)
//   commitInvoice(...)    -> re-run dedup, then:
//        certain duplicate  -> BLOCK (no new payable; point at the original)
//        suspected duplicate -> insert on_hold + flag (visible, unpayable until cleared)
//        unique             -> insert awaiting_approval
//
// ap_invoices requires community + vendor + a positive total + a date, so an
// invoice missing any of those is returned as needs_review rather than force-fit.
// ============================================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractInvoice } = require('./invoice_extract');
const { findDuplicates } = require('./dedup');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BEDROCK_MGMT_CO_ID = '00000000-0000-0000-0000-000000000001';
const BUCKET = 'documents';

const normName = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|co|corp|ltd|company|services|service|the)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---- staging: read the PDF, don't touch the DB yet --------------------------
async function stageInvoice(buffer, filename) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const extracted = await extractInvoice(buffer);
  let storagePath = null;
  try {
    const safe = (filename || 'invoice.pdf').replace(/[^a-zA-Z0-9._\-]/g, '_');
    storagePath = `ap_invoices/${sha256.slice(0, 16)}_${safe}`;
    await supabase.storage.from(BUCKET).upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  } catch (e) { console.warn('[ap_intake] stash failed (non-fatal):', e.message); storagePath = null; }
  return { extracted, sha256, storagePath };
}

// ---- vendor resolution: email first, then a confident name match ------------
async function resolveVendor({ name, email }) {
  if (email) {
    const { data } = await supabase.from('vendors').select('id, name, dba, email')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).ilike('email', email.trim()).limit(2);
    if (data && data.length === 1) return { vendor: data[0], candidates: data, method: 'email' };
  }
  if (name) {
    const n = normName(name);
    const { data } = await supabase.from('vendors').select('id, name, dba, email')
      .eq('management_company_id', BEDROCK_MGMT_CO_ID).limit(1000);
    const hits = (data || []).filter((v) => normName(v.name) === n || (v.dba && normName(v.dba) === n));
    if (hits.length === 1) return { vendor: hits[0], candidates: hits, method: 'name' };
    if (hits.length > 1) return { vendor: null, candidates: hits, method: 'name_ambiguous' };
    // loose contains match -> candidates only (operator picks)
    const loose = (data || []).filter((v) => normName(v.name).includes(n) || n.includes(normName(v.name))).slice(0, 8);
    return { vendor: null, candidates: loose, method: loose.length ? 'name_loose' : 'none' };
  }
  return { vendor: null, candidates: [], method: 'none' };
}

async function resolveCommunity(hint) {
  if (!hint) return { community: null, candidates: [] };
  const { data } = await supabase.from('communities').select('id, name').limit(1000);
  const h = normName(hint);
  const exact = (data || []).filter((c) => normName(c.name) === h);
  if (exact.length === 1) return { community: exact[0], candidates: exact };
  const loose = (data || []).filter((c) => { const cn = normName(c.name); return cn && (h.includes(cn) || cn.includes(h)); }).slice(0, 8);
  return { community: loose.length === 1 ? loose[0] : null, candidates: loose };
}

// ---- commit: dedup + insert-or-hold-or-block --------------------------------
// Returns { outcome, invoice_id?, duplicate_of?, matches }
async function commitInvoice({ extracted, vendorId, communityId, sha256, storagePath, intakeMethod, sourceRef, achHintText }) {
  if (!vendorId || !communityId) return { outcome: 'needs_review', reason: 'missing vendor or community' };
  if (!extracted.total_cents || extracted.total_cents <= 0) return { outcome: 'needs_review', reason: 'no invoice total' };
  if (!extracted.invoice_date) return { outcome: 'needs_review', reason: 'no invoice date' };

  // ACH auto-pay: an auto-drafted bill (bank draft / DO NOT PAY) is paid by the
  // bank, so Emma records it but keeps it OUT of the check run — otherwise it
  // gets a check AND the draft = double payment. Trigger on the vendor flag OR
  // the bill's own text (extractor's auto_draft, or the email/scan hint). When
  // the bill says so but the vendor isn't flagged yet, LEARN it onto the vendor.
  const vres = await supabase.from('vendors').select('auto_pay_ach').eq('id', vendorId).maybeSingle();
  const vendorFlag = !vres.error && vres.data && vres.data.auto_pay_ach;
  const hay = `${extracted.terms || ''} ${(extracted.line_items || []).map((l) => l.description).join(' ')} ${achHintText || ''}`.toLowerCase();
  const textSaysAutoDraft = extracted.auto_draft === true
    || /\bach\b|auto.?draft|auto.?pay|automatic\w*\s+(draft|debit|withdraw|payment)|bank.?draft|do.?not.?pay|e-?check|electronic\w*\s+(payment|draft)/.test(hay);
  const isAch = !!(vendorFlag || textSaysAutoDraft);
  const achConfirmed = isAch ? textSaysAutoDraft : null;
  if (textSaysAutoDraft && !vendorFlag) {
    try { await supabase.from('vendors').update({ auto_pay_ach: true }).eq('id', vendorId); } catch (_) { /* learn best-effort */ }
  }

  const { verdict, matches } = await findDuplicates(supabase, {
    communityId, vendorId, invoiceNumber: extracted.invoice_number,
    totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date, fileSha256: sha256,
    accountNumber: extracted.account_number || null,
    servicePeriodStart: extracted.service_period_start || null, servicePeriodEnd: extracted.service_period_end || null,
  });

  if (verdict === 'certain') {
    return { outcome: 'blocked_duplicate', duplicate_of: matches[0].invoice.id, matches };
  }

  const suspected = verdict === 'suspected';

  // AI-CPA coding: suggest the expense account from vendor default -> history ->
  // budget fit -> description (Ed 2026-07-11). Non-fatal: an unclassified bill
  // still loads, just flagged for review.
  let coded = null;
  try {
    const { suggestClassification } = require('../accounting/gl_classifier');
    const codeDesc = (Array.isArray(extracted.line_items) ? extracted.line_items.map((l) => l.description).filter(Boolean).join('; ') : '') || extracted.vendor_name || null;
    coded = await suggestClassification({ communityId, vendorId, description: codeDesc });
  } catch (e) { console.warn('[ap intake] auto-code failed:', e.message); }

  const row = {
    community_id: communityId, vendor_id: vendorId,
    vendor_invoice_number: extracted.invoice_number || null,
    invoice_date: extracted.invoice_date, due_date: extracted.due_date || null, terms: extracted.terms || null,
    subtotal_cents: extracted.subtotal_cents || 0, tax_cents: extracted.tax_cents || 0, total_cents: extracted.total_cents,
    account_number: extracted.account_number || null,
    service_period_start: extracted.service_period_start || null, service_period_end: extracted.service_period_end || null,
    status: suspected ? 'on_hold' : 'awaiting_approval',
    dedup_status: suspected ? 'suspected_duplicate' : 'unique',
    duplicate_of_invoice_id: suspected ? matches[0].invoice.id : null,
    intake_method: intakeMethod || 'manual_upload', intake_source_ref: sourceRef || null,
    source_storage_path: storagePath || null, source_filename: extracted._filename || null,
    file_sha256: sha256 || null,
    is_ach_autopay: isAch, ach_confirmed_by_invoice: achConfirmed,
    auto_coded: !!(coded && coded.account_id),
    auto_coding_confidence: (coded && ['high', 'medium', 'low'].includes(coded.confidence)) ? coded.confidence : 'low',
    auto_coding_signal: 'gl_classifier',
    coded_gl_account_id: (coded && coded.account_id) || null,
    classification_reason: (coded && coded.reason) || null,
    needs_review: suspected || !(coded && coded.account_id) || !!(coded && coded.needs_review),
    notes: suspected
      ? `Emma: possible duplicate of AP ${matches[0].invoice.id} — ${matches[0].reason}. Held for review.`
      : (isAch
        ? `Emma: ACH auto-pay vendor — record only, do NOT cut a check. Invoice ${achConfirmed ? 'confirms' : 'does not explicitly mention'} ACH. Loaded from ${intakeMethod || 'upload'}.`
        : `Emma: loaded from ${intakeMethod || 'upload'}.`),
  };

  let { data, error } = await supabase.from('ap_invoices').insert(row).select('id').single();
  // Graceful degrade: if migration 267 (ACH columns) isn't applied yet, strip
  // those fields and load the invoice anyway — never regress the intake over a
  // pending migration. ACH flag simply isn't persisted until 267 lands.
  if (error && /ach_confirmed_by_invoice|is_ach_autopay|coded_gl_account_id|classification_reason|needs_review|account_number|service_period|column .* does not exist/i.test(String(error.message || ''))) {
    delete row.is_ach_autopay; delete row.ach_confirmed_by_invoice;
    delete row.coded_gl_account_id; delete row.classification_reason; delete row.needs_review;
    delete row.account_number; delete row.service_period_start; delete row.service_period_end;
    ({ data, error } = await supabase.from('ap_invoices').insert(row).select('id').single());
  }
  if (error) {
    // The UNIQUE (community, vendor, invoice#) backstop fired — it IS a duplicate.
    if (String(error.message || '').toLowerCase().includes('duplicate') || error.code === '23505') {
      const { data: orig } = await supabase.from('ap_invoices').select('id')
        .eq('community_id', communityId).eq('vendor_id', vendorId).eq('vendor_invoice_number', extracted.invoice_number).maybeSingle();
      return { outcome: 'blocked_duplicate', duplicate_of: orig ? orig.id : null, matches };
    }
    throw error;
  }
  // Auto-post the accrual to the GL (Dr coded expense / Cr A/P) so the bill hits
  // the books with no touch — the only human gate is check approval (Ed 2026-07-11).
  // Only for cleanly-loaded, coded invoices; suspected dups + uncoded ones wait.
  let accrualJeId = null;
  if (!suspected && coded && coded.account_id) {
    accrualJeId = await postAccrualForInvoice({
      invoiceId: data.id, communityId, vendorId, codedAccountId: coded.account_id,
      totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date,
      vendorInvoiceNumber: extracted.invoice_number, vendorName: extracted.vendor_name,
      sourceDocumentId: extracted.source_document_id || null, sourceDocumentPath: storagePath || null,
      classificationReason: coded.reason || null,
    });
  }
  return { outcome: suspected ? 'held_suspected_duplicate' : 'loaded', invoice_id: data.id, posting_journal_entry_id: accrualJeId, duplicate_of: suspected ? matches[0].invoice.id : null, matches };
}

// Post the AP accrual (Dr coded expense / Cr Accounts Payable). Heavily guarded
// + non-fatal: a missing precondition (no coding, no AP account, no open period
// for the invoice date — e.g. a community not yet GL-live) just leaves the
// invoice unposted for review; it never breaks intake or posts a bad entry.
async function postAccrualForInvoice(a) {
  try {
    if (!a.codedAccountId || !a.totalCents || a.totalCents <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(String(a.invoiceDate || ''))) return null;
    let ap = null;
    for (const num of ['20100', '2000']) {
      const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', a.communityId).eq('account_number', num).eq('is_active', true).maybeSingle();
      if (data) { ap = data; break; }
    }
    if (!ap) { const { data } = await supabase.from('chart_of_accounts').select('id').eq('community_id', a.communityId).ilike('account_name', '%accounts payable%').eq('is_active', true).limit(1).maybeSingle(); ap = data; }
    if (!ap) { console.warn('[ap intake] no A/P account for community — accrual skipped'); return null; }
    const { postJournalEntry } = require('../accounting/posting');
    const je = await postJournalEntry({
      community_id: a.communityId, posting_date: String(a.invoiceDate).slice(0, 10),
      description: `AP invoice ${a.vendorInvoiceNumber || ''} — ${a.vendorName || 'vendor'}`.trim(),
      source_module: 'ap_invoice', source_reference: a.invoiceId,
      lines: [
        { account_id: a.codedAccountId, debit_cents: a.totalCents, credit_cents: 0, memo: `Invoice ${a.vendorInvoiceNumber || ''}`.trim(), vendor_id: a.vendorId },
        { account_id: ap.id, debit_cents: 0, credit_cents: a.totalCents, memo: `AP — ${a.vendorName || 'vendor'}`.trim(), vendor_id: a.vendorId },
      ],
    });
    try { await supabase.from('journal_entries').update({ source_document_id: a.sourceDocumentId || null, source_document_path: a.sourceDocumentPath || null, classification_reason: a.classificationReason || null }).eq('id', je.entry.id); } catch (_) { /* Phase 1 doc-link cols */ }
    await supabase.from('ap_invoices').update({ posting_journal_entry_id: je.entry.id }).eq('id', a.invoiceId);
    return je.entry.id;
  } catch (e) { console.warn('[ap intake] accrual post skipped:', e.message); return null; }
}

// ---- autoIntake: non-interactive channels (email, mail scan) ----------------
// Stage -> resolve -> commit in one shot. Returns the commit outcome, or
// needs_review when the vendor/community/total/date can't be resolved without a
// human. Best-effort: callers should never let this throw into their own flow.
async function autoIntake({ buffer, filename, intakeMethod, sourceRef, communityId, vendorIdHint, achHintText }) {
  const { extracted, sha256, storagePath } = await stageInvoice(buffer, filename);
  if (!extracted.looks_like_invoice) return { outcome: 'not_an_invoice', extracted };
  const v = await resolveVendor({ name: extracted.vendor_name, email: extracted.vendor_email });
  // Prefer the vendor read off the invoice; fall back to the hint (e.g. the
  // email sender already resolved to a vendor).
  if (!v.vendor && vendorIdHint) v.vendor = { id: vendorIdHint };
  let cid = communityId || null;
  if (!cid) { const c = await resolveCommunity(extracted.community_hint); cid = c.community ? c.community.id : null; }
  if (!v.vendor || !cid) return { outcome: 'needs_review', reason: !v.vendor ? 'vendor not matched' : 'association not matched', extracted, storage_path: storagePath, sha256 };
  return commitInvoice({ extracted, vendorId: v.vendor.id, communityId: cid, sha256, storagePath, intakeMethod, sourceRef, achHintText });
}

module.exports = { stageInvoice, resolveVendor, resolveCommunity, commitInvoice, autoIntake, normName };
