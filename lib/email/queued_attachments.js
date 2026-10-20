// ============================================================================
// lib/email/queued_attachments.js  (Ed 2026-10-16)
// ----------------------------------------------------------------------------
// The stored file attachments on a queued email draft (outbound_email_drafts.
// attachments: [{ storage_path, bucket ('documents' by default), name, mime,
// size }]). ONE loader is used both by the Draft Queue preview and by /send, so
// the file a reviewer opens is byte-for-byte the file that goes out. Nothing
// here regenerates a document; it only reads what is stored.
//
// Send is all-or-nothing: if any listed attachment cannot be read, the send is
// refused and the draft stays unsent. (It used to log a warning and send
// without the file, so a reviewed attachment could silently drop.)
// ============================================================================
'use strict';

const crypto = require('crypto');

const DEFAULT_BUCKET = 'documents';
// Files uploaded through the Draft Queue (Replace) live under the draft's own
// folder. Only these are ever deleted from storage: an attachment that points
// at a shared document (an RFP PDF, a violation letter) is only unlinked from
// the draft, never deleted.
const DRAFT_PREFIX = 'email_outbound_attachments/drafts/';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain',
};
// Shown inside the app. Everything else (Word, Excel, HTML, SVG, text) is a
// download only: rendering arbitrary stored markup on our own origin is unsafe.
const INLINE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function list(draft) { return Array.isArray(draft && draft.attachments) ? draft.attachments : []; }

function mimeOf(a) {
  const m = String((a && a.mime) || '').toLowerCase().split(';')[0].trim();
  if (m && m !== 'application/octet-stream') return m;
  const ext = String((a && a.name) || (a && a.storage_path) || '').toLowerCase().split('.').pop();
  return EXT_MIME[ext] || m || 'application/octet-stream';
}
function kindOf(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (/^image\//.test(mime)) return INLINE_MIME.has(mime) ? 'image' : 'file';
  if (/wordprocessingml|msword/.test(mime)) return 'word';
  if (/spreadsheetml|ms-excel|text\/csv/.test(mime)) return 'excel';
  return 'file';
}
function canInline(mime) { return INLINE_MIME.has(mime); }

/** Public description of one attachment. Never includes the storage path or bucket. */
function describe(a, index) {
  const mime = mimeOf(a);
  return { index, name: (a && a.name) || 'attachment', mime, size: (a && Number(a.size)) || null, kind: kindOf(mime), inline: canInline(mime) };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266). */
function contentDisposition(name, inline) {
  const n = String(name || 'attachment').replace(/[\r\n]/g, ' ');
  const ascii = n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(n)}`;
}

/**
 * Read one stored attachment. Returns { ok:true, buffer, sha256, size, mime, name }
 * or { ok:false, reason } (never throws). `reason` is for logs and send_error.
 */
async function load(supabase, a) {
  if (!a || !a.storage_path) return { ok: false, reason: 'no stored file' };
  try {
    const { data: blob, error } = await supabase.storage.from(a.bucket || DEFAULT_BUCKET).download(a.storage_path);
    if (error || !blob) return { ok: false, reason: (error && error.message) || 'file not found in storage' };
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (!buffer.length) return { ok: false, reason: 'stored file is empty' };
    return { ok: true, buffer, sha256: sha256(buffer), size: buffer.length, mime: mimeOf(a), name: a.name || 'attachment' };
  } catch (e) {
    return { ok: false, reason: e.message || 'download failed' };
  }
}

/**
 * Load EVERY listed attachment for send, as Graph fileAttachments.
 * Returns { ok:true, files } or { ok:false, missing:[{ index, name, reason }] }.
 * A listed entry with no storage_path counts as missing: it was listed, so the
 * reviewer expects it to go.
 */
async function loadAllForSend(supabase, attachments) {
  const files = []; const missing = [];
  const arr = Array.isArray(attachments) ? attachments : [];
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (!a) continue;
    const r = await load(supabase, a);
    if (!r.ok) { missing.push({ index: i, name: (a && a.name) || 'attachment', reason: r.reason }); continue; }
    files.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: r.name, contentType: r.mime, contentBytes: r.buffer.toString('base64') });
  }
  return missing.length ? { ok: false, missing } : { ok: true, files };
}

function missingMessage(missing) {
  const names = missing.map((m) => `"${m.name}"`).join(', ');
  return `Not sent. ${missing.length === 1 ? 'This attachment' : 'These attachments'} could not be read from storage: ${names}. Open the attachment in the Draft Queue, then Replace or Remove it before sending.`;
}

/** True only for a file the Draft Queue itself stored for THIS draft. */
function isDraftOwned(draftId, a) {
  return !!(a && a.storage_path && draftId && String(a.storage_path).startsWith(`${DRAFT_PREFIX}${draftId}/`));
}

function safeFileName(name) {
  const base = String(name || 'attachment').split(/[\\/]/).pop().replace(/[^\w.\- ()]+/g, '_').replace(/\s+/g, '_').slice(-120);
  return base || 'attachment';
}
function storagePathFor(draftId, name, now = Date.now()) { return `${DRAFT_PREFIX}${draftId}/${now}_${safeFileName(name)}`; }

module.exports = {
  DEFAULT_BUCKET, DRAFT_PREFIX, MAX_UPLOAD_BYTES, INLINE_MIME,
  list, mimeOf, kindOf, canInline, describe, sha256, contentDisposition,
  load, loadAllForSend, missingMessage, isDraftOwned, safeFileName, storagePathFor,
};
