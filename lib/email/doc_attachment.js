// ============================================================================
// lib/email/doc_attachment.js  (Ed 2026-07-14)
// ----------------------------------------------------------------------------
// Download any filed library document as a Graph fileAttachment, so staff can
// find a document (application form, policy, letter, contract) and attach it to
// an outgoing reply/compose. Generalizes the ARC-application attach. Best-effort.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const BUCKET = 'documents';

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', txt: 'text/plain',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function getDocAttachment(docId) {
  if (!docId) return null;
  try {
    const { data: doc, error: dErr } = await supabase.from('library_documents')
      .select('title, file_path, file_name_original, category').eq('id', docId).maybeSingle();
    if (dErr) { console.warn('[doc_attachment] lookup failed:', dErr.message); return null; }
    if (!doc || !doc.file_path) return null;
    // A restricted association record (a signed tax return) is never attached to
    // an outgoing email from this generic path. (Ed 2026-10-19.)
    if (require('../documents/restricted').isRestricted(doc)) { console.warn('[doc_attachment] refused a restricted document', JSON.stringify({ docId, category: doc.category })); return null; }
    const { data: file, error } = await supabase.storage.from(BUCKET).download(doc.file_path);
    if (error || !file) return null;
    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return null; // 12MB cap
    const ext = String(doc.file_name_original || doc.file_path || '').split('.').pop().toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    const name = doc.file_name_original
      || (String(doc.title || 'document').replace(/[^\w .\-]/g, '').slice(0, 80).trim() + '.' + (ext || 'pdf'));
    return { name, category: doc.category || null, attachment: { '@odata.type': '#microsoft.graph.fileAttachment', name, contentType: ct, contentBytes: buf.toString('base64') } };
  } catch (_) { return null; }
}

module.exports = { getDocAttachment };
