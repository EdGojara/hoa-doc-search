// ============================================================================
// lib/ap/invoice_document.js — the canonical library_documents row for a bill
// (Issue #9 step 1, ChatGPT review of 31273c33)
// ----------------------------------------------------------------------------
// Vendor invoice PDFs belong in library_documents (category 'vendor_invoice');
// that is the document single source of truth (CLAUDE.md). The old Payables
// upload created that row; the canonical intake rail did not, so converging the
// upload onto the rail would have dropped document retention. This lives in the
// RAIL (commitInvoice calls it), so email, mail scan, /admin/ap and the
// Payables upload all get the same retention.
//
// Idempotent: the same stored file (sha256) in the same community resolves to
// the existing row, so retries and duplicate intake never create a second one.
// Never silent: returns { ok:false, reason } when the file wasn't stored or the
// row can't be written; the caller holds the bill for review with the reason.
// ============================================================================

async function ensureInvoiceDocument(supabase, {
  communityId, vendorName, invoiceNumber, invoiceDate, storagePath, sha256, filename, sizeBytes,
} = {}) {
  if (!communityId) return { ok: false, reason: 'no community for the source document' };
  if (!storagePath || !sha256) return { ok: false, reason: 'the source PDF was not stored' };

  const existing = await supabase.from('library_documents').select('id')
    .eq('community_id', communityId).eq('category', 'vendor_invoice').eq('file_hash', sha256)
    .order('uploaded_at', { ascending: true }).limit(1);
  if (existing.error) return { ok: false, reason: `document lookup failed: ${existing.error.message}` };
  if (existing.data && existing.data.length) return { ok: true, id: existing.data[0].id, existing: true };

  const comm = await supabase.from('communities').select('name, management_company_id').eq('id', communityId).maybeSingle();
  if (comm.error) return { ok: false, reason: `community lookup failed: ${comm.error.message}` };
  const cname = (comm.data && comm.data.name) || '';
  const vname = vendorName || 'Vendor';
  const ins = await supabase.from('library_documents').insert({
    management_company_id: (comm.data && comm.data.management_company_id) || null,
    community_id: communityId,
    category: 'vendor_invoice',
    title: `AP Invoice — ${vname} #${invoiceNumber || ''}`.trim(),
    file_name_original: filename || null,
    file_name_normalized: `${cname.trim()} - Vendor Invoice - ${vname} - ${invoiceNumber || invoiceDate || ''}.pdf`.replace(/\s+/g, ' '),
    file_path: storagePath,
    file_hash: sha256,
    file_size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    created_by_mgmt_company: 'Bedrock',
  }).select('id').single();
  if (ins.error) return { ok: false, reason: `document index write failed: ${ins.error.message}` };
  return { ok: true, id: ins.data.id, existing: false };
}

module.exports = { ensureInvoiceDocument };
