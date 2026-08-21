// ============================================================================
// lib/email/draft_attachments.js — keep the file an agent generated.
// ----------------------------------------------------------------------------
// Ed 2026-08-21: "ok add that feature" — Paige offering a document she cannot
// hand over.
//
// The generator was never the missing piece. handleNominationRequest already
// builds the call-for-nominations PDF and returns
//
//     attachments: [{ filename, content }]
//
// and graph_ingest stored the draft as { subject, body, careful, status,
// persona, review_hint }. The attachments key is simply not in that list, so
// every PDF Paige has ever generated was built, dropped, and forgotten one line
// later. Her reply then said "attached" about a file that no longer existed —
// which is why the honest wording had to say "I can generate one" instead.
//
// WHY STORAGE AND NOT THE ROW: the draft lives in email_messages.extracted, a
// JSONB column. A base64 PDF is a few hundred KB, and every read of that table
// drags it along — the triage list selects `extracted` for every message on the
// screen. The bytes go to the documents bucket; the row keeps a path.
//
// The send path already knows how to attach a storage path (that is how
// drag-and-dropped files work), so this deliberately produces the SAME
// descriptor shape rather than inventing a second one.
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MAX_BYTES = 15 * 1024 * 1024;   // Graph's practical ceiling for a simple send
const MAX_FILES = 4;

function safeName(name, fallback) {
  return String(name || fallback || 'attachment')
    .replace(/[^\w.\-() ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || (fallback || 'attachment');
}

function mimeFor(filename) {
  const n = String(filename || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (n.endsWith('.csv')) return 'text/csv';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/**
 * Persist files an agent generated so they survive until a human approves the
 * draft. Returns descriptors { storage_path, name, mime, size } — the same
 * shape /attach-upload returns, so the send path needs no special case.
 *
 * Best-effort by design: a storage failure must never lose the draft itself.
 * Anything that fails to upload is dropped from the list, and the caller is
 * expected to word the reply from what actually came back — never from what it
 * hoped to attach.
 */
async function persistDraftAttachments(attachments, { keyPrefix }) {
  const files = (attachments || []).filter((a) => a && a.content && a.content.length).slice(0, MAX_FILES);
  if (!files.length) return [];
  const key = String(keyPrefix || 'unkeyed').replace(/[^\w-]+/g, '_').slice(0, 80);
  const out = [];
  for (const a of files) {
    try {
      const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
      if (buf.length > MAX_BYTES) {
        console.warn('[draft_attachments] too large to attach:', a.filename, buf.length);
        continue;
      }
      const name = safeName(a.filename, 'document.pdf');
      const path = `email_outbound_attachments/generated/${key}/${name}`;
      const mime = a.contentType || mimeFor(name);
      const { error } = await supabase.storage.from('documents')
        .upload(path, buf, { contentType: mime, upsert: true });
      if (error) { console.warn('[draft_attachments] upload failed:', name, error.message); continue; }
      out.push({ storage_path: path, name, mime, size: buf.length, generated: true });
    } catch (e) {
      console.warn('[draft_attachments] persist failed:', e.message);
    }
  }
  return out;
}

/**
 * Turn stored descriptors back into Graph fileAttachment objects at send time.
 * Anything missing from storage is skipped with a warning rather than failing
 * the send: a reply that goes without its attachment is recoverable, a reply
 * that does not go at all is not.
 */
async function loadDraftAttachments(descriptors) {
  const out = [];
  for (const d of (descriptors || []).slice(0, MAX_FILES)) {
    if (!d || !d.storage_path) continue;
    try {
      const { data: blob, error } = await supabase.storage.from('documents').download(d.storage_path);
      if (error || !blob) { console.warn('[draft_attachments] missing at send:', d.storage_path, error && error.message); continue; }
      const buf = Buffer.from(await blob.arrayBuffer());
      if (buf.length > MAX_BYTES) continue;
      out.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: safeName(d.name, 'attachment'),
        contentType: d.mime || mimeFor(d.name),
        contentBytes: buf.toString('base64'),
      });
    } catch (e) {
      console.warn('[draft_attachments] load failed:', e.message);
    }
  }
  return out;
}

module.exports = { persistDraftAttachments, loadDraftAttachments, safeName, mimeFor };
