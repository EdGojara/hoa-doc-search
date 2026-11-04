'use strict';
// ============================================================================
// lib/vendors/rfp_download.js  (Ed 2026-10-20) — downloading an RFP is READ-ONLY
// ----------------------------------------------------------------------------
// GET /download-rfp/:id used to "regenerate structured RFP on the fly if it wasn't
// saved": whenever the stored document lacked the legacy `scopeItems` shape it asked
// the model for a fresh one and UPDATED bid_requests.structured_rfp with it. In
// production that meant one click on Download would overwrite:
//   - the Canyon Gate camera RFP (9857e2cc, schema trusted.rfp.v2, versions 1-3 with
//     their content hashes and audit trail), and
//   - the 2027 Landscape Maintenance RFP (e01a0001, its own structured shape),
// and would write a model-generated document onto any bid request that had none.
// Now a download only ever reads:
//   - a stored legacy document (scopeItems) renders to Word exactly as before;
//   - any other stored document (v2, other structured shapes) is refused with a clear
//     reason; it is printed from the RFP panel, never re-made here;
//   - no stored document is refused; creating one is an explicit action elsewhere.
// No branch writes to the database or storage. Version history and audit records in
// structured_rfp are therefore never touched by a download.
// ============================================================================

const isLegacyRenderable = (s) => !!(s && typeof s === 'object' && Array.isArray(s.scopeItems) && s.scopeItems.length > 0);

// What a download may do with this bid request. Pure: no I/O.
function decideRfpDownload(bidRequest) {
  if (!bidRequest) return { action: 'refuse', status: 404, error: 'not_found', detail: 'Bid request not found.' };
  const s = bidRequest.structured_rfp;
  if (isLegacyRenderable(s)) return { action: 'render', structured: s };
  if (s && typeof s === 'object' && Object.keys(s).length) {
    const kind = s.schema === 'trusted.rfp.v2' ? 'a structured RFP document' : 'an RFP document in a newer format';
    return { action: 'refuse', status: 409, error: 'stored_document_not_downloadable_here',
      detail: `This RFP is stored as ${kind}. Download cannot render it as a Word file, and it never re-creates or changes the stored document. Open it from the RFP panel instead. Nothing was changed.` };
  }
  return { action: 'refuse', status: 409, error: 'no_stored_document',
    detail: 'No RFP document has been saved for this bid request. Download never creates one. Create or save the RFP first. Nothing was changed.' };
}

const safeName = (s, d) => String(s || d).replace(/[^a-z0-9]/gi, '_');

// Express handler. `supabase` is used ONLY to read; `generateDocx` renders a stored document.
function makeRfpDownloadHandler({ supabase, generateDocx, log = console }) {
  return async function rfpDownload(req, res) {
    try {
      const { data: bidRequest, error } = await supabase.from('bid_requests').select('*').eq('id', req.params.bidRequestId).maybeSingle();
      if (error) { log.error('[rfp_download] read failed:', error.message); return res.status(500).json({ error: 'read_failed', detail: 'The RFP could not be read right now. Nothing was changed.' }); }
      const d = decideRfpDownload(bidRequest);
      if (d.action !== 'render') {
        if (d.status === 409) log.warn('[rfp_download] refused (read-only)', JSON.stringify({ id: req.params.bidRequestId, reason: d.error, schema: bidRequest && bidRequest.structured_rfp && bidRequest.structured_rfp.schema || null }));
        return res.status(d.status).json({ error: d.error, detail: d.detail });
      }
      const docBuffer = await generateDocx(d.structured);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(bidRequest.community, 'HOA')}_RFP_${safeName(bidRequest.vendor_type, 'RFP')}.docx"`);
      return res.send(docBuffer);
    } catch (err) {
      log.error('[rfp_download] failed:', err.message);
      return res.status(500).json({ error: 'download_failed', detail: 'The RFP could not be prepared for download. Nothing was changed.' });
    }
  };
}

module.exports = { decideRfpDownload, makeRfpDownloadHandler, isLegacyRenderable };
