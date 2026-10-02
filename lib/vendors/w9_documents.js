// ============================================================================
// lib/vendors/w9_documents.js  (Issue #14, Ed 2026-10-02)
// ----------------------------------------------------------------------------
// The ONE way a W-9 becomes a vendor's canonical W-9 document (vendor_documents,
// doc_type 'w9'). Used by the staff upload and by the vendor's secure form, so
// versioning and dedup cannot drift between the two paths.
//
//   - Idempotent: the same secure-form request, the same file bytes, or the same
//     substantive content (content_hash) never files a second document; the
//     existing one is returned. Migration 478 also enforces one document per
//     secure-form request in the database.
//   - Versioned: a genuinely new W-9 becomes current and the prior current one
//     is kept as history (superseded_at). The new row is inserted NON-current
//     first, then the prior is demoted, then the new one promoted, so a failure
//     part-way never leaves two current rows (uq_vendor_w9_current) and never
//     deletes the old W-9.
//   - Provenance: source ('staff_upload' | 'secure_form') + the secure-form
//     request id (migration 478). Before 478 is applied, the same provenance is
//     written into notes.
//   - It files the DOCUMENT only. It never sets w9_on_file, a classification or
//     an exemption: callers decide that (the staff upload does after its read; a
//     secure-form W-9 waits for a person, per Ed).
// ============================================================================

const isMissingColumn = (err) => !!err && /column .* does not exist|could not find the .* column|schema cache/i.test(err.message || '');
const isUniqueViolation = (err) => !!err && (err.code === '23505' || /duplicate key|unique constraint/i.test(err.message || ''));

async function fileW9Document(supabase, { vendorId, fileHash = null, contentHash = null, fileName = null, fileUrl = null, source, achRequestId = null, notes = null }) {
  if (!vendorId) throw Object.assign(new Error('vendorId required'), { code: 'invalid_input' });
  if (!['staff_upload', 'secure_form'].includes(source)) throw Object.assign(new Error('unknown W-9 source'), { code: 'invalid_input' });
  if (source === 'secure_form' && !achRequestId) throw Object.assign(new Error('a secure-form W-9 needs its request id'), { code: 'invalid_input' });

  // Prior W-9s for this vendor (dedup + supersede). Read the 478 columns when present.
  let has478 = true;
  let pr = await supabase.from('vendor_documents').select('id, file_hash, content_hash, is_current, uploaded_at, vendor_ach_request_id').eq('vendor_id', vendorId).eq('doc_type', 'w9');
  if (pr.error && isMissingColumn(pr.error)) { has478 = false; pr = await supabase.from('vendor_documents').select('id, file_hash, content_hash, is_current, uploaded_at').eq('vendor_id', vendorId).eq('doc_type', 'w9'); }
  if (pr.error) throw Object.assign(new Error(`W-9 documents read failed: ${pr.error.message}`), { code: 'w9_doc_read_failed' });
  const priors = pr.data || [];

  if (achRequestId) {
    const same = priors.find((d) => d.vendor_ach_request_id === achRequestId);
    if (same) return { duplicate: 'same_request', document: same, replaced_prior: false };
  }
  const identical = fileHash && priors.find((d) => d.file_hash && d.file_hash === fileHash);
  if (identical) return { duplicate: 'identical_file', document: identical, replaced_prior: false };
  const sameContent = contentHash && priors.find((d) => d.content_hash && d.content_hash === contentHash);
  if (sameContent) return { duplicate: 'same_content', document: sameContent, replaced_prior: false };

  const today = new Date().toISOString().slice(0, 10);
  const provenance = source === 'secure_form' ? `Received through the secure W-9 form (request ${achRequestId}).` : 'Uploaded by staff.';
  const base = { vendor_id: vendorId, doc_type: 'w9', file_name: fileName || 'W-9', file_url: fileUrl, effective_date: today, is_current: false, file_hash: fileHash, content_hash: contentHash };
  let ins = has478
    ? await supabase.from('vendor_documents').insert({ ...base, notes, source, vendor_ach_request_id: achRequestId }).select().single()
    : { error: { message: 'column vendor_documents.source does not exist' } };
  if (ins.error && isMissingColumn(ins.error)) {
    ins = await supabase.from('vendor_documents').insert({ ...base, notes: [notes, provenance].filter(Boolean).join(' ') }).select().single();
  }
  if (ins.error && isUniqueViolation(ins.error) && achRequestId) {
    // A concurrent retry of the same request won the insert: return its document.
    const { data: won, error: wErr } = await supabase.from('vendor_documents').select('*').eq('vendor_ach_request_id', achRequestId).maybeSingle();
    if (wErr) throw Object.assign(new Error(`W-9 document re-read failed: ${wErr.message}`), { code: 'w9_doc_read_failed' });
    if (won) return { duplicate: 'same_request', document: won, replaced_prior: false };
  }
  if (ins.error) throw Object.assign(new Error(`W-9 document insert failed: ${ins.error.message}`), { code: 'w9_doc_write_failed' });
  const doc = ins.data;

  const hadPriorCurrent = priors.some((d) => d.is_current);
  if (hadPriorCurrent) {
    const { error: dErr } = await supabase.from('vendor_documents').update({ is_current: false, superseded_at: new Date().toISOString() })
      .eq('vendor_id', vendorId).eq('doc_type', 'w9').eq('is_current', true).neq('id', doc.id);
    if (dErr) throw Object.assign(new Error(`could not supersede the prior W-9 (new one filed as history, id ${doc.id}): ${dErr.message}`), { code: 'w9_doc_write_failed' });
  }
  const { data: cur, error: pErr } = await supabase.from('vendor_documents').update({ is_current: true }).eq('id', doc.id).select().single();
  if (pErr) throw Object.assign(new Error(`could not make the new W-9 current (id ${doc.id}): ${pErr.message}`), { code: 'w9_doc_write_failed' });
  return { duplicate: null, document: cur, replaced_prior: hadPriorCurrent };
}

module.exports = { fileW9Document };
