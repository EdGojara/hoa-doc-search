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
async function commitInvoice({ extracted, vendorId, communityId, sha256, storagePath, intakeMethod, sourceRef }) {
  if (!vendorId || !communityId) return { outcome: 'needs_review', reason: 'missing vendor or community' };
  if (!extracted.total_cents || extracted.total_cents <= 0) return { outcome: 'needs_review', reason: 'no invoice total' };
  if (!extracted.invoice_date) return { outcome: 'needs_review', reason: 'no invoice date' };

  const { verdict, matches } = await findDuplicates(supabase, {
    communityId, vendorId, invoiceNumber: extracted.invoice_number,
    totalCents: extracted.total_cents, invoiceDate: extracted.invoice_date, fileSha256: sha256,
  });

  if (verdict === 'certain') {
    return { outcome: 'blocked_duplicate', duplicate_of: matches[0].invoice.id, matches };
  }

  const suspected = verdict === 'suspected';
  const row = {
    community_id: communityId, vendor_id: vendorId,
    vendor_invoice_number: extracted.invoice_number || null,
    invoice_date: extracted.invoice_date, due_date: extracted.due_date || null, terms: extracted.terms || null,
    subtotal_cents: extracted.subtotal_cents || 0, tax_cents: extracted.tax_cents || 0, total_cents: extracted.total_cents,
    status: suspected ? 'on_hold' : 'awaiting_approval',
    dedup_status: suspected ? 'suspected_duplicate' : 'unique',
    duplicate_of_invoice_id: suspected ? matches[0].invoice.id : null,
    intake_method: intakeMethod || 'manual_upload', intake_source_ref: sourceRef || null,
    source_storage_path: storagePath || null, source_filename: extracted._filename || null,
    file_sha256: sha256 || null,
    auto_coded: true, auto_coding_confidence: 'medium', auto_coding_signal: 'emma_intake',
    notes: suspected ? `Emma: possible duplicate of AP ${matches[0].invoice.id} — ${matches[0].reason}. Held for review.` : 'Emma: loaded from ' + (intakeMethod || 'upload') + '.',
  };

  const { data, error } = await supabase.from('ap_invoices').insert(row).select('id').single();
  if (error) {
    // The UNIQUE (community, vendor, invoice#) backstop fired — it IS a duplicate.
    if (String(error.message || '').toLowerCase().includes('duplicate') || error.code === '23505') {
      const { data: orig } = await supabase.from('ap_invoices').select('id')
        .eq('community_id', communityId).eq('vendor_id', vendorId).eq('vendor_invoice_number', extracted.invoice_number).maybeSingle();
      return { outcome: 'blocked_duplicate', duplicate_of: orig ? orig.id : null, matches };
    }
    throw error;
  }
  return { outcome: suspected ? 'held_suspected_duplicate' : 'loaded', invoice_id: data.id, duplicate_of: suspected ? matches[0].invoice.id : null, matches };
}

// ---- autoIntake: non-interactive channels (email, mail scan) ----------------
// Stage -> resolve -> commit in one shot. Returns the commit outcome, or
// needs_review when the vendor/community/total/date can't be resolved without a
// human. Best-effort: callers should never let this throw into their own flow.
async function autoIntake({ buffer, filename, intakeMethod, sourceRef, communityId }) {
  const { extracted, sha256, storagePath } = await stageInvoice(buffer, filename);
  if (!extracted.looks_like_invoice) return { outcome: 'not_an_invoice', extracted };
  const v = await resolveVendor({ name: extracted.vendor_name, email: extracted.vendor_email });
  let cid = communityId || null;
  if (!cid) { const c = await resolveCommunity(extracted.community_hint); cid = c.community ? c.community.id : null; }
  if (!v.vendor || !cid) return { outcome: 'needs_review', reason: !v.vendor ? 'vendor not matched' : 'association not matched', extracted, storage_path: storagePath, sha256 };
  return commitInvoice({ extracted, vendorId: v.vendor.id, communityId: cid, sha256, storagePath, intakeMethod, sourceRef });
}

module.exports = { stageInvoice, resolveVendor, resolveCommunity, commitInvoice, autoIntake, normName };
